<?php

declare(strict_types=1);

use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTelemetry;
use LogBrew\RecordingTransport;
use LogBrew\TelemetryContext;
use LogBrew\Symfony\LogBrewBundle;
use LogBrew\Symfony\SymfonyRequestSubscriber;
use LogBrew\Symfony\SymfonyStatusCommand;
use LogBrew\Symfony\SymfonyTelemetry;
use LogBrew\TransportError;
use Monolog\Handler\NoopHandler;
use Monolog\Logger;
use Symfony\Bundle\MonologBundle\DependencyInjection\MonologExtension;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\DependencyInjection\Reference;
use Symfony\Component\Console\Tester\CommandTester;
use Symfony\Component\DependencyInjection\Extension\PrependExtensionInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\ExceptionEvent;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\HttpKernelInterface;
use Symfony\Component\HttpKernel\KernelEvents;

final class SymfonyTestKernel implements HttpKernelInterface
{
    public function handle(Request $request, int $type = self::MAIN_REQUEST, bool $catch = true): Response
    {
        return new Response('', 200);
    }
}

final class SymfonyTestContextProvider
{
    public function __invoke(Request $request): ?TelemetryContext
    {
        if ($request->attributes->getBoolean('with_test_context')) {
            return TelemetryContext::create()->withSession('fixture_session')->build();
        }
        return null;
    }
}

/**
 * @param callable(Request): ?TelemetryContext|null $contextProvider
 * @param callable(Throwable): void|null $onError
 */
function symfonyTestTelemetry(
    RecordingTransport $transport,
    ?callable $contextProvider = null,
    ?callable $onError = null
): SymfonyTelemetry
{
    $sequence = 0;
    return new SymfonyTelemetry(
        apiKey: 'LOGBREW_SERVER_API_KEY',
        service: 'symfony-demo',
        release: '1.2.3',
        environment: 'test',
        transport: $transport,
        timestampProvider: static fn (): DateTimeImmutable => new DateTimeImmutable('2026-08-01T14:00:00+00:00'),
        eventIdProvider: static function (string $kind, int $unusedSequence) use (&$sequence): string {
            return "symfony_{$kind}_" . ++$sequence;
        },
        onError: $onError,
        contextProvider: $contextProvider
    );
}

$disabledTelemetry = new SymfonyTelemetry(
    enabled: true,
    apiKey: '',
    service: 'symfony-demo',
    release: '1.0.0',
    environment: 'test'
);
assertTrue(!$disabledTelemetry->active(), 'expected missing Symfony key to disable capture safely');
assertTrue($disabledTelemetry->status()['reason'] === 'missing_api_key', 'expected actionable missing-key status');
assertTrue($disabledTelemetry->monologHandler() instanceof NoopHandler, 'expected missing-key Symfony no-op handler');
$disabledCommand = new CommandTester(new SymfonyStatusCommand($disabledTelemetry));
assertTrue($disabledCommand->execute(['--json' => true]) === 2, 'expected missing-key Symfony status exit');
$disabledStatus = testStringMap(json_decode(trim($disabledCommand->getDisplay()), true, 512, JSON_THROW_ON_ERROR), 'Symfony disabled status');
assertTrue($disabledStatus['reason'] === 'missing_api_key', 'expected machine-readable missing-key status');

$transport = RecordingTransport::alwaysAccept();
$telemetry = symfonyTestTelemetry($transport);
assertTrue($telemetry->active(), 'expected configured Symfony telemetry to be active');
$logger = new Logger('app', [$telemetry->monologHandler()]);
$logger->info('below threshold');
assertTrue(count($transport->sentBodies) === 0, 'expected Symfony warning threshold by default');
$logger->warning('Order {order} failed.', ['order' => 'ord_123']);
assertTrue(count($transport->sentBodies) === 1, 'expected immediate Symfony log delivery');
$logPayload = testTransportPayload($transport, 'Symfony log payload');
$logEvent = testEvents($logPayload, 'Symfony log events')[0];
assertTrue($logEvent['type'] === 'log', 'expected Symfony Monolog event');
$logMetadata = testMetadata($logEvent, 'Symfony log metadata');
assertTrue($logMetadata['framework'] === 'symfony', 'expected Symfony framework metadata');
assertTrue($logMetadata['service'] === 'symfony-demo', 'expected Symfony service metadata');
$logContext = testContext($logEvent, 'Symfony log context');
assertTrue(testValueAt($logContext, ['resource', 'service', 'name']) === 'symfony-demo', 'expected typed Symfony service context');
assertTrue(testValueAt($logContext, ['resource', 'deployment', 'release']) === '1.2.3', 'expected typed Symfony release context');
assertTrue(testValueAt($logContext, ['resource', 'deployment', 'environment']) === 'test', 'expected typed Symfony environment context');
assertTrue(testValueAt($logContext, ['resource', 'framework', 'name']) === 'symfony', 'expected typed Symfony framework context');
assertTrue(testValueAt($logContext, ['resource', 'runtime', 'name']) === 'php', 'expected Symfony PHP runtime context');
$logSdk = $logPayload['sdk'] ?? null;
if (!is_array($logSdk)) {
    throw new RuntimeException('expected Symfony SDK identity');
}
assertTrue(($logSdk['name'] ?? null) === 'logbrew-php-symfony', 'expected Symfony SDK integration identity');
assertTrue(!str_contains(json_encode($logPayload, JSON_THROW_ON_ERROR), 'LOGBREW_SERVER_API_KEY'), 'expected Symfony key to stay out of payload');

$exceptionLogger = new Logger('app', [$telemetry->monologHandler()]);
$exceptionLogger->error('Safe exception record', ['exception' => new RuntimeException('sensitive monolog exception')]);
$exceptionLogPayload = testTransportPayload($transport, 'Symfony exception log payload');
$encodedExceptionLog = json_encode($exceptionLogPayload, JSON_THROW_ON_ERROR);
assertTrue(str_contains($encodedExceptionLog, RuntimeException::class), 'expected Symfony Monolog exception type');
assertTrue(!str_contains($encodedExceptionLog, 'sensitive monolog exception'), 'expected Symfony Monolog exception message exclusion');

$testTransport = RecordingTransport::alwaysAccept();
$testTelemetry = symfonyTestTelemetry($testTransport);
$statusCommand = new CommandTester(new SymfonyStatusCommand($testTelemetry));
assertTrue($statusCommand->execute(['--send-probe' => true, '--json' => true]) === 0, 'expected Symfony delivery-probe success');
$statusPayload = testStringMap(json_decode(trim($statusCommand->getDisplay()), true, 512, JSON_THROW_ON_ERROR), 'Symfony probe status');
assertTrue($statusPayload['delivery'] === 'accepted', 'expected Symfony accepted delivery status');
assertTrue($statusPayload['statusCode'] === 202, 'expected Symfony delivery response code');
assertTrue(count($testTransport->sentBodies) === 1, 'expected one Symfony delivery-probe request');

$requestTransport = RecordingTransport::alwaysAccept();
$providerSawRequest = false;
$requestTelemetry = symfonyTestTelemetry(
    $requestTransport,
    static function (Request $request) use (&$providerSawRequest): TelemetryContext {
        $providerSawRequest = $request->attributes->get('_route') === 'blog_index';
        return TelemetryContext::create()
            ->withSession('session_symfony')
            ->withSubject('subject_symfony', 'user')
            ->withTag('journey', 'content')
            ->build();
    }
);
$subscriber = new SymfonyRequestSubscriber($requestTelemetry);
$kernel = new SymfonyTestKernel();
$request = Request::create('/en/blog/posts/concrete-path-marker?query_key=query-value-marker', 'GET');
$request->attributes->set('_route', 'blog_index');
$request->headers->set('traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
$subscriber->onKernelRequest(new RequestEvent($kernel, $request, HttpKernelInterface::MAIN_REQUEST));
assertTrue(LogBrewTrace::current()?->traceId === '4bf92f3577b34da6a3ce929d0e0e4736', 'expected Symfony trace continuation');
assertTrue($providerSawRequest, 'expected explicit Symfony context provider to receive the request');
assertTrue(LogBrewTelemetry::currentContext() !== null, 'expected Symfony request context activation');
$subscriber->onKernelResponse(new ResponseEvent($kernel, $request, HttpKernelInterface::MAIN_REQUEST, new Response('', 200)));
assertTrue(LogBrewTrace::current() === null, 'expected Symfony request trace scope reset');
assertTrue(LogBrewTelemetry::currentContext() === null, 'expected Symfony request context scope reset');
assertTrue(count($requestTransport->sentBodies) === 1, 'expected one Symfony request delivery');
$requestPayload = testTransportPayload($requestTransport, 'Symfony request payload');
assertTrue(count(testEvents($requestPayload, 'Symfony request events')) === 1, 'expected one successful Symfony request span');
$span = testEvents($requestPayload, 'Symfony request events')[0];
assertTrue($span['type'] === 'span', 'expected Symfony request span');
assertTrue((testAttributes($span, 'Symfony request span')['name'] ?? null) === 'GET symfony.route.blog_index', 'expected stable Symfony route name');
$spanContext = testContext($span, 'Symfony span context');
assertTrue(testValueAt($spanContext, ['trace', 'traceId']) === '4bf92f3577b34da6a3ce929d0e0e4736', 'expected typed Symfony trace context');
assertTrue(testValueAt($spanContext, ['session', 'id']) === 'session_symfony', 'expected provider session on Symfony span');
assertTrue(testValueAt($spanContext, ['subject', 'id']) === 'subject_symfony', 'expected provider subject on Symfony span');
assertTrue(testValueAt($spanContext, ['tags', 'journey']) === 'content', 'expected provider tag on Symfony span');
$encodedRequest = json_encode($requestPayload, JSON_THROW_ON_ERROR);
assertTrue(!str_contains($encodedRequest, 'concrete-path-marker'), 'expected concrete Symfony path exclusion');
assertTrue(!str_contains($encodedRequest, 'query-value-marker'), 'expected Symfony query value exclusion');
assertTrue(!str_contains($encodedRequest, '00-4bf92'), 'expected raw traceparent exclusion');

$providerErrors = [];
$providerFailureTransport = RecordingTransport::alwaysAccept();
$providerFailureTelemetry = symfonyTestTelemetry(
    $providerFailureTransport,
    static function (Request $request): ?TelemetryContext {
        throw new RuntimeException('context provider fixture failed');
    },
    static function (Throwable $error) use (&$providerErrors): void {
        $providerErrors[] = $error->getMessage();
    }
);
$providerFailureSubscriber = new SymfonyRequestSubscriber($providerFailureTelemetry);
$providerFailureRequest = Request::create('/safe/provider-failure', 'GET');
$providerFailureRequest->attributes->set('_route', 'provider_failure');
$providerFailureSubscriber->onKernelRequest(new RequestEvent(
    $kernel,
    $providerFailureRequest,
    HttpKernelInterface::MAIN_REQUEST
));
$providerFailureSubscriber->onKernelResponse(new ResponseEvent(
    $kernel,
    $providerFailureRequest,
    HttpKernelInterface::MAIN_REQUEST,
    new Response('', 200)
));
assertTrue(count($providerErrors) === 1, 'expected isolated Symfony context provider failure');
assertTrue(count($providerFailureTransport->sentBodies) === 1, 'expected request telemetry after provider failure');
assertTrue(LogBrewTelemetry::currentContext() === null, 'expected no leaked context after provider failure');

$exceptionTransport = RecordingTransport::alwaysAccept();
$exceptionTelemetry = symfonyTestTelemetry($exceptionTransport);
$exceptionSubscriber = new SymfonyRequestSubscriber($exceptionTelemetry);
$exceptionRequest = Request::create('/admin/accounts/concrete-account?authorization=fixture-value', 'POST');
$exceptionRequest->attributes->set('_route', 'admin_user_delete');
$exceptionSubscriber->onKernelRequest(new RequestEvent($kernel, $exceptionRequest, HttpKernelInterface::MAIN_REQUEST));
$exceptionSubscriber->onKernelException(new ExceptionEvent(
    $kernel,
    $exceptionRequest,
    HttpKernelInterface::MAIN_REQUEST,
    new RuntimeException('sensitive database message')
));
$exceptionSubscriber->onKernelResponse(new ResponseEvent(
    $kernel,
    $exceptionRequest,
    HttpKernelInterface::MAIN_REQUEST,
    new Response('', 500)
));
assertTrue(count($exceptionTransport->sentBodies) === 1, 'expected one batched Symfony failure delivery');
$exceptionPayload = testTransportPayload($exceptionTransport, 'Symfony exception payload');
assertTrue(count(testEvents($exceptionPayload, 'Symfony exception events')) === 2, 'expected Symfony issue and request span');
$exceptionEvents = testEvents($exceptionPayload, 'Symfony exception events');
assertTrue($exceptionEvents[0]['type'] === 'issue', 'expected Symfony exception issue');
assertTrue($exceptionEvents[1]['type'] === 'span', 'expected failed Symfony request span');
assertTrue(
    (testAttributes($exceptionEvents[0], 'Symfony issue attributes')['title'] ?? null) === RuntimeException::class,
    'expected useful Symfony exception title'
);
$issueAttributes = testAttributes($exceptionEvents[0], 'Symfony issue attributes');
assertTrue(testValueAt($issueAttributes, ['exception']) === [
    'type' => RuntimeException::class,
    'mechanism' => ['type' => 'symfony.kernel_exception', 'handled' => false],
], 'expected first-class Symfony exception mechanism');
$issueStackFrames = testValueAt($issueAttributes, ['stackFrames']);
assertTrue(
    is_array($issueStackFrames)
        && count($issueStackFrames) >= 1
        && count($issueStackFrames) <= 32,
    'expected bounded first-class Symfony stack frames'
);
$issueStackFrameLine = testValueAt($issueAttributes, ['stackFrames', 0, 'line']);
assertTrue(
    testValueAt($issueAttributes, ['stackFrames', 0, 'filename']) === basename(__FILE__)
        && is_int($issueStackFrameLine)
        && $issueStackFrameLine > 0
        && testValueAt($issueAttributes, ['stackFrames', 0, 'column']) === 1,
    'expected newest-first basename-only Symfony throw frame'
);
$issueMetadata = testMetadata($exceptionEvents[0], 'Symfony issue metadata');
assertTrue($issueMetadata['exceptionType'] === RuntimeException::class, 'expected Symfony exception type');
assertTrue($issueMetadata['errorName'] === RuntimeException::class, 'expected backend-native Symfony exception type');
$issueGroupingKey = $issueMetadata['issueGroupingKey'] ?? null;
assertTrue(
    is_string($issueGroupingKey)
        && preg_match('/^symfony-exception-[0-9a-f]{64}$/', $issueGroupingKey) === 1,
    'expected privacy-safe Symfony issue grouping key'
);
assertTrue(
    $issueMetadata['issueGroupingSource'] === 'exception_type_route_file',
    'expected explicit Symfony grouping source'
);
assertTrue(
    $issueMetadata['errorFrameFile'] === basename(__FILE__),
    'expected basename-only Symfony exception frame'
);
assertTrue(
    is_int($issueMetadata['errorFrameLine']) && $issueMetadata['errorFrameLine'] > 0,
    'expected positive Symfony exception frame line'
);
assertTrue($issueMetadata['handled'] === false, 'expected unhandled Symfony mechanism state');
assertTrue($issueMetadata['mechanism'] === 'symfony.kernel_exception', 'expected Symfony mechanism');
$encodedException = json_encode($exceptionPayload, JSON_THROW_ON_ERROR);
assertTrue(!str_contains($encodedException, 'sensitive database message'), 'expected exception message exclusion by default');
assertTrue(!str_contains($encodedException, 'concrete-account'), 'expected concrete Symfony path exclusion on failure');
assertTrue(!str_contains($encodedException, 'authorization'), 'expected Symfony query key exclusion on failure');
assertTrue(!str_contains($encodedException, dirname(__DIR__)), 'expected absolute Symfony source path exclusion');

$isolatedErrors = [];
$failingTransport = new RecordingTransport([
    TransportError::network('sensitive transport failure'),
    202,
]);
$failingTelemetry = symfonyTestTelemetry(
    $failingTransport,
    onError: static function (Throwable $error) use (&$isolatedErrors): void {
        $isolatedErrors[] = $error;
    }
);
$failingSubscriber = new SymfonyRequestSubscriber($failingTelemetry);
$firstFailingRequest = Request::create('/concrete/first?query_key=query-value-marker', 'GET');
$firstFailingRequest->attributes->set('_route', 'failure_probe');
$failingSubscriber->onKernelRequest(new RequestEvent($kernel, $firstFailingRequest, HttpKernelInterface::MAIN_REQUEST));
$failingSubscriber->onKernelResponse(new ResponseEvent(
    $kernel,
    $firstFailingRequest,
    HttpKernelInterface::MAIN_REQUEST,
    new Response('', 200)
));
assertTrue(LogBrewTrace::current() === null, 'expected Symfony trace scope reset after transport failure');
assertTrue(count($isolatedErrors) === 1, 'expected isolated Symfony transport failure callback');

$secondFailingRequest = Request::create('/concrete/second?query_key=query-value-marker', 'GET');
$secondFailingRequest->attributes->set('_route', 'failure_probe');
$failingSubscriber->onKernelRequest(new RequestEvent($kernel, $secondFailingRequest, HttpKernelInterface::MAIN_REQUEST));
$failingSubscriber->onKernelResponse(new ResponseEvent(
    $kernel,
    $secondFailingRequest,
    HttpKernelInterface::MAIN_REQUEST,
    new Response('', 200)
));
assertTrue(count($failingTransport->sentBodies) === 3, 'expected failed Symfony batch retry before new request span');
assertTrue($failingTransport->sentBodies[0] === $failingTransport->sentBodies[1], 'expected byte-identical Symfony retry');
assertTrue(!str_contains(implode('', $failingTransport->sentBodies), '/concrete/'), 'expected Symfony failure retry path exclusion');

$container = new ContainerBuilder();
$container->setParameter('kernel.environment', 'test');
$container->setParameter('kernel.bundles', ['MonologBundle' => 'Symfony\\Bundle\\MonologBundle\\MonologBundle']);
$container->registerExtension(new MonologExtension());
$bundle = new LogBrewBundle();
$extension = $bundle->getContainerExtension();
if (!$extension instanceof PrependExtensionInterface) {
    throw new RuntimeException('expected Symfony prepend extension');
}
$extension->prepend($container);
$monologConfig = $container->getExtensionConfig('monolog');
$firstMonologConfig = $monologConfig[0] ?? null;
if (!is_array($firstMonologConfig)) {
    throw new RuntimeException('expected Symfony Monolog config');
}
$monologHandlers = $firstMonologConfig['handlers'] ?? null;
if (!is_array($monologHandlers)) {
    throw new RuntimeException('expected Symfony Monolog handlers');
}
$logBrewHandler = $monologHandlers['logbrew'] ?? null;
if (!is_array($logBrewHandler)) {
    throw new RuntimeException('expected Symfony LogBrew handler config');
}
assertTrue(($logBrewHandler['type'] ?? null) === 'service', 'expected automatic Symfony Monolog handler');
assertTrue(($logBrewHandler['id'] ?? null) === 'logbrew.symfony.monolog_handler', 'expected SDK-owned Symfony handler service');
$logBrewChannels = $logBrewHandler['channels'] ?? null;
if (!is_array($logBrewChannels)) {
    throw new RuntimeException('expected Symfony channel exclusions');
}
assertTrue(in_array('!request', $logBrewChannels, true), 'expected Symfony formatted exception-log exclusion');
$container->register('logbrew.test_context_provider', SymfonyTestContextProvider::class);
$extension->load([['context_provider' => 'logbrew.test_context_provider']], $container);
assertTrue($container->hasDefinition('logbrew.symfony.telemetry'), 'expected Symfony telemetry service');
assertTrue($container->hasDefinition('logbrew.symfony.messenger'), 'expected Symfony Messenger telemetry service');
assertTrue($container->getDefinition('logbrew.symfony.messenger')->hasTag('kernel.event_subscriber'), 'expected Messenger failure subscriber');
assertTrue($container->hasDefinition('logbrew.symfony.request_subscriber'), 'expected Symfony request subscriber');
assertTrue($container->hasDefinition('logbrew.symfony.status_command'), 'expected Symfony status command');
$telemetryArguments = $container->getDefinition('logbrew.symfony.telemetry')->getArguments();
$contextProviderReference = $telemetryArguments[18] ?? null;
assertTrue(
    $contextProviderReference instanceof Reference
        && (string) $contextProviderReference === 'logbrew.test_context_provider',
    'expected configured Symfony context provider service reference'
);

$events = SymfonyRequestSubscriber::getSubscribedEvents();
assertTrue(isset($events[KernelEvents::REQUEST], $events[KernelEvents::EXCEPTION], $events[KernelEvents::RESPONSE]), 'expected Symfony request lifecycle subscriptions');

fwrite(STDOUT, "php Symfony integration checks passed\n");
