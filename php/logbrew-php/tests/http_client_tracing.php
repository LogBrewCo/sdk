<?php

declare(strict_types=1);

use GuzzleHttp\Promise\CancellationException;
use GuzzleHttp\Promise\Create;
use GuzzleHttp\Promise\Promise;
use GuzzleHttp\Promise\PromiseInterface;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;
use LogBrew\LogBrewClient;
use LogBrew\LogBrewHttpClientTracing;
use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTraceContext;
use LogBrew\RecordingTransport;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

require_once __DIR__ . '/../vendor/autoload.php';

final class HttpTracingTestClient implements ClientInterface
{
    /** @param Closure(RequestInterface): ResponseInterface $send */
    public function __construct(private readonly Closure $send)
    {
    }

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        return ($this->send)($request);
    }
}

function httpTracingClient(): LogBrewClient
{
    return LogBrewClient::create('lb_test_http_tracing', 'logbrew-php', '0.1.0');
}

/** @return list<array<string, mixed>> */
function httpTracingEvents(LogBrewClient $client): array
{
    return testEvents(
        testStringMap(json_decode($client->previewJson(), true, 512, JSON_THROW_ON_ERROR), 'HTTP tracing payload'),
        'HTTP tracing events'
    );
}

/**
 * @param array<string, mixed> $attributes
 * @return array<string, mixed>
 */
function httpTracingMetadata(array $attributes): array
{
    return testStringMap($attributes['metadata'] ?? null, 'HTTP tracing metadata');
}

function httpTracingParent(string $spanId): LogBrewTraceContext
{
    return LogBrewTraceContext::fromTraceparent(
        '00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01',
        $spanId
    );
}

function httpTracingCancellablePromise(CancellationException $cancellation): Promise
{
    $holder = new stdClass();
    $source = new Promise(
        null,
        static function () use ($holder, $cancellation): void {
            $promise = $holder->promise ?? null;
            if ($promise instanceof Promise) {
                $promise->reject($cancellation);
            }
        }
    );
    $holder->promise = $source;
    return $source;
}

/** @return array<string, Closure(): void> */
function httpTracingTests(): array
{
    return [
        'HTTP integrations remain optional Composer dependencies' => static function (): void {
            $manifest = json_decode(
                (string) file_get_contents(__DIR__ . '/../composer.json'),
                true,
                512,
                JSON_THROW_ON_ERROR
            );
            if (!is_array($manifest)) {
                throw new RuntimeException('expected Composer manifest');
            }
            $requires = $manifest['require'] ?? null;
            $devRequires = $manifest['require-dev'] ?? null;
            $suggests = $manifest['suggest'] ?? null;
            if (!is_array($requires) || !is_array($devRequires) || !is_array($suggests)) {
                throw new RuntimeException('expected Composer dependency sections');
            }
            foreach (['guzzlehttp/promises', 'psr/http-client', 'psr/http-message'] as $optional) {
                assertTrue(!array_key_exists($optional, $requires), 'expected optional HTTP dependency outside require');
            }
            assertTrue(array_key_exists('guzzlehttp/guzzle', $devRequires), 'expected Guzzle test dependency');
            foreach (['guzzlehttp/guzzle', 'psr/http-client', 'psr/http-message'] as $suggested) {
                assertTrue(array_key_exists($suggested, $suggests), 'expected optional HTTP dependency suggestion');
            }
        },

        'PSR-18 propagates one child and reinstates its parent without sensitive capture' => static function (): void {
            $client = httpTracingClient();
            $parent = httpTracingParent('2222222222222222');
            $sentRequest = null;
            $activeDuringSend = null;
            $response = new Response(204);
            $delegate = new HttpTracingTestClient(static function (RequestInterface $request) use (&$sentRequest, &$activeDuringSend, $response): ResponseInterface {
                $sentRequest = $request;
                $activeDuringSend = LogBrewTrace::current();
                return $response;
            });
            $traced = LogBrewHttpClientTracing::wrapPsr18($delegate, $client);
            $request = new Request(
                'post',
                'https://EXAMPLE.com/private/path?auth=do-not-record#fragment',
                [
                    'traceparent' => '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00',
                    'authorization' => 'Bearer do-not-record',
                    'baggage' => 'tenant=do-not-record',
                    'tracestate' => 'vendor=do-not-record',
                ],
                'body-do-not-record'
            );

            $scope = LogBrewTrace::activate($parent);
            try {
                $result = $traced->sendRequest($request);
                assertTrue(LogBrewTrace::current() === $parent, 'expected PSR-18 parent restoration');
            } finally {
                $scope->close();
            }

            assertTrue($result === $response, 'expected exact PSR-18 response identity');
            if (!$sentRequest instanceof RequestInterface || !$activeDuringSend instanceof LogBrewTraceContext) {
                throw new RuntimeException('expected traced PSR-18 delegate call');
            }
            assertTrue($activeDuringSend->parentSpanId === $parent->spanId, 'expected outbound child parent');
            assertTrue($sentRequest->getHeaderLine('traceparent') === $activeDuringSend->traceparent(), 'expected exact child traceparent');
            assertTrue($request->getHeaderLine('traceparent') !== $sentRequest->getHeaderLine('traceparent'), 'expected immutable traceparent replacement');

            $events = httpTracingEvents($client);
            assertTrue(count($events) === 1, 'expected one PSR-18 span');
            $attributes = testAttributes($events[0]);
            $metadata = httpTracingMetadata($attributes);
            assertTrue(($attributes['traceId'] ?? null) === $parent->traceId, 'expected matching trace id');
            assertTrue(($attributes['parentSpanId'] ?? null) === $parent->spanId, 'expected matching parent span id');
            assertTrue(($attributes['status'] ?? null) === 'ok', 'expected successful PSR-18 span');
            assertTrue(
                $metadata === [
                    'method' => 'POST',
                    'host' => 'example.com',
                    'statusCode' => 204,
                    'source' => 'psr18',
                    'sampled' => true,
                ],
                'expected fixed PSR-18 metadata'
            );
            $preview = $client->previewJson();
            foreach (['/private/path', 'auth=do-not-record', 'fragment', 'Bearer do-not-record', 'body-do-not-record', 'tenant=do-not-record', 'vendor=do-not-record'] as $sensitive) {
                assertTrue(!str_contains($preview, $sensitive), 'expected sensitive outbound data omission');
            }
        },

        'PSR-18 leaves the request untouched when no parent is active' => static function (): void {
            assertTrue(LogBrewTrace::current() === null, 'expected no active trace before pass-through test');
            $client = httpTracingClient();
            $captureErrors = 0;
            $active = null;
            $sent = null;
            $request = new Request(
                'GET',
                'https://example.com/account',
                ['traceparent' => '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00']
            );
            $delegate = new HttpTracingTestClient(static function (RequestInterface $request) use (&$active, &$sent): ResponseInterface {
                $active = LogBrewTrace::current();
                $sent = $request;
                return new Response(200);
            });

            LogBrewHttpClientTracing::wrapPsr18(
                $delegate,
                $client,
                static function () use (&$captureErrors): void {
                    $captureErrors++;
                }
            )->sendRequest($request);

            assertTrue($sent === $request, 'expected exact PSR-18 request pass-through');
            assertTrue($active === null && LogBrewTrace::current() === null, 'expected no PSR-18 trace activation');
            assertTrue(count(httpTracingEvents($client)) === 0, 'expected no PSR-18 span without parent');
            assertTrue($captureErrors === 0, 'expected no PSR-18 capture callback without parent');
        },

        'Guzzle leaves the request untouched when no parent is active' => static function (): void {
            assertTrue(LogBrewTrace::current() === null, 'expected no active trace before Guzzle pass-through test');
            $client = httpTracingClient();
            $captureErrors = 0;
            $active = null;
            $sent = null;
            $request = new Request(
                'GET',
                'https://example.com/account',
                ['traceparent' => '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00']
            );
            $handler = static function (RequestInterface $request) use (&$active, &$sent): PromiseInterface {
                $active = LogBrewTrace::current();
                $sent = $request;
                return Create::promiseFor(new Response(200));
            };
            $middleware = LogBrewHttpClientTracing::guzzleMiddleware(
                $client,
                static function () use (&$captureErrors): void {
                    $captureErrors++;
                }
            );

            $middleware($handler)($request, [])->wait();

            assertTrue($sent === $request, 'expected exact Guzzle request pass-through');
            assertTrue($active === null && LogBrewTrace::current() === null, 'expected no Guzzle trace activation');
            assertTrue(count(httpTracingEvents($client)) === 0, 'expected no Guzzle span without parent');
            assertTrue($captureErrors === 0, 'expected no Guzzle capture callback without parent');
        },

        'PSR-18 preserves the exact application exception and records only its type' => static function (): void {
            $client = httpTracingClient();
            $failure = new RuntimeException('network detail must stay private');
            $delegate = new HttpTracingTestClient(static function () use ($failure): ResponseInterface {
                throw $failure;
            });

            $caught = null;
            $parent = httpTracingParent('7777777777777777');
            $scope = LogBrewTrace::activate($parent);
            try {
                try {
                    LogBrewHttpClientTracing::wrapPsr18($delegate, $client)->sendRequest(
                        new Request('DELETE', 'https://errors.example/account?session=value')
                    );
                } catch (Throwable $error) {
                    $caught = $error;
                }
            } finally {
                $scope->close();
            }

            assertTrue($caught === $failure, 'expected exact PSR-18 exception identity');
            $events = httpTracingEvents($client);
            $attributes = testAttributes($events[0]);
            $metadata = httpTracingMetadata($attributes);
            assertTrue(($attributes['status'] ?? null) === 'error', 'expected PSR-18 error status');
            assertTrue(($metadata['exceptionType'] ?? null) === RuntimeException::class, 'expected exception type');
            assertTrue(!array_key_exists('statusCode', $metadata), 'expected no response status on transport failure');
            assertTrue(!str_contains($client->previewJson(), $failure->getMessage()), 'expected exception message omission');
            assertTrue(!str_contains($client->previewJson(), '/private'), 'expected failed URL omission');
        },

        'PSR-18 wrapping is idempotent' => static function (): void {
            $client = httpTracingClient();
            $delegate = new HttpTracingTestClient(static fn (): ResponseInterface => new Response(202));
            $first = LogBrewHttpClientTracing::wrapPsr18($delegate, $client);
            $second = LogBrewHttpClientTracing::wrapPsr18($first, $client);
            assertTrue($first === $second, 'expected duplicate PSR-18 wrapping prevention');
            $scope = LogBrewTrace::activate(httpTracingParent('8888888888888888'));
            try {
                $second->sendRequest(new Request('GET', 'https://example.com'));
            } finally {
                $scope->close();
            }
            assertTrue(count(httpTracingEvents($client)) === 1, 'expected one span after duplicate PSR-18 wrapping');
        },

        'capture failures remain advisory for PSR-18 results and callbacks' => static function (): void {
            $client = httpTracingClient();
            $client->shutdown(RecordingTransport::alwaysAccept());
            $captureErrors = 0;
            $response = new Response(200);
            $delegate = new HttpTracingTestClient(static fn (): ResponseInterface => $response);
            $traced = LogBrewHttpClientTracing::wrapPsr18(
                $delegate,
                $client,
                static function () use (&$captureErrors): void {
                    $captureErrors++;
                    throw new RuntimeException('callback detail must stay advisory');
                }
            );

            $scope = LogBrewTrace::activate(httpTracingParent('9999999999999999'));
            try {
                assertTrue($traced->sendRequest(new Request('GET', 'https://example.com')) === $response, 'expected result despite capture failure');
            } finally {
                $scope->close();
            }
            assertTrue($captureErrors === 1, 'expected one advisory capture callback');
        },

        'capture callbacks observe the reinstated parent after synchronous failure' => static function (): void {
            $client = httpTracingClient();
            $client->shutdown(RecordingTransport::alwaysAccept());
            $parent = httpTracingParent('6666666666666666');
            $failure = new RuntimeException('application failure');
            $callbackTrace = null;
            $delegate = new HttpTracingTestClient(static function () use ($failure): ResponseInterface {
                throw $failure;
            });
            $traced = LogBrewHttpClientTracing::wrapPsr18(
                $delegate,
                $client,
                static function () use (&$callbackTrace): void {
                    $callbackTrace = LogBrewTrace::current();
                }
            );

            $scope = LogBrewTrace::activate($parent);
            try {
                try {
                    $traced->sendRequest(new Request('GET', 'https://example.com'));
                } catch (Throwable $error) {
                    assertTrue($error === $failure, 'expected original synchronous failure');
                }
                assertTrue(LogBrewTrace::current() === $parent, 'expected parent after synchronous failure');
            } finally {
                $scope->close();
            }

            assertTrue($callbackTrace === $parent, 'expected advisory callback under reinstated parent');
        },

        'Guzzle fulfillment preserves response identity and reinstates the parent before settlement' => static function (): void {
            $client = httpTracingClient();
            $parent = httpTracingParent('3333333333333333');
            $activeDuringSend = null;
            $sentRequest = null;
            $response = new Response(201);
            $handler = static function (RequestInterface $request) use (&$activeDuringSend, &$sentRequest, $response): PromiseInterface {
                $activeDuringSend = LogBrewTrace::current();
                $sentRequest = $request;
                return Create::promiseFor($response);
            };
            $middleware = LogBrewHttpClientTracing::guzzleMiddleware($client);
            $traced = $middleware($handler);

            $scope = LogBrewTrace::activate($parent);
            try {
                $promise = $traced(new Request('PATCH', 'https://Async.Example/private?auth=value'), []);
                assertTrue(LogBrewTrace::current() === $parent, 'expected Guzzle parent restoration after handler');
            } finally {
                $scope->close();
            }
            $result = $promise->wait();

            assertTrue($result === $response, 'expected exact Guzzle response identity');
            if (!$activeDuringSend instanceof LogBrewTraceContext || !$sentRequest instanceof RequestInterface) {
                throw new RuntimeException('expected traced Guzzle delegate call');
            }
            assertTrue($activeDuringSend->parentSpanId === $parent->spanId, 'expected Guzzle parent link');
            assertTrue($sentRequest->getHeaderLine('traceparent') === $activeDuringSend->traceparent(), 'expected Guzzle traceparent');
            $events = httpTracingEvents($client);
            assertTrue(count($events) === 1, 'expected one Guzzle fulfillment span');
            $metadata = httpTracingMetadata(testAttributes($events[0]));
            assertTrue(($metadata['source'] ?? null) === 'guzzle', 'expected Guzzle source');
            assertTrue(($metadata['statusCode'] ?? null) === 201, 'expected Guzzle status');
            assertTrue(!str_contains($client->previewJson(), '/private'), 'expected Guzzle URL omission');
        },

        'Guzzle rejection preserves the exact reason and completes once' => static function (): void {
            $client = httpTracingClient();
            $failure = new RuntimeException('async detail must stay private');
            $handler = static fn (): PromiseInterface => Create::rejectionFor($failure);
            $middleware = LogBrewHttpClientTracing::guzzleMiddleware($client);
            $traced = $middleware($handler);
            $scope = LogBrewTrace::activate(httpTracingParent('aaaaaaaaaaaaaaaa'));
            try {
                $promise = $traced(
                    new Request('GET', 'https://example.com/error'),
                    []
                );
            } finally {
                $scope->close();
            }

            $caught = null;
            try {
                $promise->wait();
            } catch (Throwable $error) {
                $caught = $error;
            }

            assertTrue($caught === $failure, 'expected exact Guzzle rejection identity');
            assertTrue(count(httpTracingEvents($client)) === 1, 'expected one rejected Guzzle span');
            assertTrue(!str_contains($client->previewJson(), $failure->getMessage()), 'expected Guzzle error message omission');
        },

        'Guzzle cancellation completes once without changing cancellation semantics' => static function (): void {
            $client = httpTracingClient();
            $cancellation = new CancellationException('cancel detail must stay private');
            $source = httpTracingCancellablePromise($cancellation);
            $handler = static fn (): PromiseInterface => $source;
            $middleware = LogBrewHttpClientTracing::guzzleMiddleware($client);
            $traced = $middleware($handler);
            $scope = LogBrewTrace::activate(httpTracingParent('bbbbbbbbbbbbbbbb'));
            try {
                $promise = $traced(
                    new Request('GET', 'https://example.com/cancel'),
                    []
                );
            } finally {
                $scope->close();
            }

            $promise->cancel();
            $caught = null;
            try {
                $promise->wait();
            } catch (Throwable $error) {
                $caught = $error;
            }

            if (!$caught instanceof CancellationException) {
                throw new RuntimeException('expected Guzzle cancellation result');
            }
            assertTrue(
                $caught->getMessage() === 'The promise was rejected with reason: Promise has been cancelled',
                'expected unchanged cancellation message'
            );
            assertTrue(count(httpTracingEvents($client)) === 1, 'expected one cancellation span');
            assertTrue(!str_contains($client->previewJson(), 'cancel detail'), 'expected cancellation detail omission');
        },

        'Guzzle cancellation after then completes exactly once' => static function (): void {
            $client = httpTracingClient();
            $source = httpTracingCancellablePromise(new CancellationException('source cancellation'));
            $handler = static fn (): PromiseInterface => $source;
            $traced = LogBrewHttpClientTracing::guzzleMiddleware($client)($handler);
            $scope = LogBrewTrace::activate(httpTracingParent('cccccccccccccccc'));
            try {
                $promise = $traced(new Request('GET', 'https://example.com/cancel-then'), []);
            } finally {
                $scope->close();
            }
            $derived = $promise->then(static fn (mixed $value): mixed => $value);

            $derived->cancel();
            $caught = null;
            try {
                $derived->wait();
            } catch (Throwable $error) {
                $caught = $error;
            }

            if (!$caught instanceof CancellationException) {
                throw new RuntimeException('expected then cancellation exception');
            }
            assertTrue(
                $caught->getMessage() === 'The promise was rejected with reason: Promise has been cancelled',
                'expected unchanged then cancellation message'
            );
            assertTrue(count(httpTracingEvents($client)) === 1, 'expected one cancellation span after then');
        },

        'Guzzle cancellation after otherwise completes exactly once' => static function (): void {
            $client = httpTracingClient();
            $source = httpTracingCancellablePromise(new CancellationException('source cancellation'));
            $handler = static fn (): PromiseInterface => $source;
            $traced = LogBrewHttpClientTracing::guzzleMiddleware($client)($handler);
            $scope = LogBrewTrace::activate(httpTracingParent('dddddddddddddddd'));
            try {
                $promise = $traced(new Request('GET', 'https://example.com/cancel-otherwise'), []);
            } finally {
                $scope->close();
            }
            $derived = $promise->otherwise(static fn (mixed $reason): PromiseInterface => Create::rejectionFor($reason));

            $derived->cancel();
            $caught = null;
            try {
                $derived->wait();
            } catch (Throwable $error) {
                $caught = $error;
            }

            if (!$caught instanceof CancellationException) {
                throw new RuntimeException('expected otherwise cancellation exception');
            }
            assertTrue(
                $caught->getMessage() === 'The promise was rejected with reason: Promise has been cancelled',
                'expected unchanged otherwise cancellation message'
            );
            assertTrue(count(httpTracingEvents($client)) === 1, 'expected one cancellation span after otherwise');
        },

        'Guzzle explicit resolve reject and wait preserve semantics and complete once' => static function (): void {
            $client = httpTracingClient();
            $resolvedSource = new Promise();
            $resolvedHandler = static fn (): PromiseInterface => $resolvedSource;
            $resolvedTracing = LogBrewHttpClientTracing::guzzleMiddleware($client)($resolvedHandler);
            $scope = LogBrewTrace::activate(httpTracingParent('abababababababab'));
            try {
                $resolved = $resolvedTracing(new Request('GET', 'https://example.com/resolve'), []);
            } finally {
                $scope->close();
            }
            $response = new Response(206);
            $resolved->resolve($response);
            assertTrue($resolved->wait() === $response, 'expected explicit resolve value');
            $resolvedSource->cancel();

            $rejectedSource = new Promise();
            $rejectedHandler = static fn (): PromiseInterface => $rejectedSource;
            $rejectedTracing = LogBrewHttpClientTracing::guzzleMiddleware($client)($rejectedHandler);
            $scope = LogBrewTrace::activate(httpTracingParent('acacacacacacacac'));
            try {
                $rejected = $rejectedTracing(new Request('GET', 'https://example.com/reject'), []);
            } finally {
                $scope->close();
            }
            $failure = new RuntimeException('explicit rejection');
            $rejected->reject($failure);
            $caught = null;
            try {
                $rejected->wait();
            } catch (Throwable $error) {
                $caught = $error;
            }
            assertTrue($caught === $failure, 'expected explicit rejection identity');
            $rejectedSource->cancel();

            assertTrue(count(httpTracingEvents($client)) === 2, 'expected explicit settlement spans exactly once');
        },

        'duplicate Guzzle middleware emits one child span' => static function (): void {
            $client = httpTracingClient();
            $handlerCalls = 0;
            $handler = static function () use (&$handlerCalls): PromiseInterface {
                $handlerCalls++;
                return Create::promiseFor(new Response(200));
            };
            $firstMiddleware = LogBrewHttpClientTracing::guzzleMiddleware($client);
            $secondMiddleware = LogBrewHttpClientTracing::guzzleMiddleware($client);
            $once = $firstMiddleware($handler);
            $twice = $secondMiddleware($once);

            $scope = LogBrewTrace::activate(httpTracingParent('eeeeeeeeeeeeeeee'));
            try {
                $twice(new Request('GET', 'https://example.com'), [])->wait();
            } finally {
                $scope->close();
            }

            assertTrue($handlerCalls === 1, 'expected one Guzzle handler call');
            assertTrue(count(httpTracingEvents($client)) === 1, 'expected one span after duplicate Guzzle middleware');
        },

        'concurrent Guzzle requests retain independent parents and completion order' => static function (): void {
            $client = httpTracingClient();
            /** @var array<string, Promise> $pending */
            $pending = [];
            $handler = static function (RequestInterface $request) use (&$pending): PromiseInterface {
                $promise = new Promise();
                $pending[$request->getHeaderLine('x-request-id')] = $promise;
                return $promise;
            };
            $middleware = LogBrewHttpClientTracing::guzzleMiddleware($client);
            $traced = $middleware($handler);

            $parentOne = httpTracingParent('4444444444444444');
            $scopeOne = LogBrewTrace::activate($parentOne);
            try {
                $first = $traced(new Request('GET', 'https://one.example', ['x-request-id' => 'one']), []);
            } finally {
                $scopeOne->close();
            }

            $parentTwo = httpTracingParent('5555555555555555');
            $scopeTwo = LogBrewTrace::activate($parentTwo);
            try {
                $second = $traced(new Request('GET', 'https://two.example', ['x-request-id' => 'two']), []);
            } finally {
                $scopeTwo->close();
            }

            assertTrue(count(httpTracingEvents($client)) === 0, 'expected no span before async completion');
            $responseTwo = new Response(202);
            $responseOne = new Response(203);
            $pending['two']->resolve($responseTwo);
            $pending['one']->resolve($responseOne);
            assertTrue($second->wait() === $responseTwo, 'expected second response identity');
            assertTrue($first->wait() === $responseOne, 'expected first response identity');

            $events = httpTracingEvents($client);
            assertTrue(count($events) === 2, 'expected two concurrent spans');
            $parentIds = array_map(
                static fn (array $event): mixed => testAttributes($event)['parentSpanId'] ?? null,
                $events
            );
            sort($parentIds);
            assertTrue($parentIds === [$parentOne->spanId, $parentTwo->spanId], 'expected independent concurrent parents');
        },
    ];
}

$httpTracingFailures = [];
$httpTracingTests = httpTracingTests();
foreach ($httpTracingTests as $name => $test) {
    try {
        $test();
    } catch (Throwable $error) {
        $httpTracingFailures[] = $name . ': ' . $error->getMessage();
    }
}

if ($httpTracingFailures !== []) {
    fwrite(STDERR, implode(PHP_EOL, $httpTracingFailures) . PHP_EOL);
    throw new RuntimeException(sprintf('%d/%d HTTP client tracing tests failed', count($httpTracingFailures), count($httpTracingTests)));
}

fwrite(STDOUT, sprintf("PHP HTTP client tracing tests passed (%d)\n", count($httpTracingTests)));
