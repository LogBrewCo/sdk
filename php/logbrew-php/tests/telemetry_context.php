<?php

declare(strict_types=1);

use LogBrew\LogBrewClient;
use LogBrew\LogBrewTelemetry;
use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTraceContext;
use LogBrew\EncryptedFileEventStore;
use LogBrew\IssueDiagnostics;
use LogBrew\SdkError;
use LogBrew\TelemetryContext;
use LogBrew\TelemetryResource;

/** @return list<array<string, mixed>> */
function telemetryContextEvents(LogBrewClient $client): array
{
    $payload = json_decode($client->previewJson(), true, flags: JSON_THROW_ON_ERROR);
    if (!is_array($payload)) {
        throw new RuntimeException('expected telemetry context payload object');
    }
    $events = $payload['events'] ?? null;
    if (!is_array($events)) {
        throw new RuntimeException('expected telemetry context event list');
    }

    $copied = [];
    foreach ($events as $event) {
        if (!is_array($event)) {
            throw new RuntimeException('expected telemetry context event object');
        }
        $copiedEvent = [];
        foreach ($event as $key => $value) {
            if (!is_string($key)) {
                throw new RuntimeException('expected telemetry context event string keys');
            }
            $copiedEvent[$key] = $value;
        }
        $copied[] = $copiedEvent;
    }
    return $copied;
}

/**
 * @param array<string, mixed> $event
 * @return array<string, mixed>
 */
function telemetryContextAttributes(array $event): array
{
    $attributes = $event['attributes'] ?? null;
    if (!is_array($attributes)) {
        throw new RuntimeException('expected telemetry context attributes');
    }

    /** @var array<string, mixed> $attributes */
    return $attributes;
}

/**
 * @param array<string, mixed> $event
 * @return array<string, mixed>
 */
function telemetryContextValue(array $event): array
{
    $context = telemetryContextAttributes($event)['context'] ?? null;
    if (!is_array($context)) {
        throw new RuntimeException('expected shared telemetry context');
    }

    $copied = [];
    foreach ($context as $key => $value) {
        if (!is_string($key)) {
            throw new RuntimeException('expected shared telemetry context string keys');
        }
        $copied[$key] = $value;
    }
    return $copied;
}

/**
 * @param array<string, mixed> $value
 * @param non-empty-list<string> $path
 */
function telemetryContextAt(array $value, array $path): mixed
{
    $current = $value;
    foreach ($path as $key) {
        if (!is_array($current) || !array_key_exists($key, $current)) {
            throw new RuntimeException('missing telemetry context path: ' . implode('.', $path));
        }
        $current = $current[$key];
    }
    return $current;
}

/**
 * @param array<string, mixed> $value
 * @param non-empty-list<string> $path
 */
function telemetryContextHas(array $value, array $path): bool
{
    $current = $value;
    foreach ($path as $key) {
        if (!is_array($current) || !array_key_exists($key, $current)) {
            return false;
        }
        $current = $current[$key];
    }
    return true;
}

function expectTelemetryContextError(string $needle, callable $callback): void
{
    try {
        $callback();
    } catch (SdkError $error) {
        assertTrue($error->codeName === 'validation_error', 'expected telemetry context validation_error');
        assertTrue(str_contains($error->getMessage(), $needle), "expected telemetry context error containing: {$needle}");
        return;
    }

    throw new RuntimeException("expected telemetry context error containing: {$needle}");
}

$clientResource = TelemetryResource::create()
    ->withService('checkout-worker', '1.4.0')
    ->withDeployment('production', 'checkout@1.4.0')
    ->withFramework('symfony', '7.3.1')
    ->withApplication('checkout', '1.4.0', '20260803.1')
    ->build();
$callerTags = ['journey' => 'checkout', 'region' => 'global'];
$clientContext = TelemetryContext::create()
    ->withResource($clientResource)
    ->withSession('session_client')
    ->withSubject('subject_client', 'anonymous')
    ->withTags($callerTags)
    ->build();
$callerTags['journey'] = 'mutated-after-build';

$client = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    context: $clientContext,
    captureRuntimeContext: false
);
$timestamp = '2026-08-03T10:00:00.123Z';
$baseAttributes = [
    'release' => ['version' => '1.4.0'],
    'environment' => ['name' => 'production'],
    'issue' => ['title' => 'Checkout failed', 'level' => 'error'],
    'log' => ['message' => 'checkout started', 'level' => 'info'],
    'span' => [
        'name' => 'POST /checkout',
        'traceId' => '4bf92f3577b34da6a3ce929d0e0e4736',
        'spanId' => '00f067aa0ba902b7',
        'status' => 'ok',
    ],
    'metric' => [
        'name' => 'http.server.duration',
        'kind' => 'histogram',
        'value' => 42.5,
        'unit' => 'ms',
        'temporality' => 'delta',
    ],
    'action' => ['name' => 'checkout.submit', 'status' => 'success'],
];
foreach ($baseAttributes as $signal => $attributes) {
    $client->{$signal}("context_{$signal}", $timestamp, $attributes);
}

$events = telemetryContextEvents($client);
assertTrue(count($events) === 7, 'expected shared context on all seven PHP signals');
foreach ($events as $event) {
    $context = telemetryContextValue($event);
    assertTrue(($context['schemaVersion'] ?? null) === 1, 'expected context schema version 1');
    assertTrue(telemetryContextAt($context, ['resource', 'service', 'name']) === 'checkout-worker', 'expected client service context');
    assertTrue(telemetryContextAt($context, ['resource', 'deployment', 'release']) === 'checkout@1.4.0', 'expected deployment release context');
    assertTrue(telemetryContextAt($context, ['session', 'id']) === 'session_client', 'expected session context');
    assertTrue(telemetryContextAt($context, ['subject', 'id']) === 'subject_client', 'expected subject context');
    assertTrue(telemetryContextAt($context, ['tags', 'journey']) === 'checkout', 'expected detached client tags');
}

$activeTrace = LogBrewTraceContext::fromTraceparent(
    '00-11111111111111111111111111111111-2222222222222222-01',
    '3333333333333333'
);
$ambient = TelemetryContext::create()
    ->withSession('session_ambient', 'session_client')
    ->withSubject('subject_user', 'user')
    ->withTag('journey', 'payment')
    ->build();
$nested = TelemetryContext::create()
    ->withTag('step', 'confirm')
    ->build();
$eventOverride = TelemetryContext::create()
    ->withTraceIds(
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbb',
        sampled: false
    )
    ->withTag('journey', 'event-override')
    ->build();

assertTrue(LogBrewTelemetry::currentContext() === null, 'expected no ambient PHP context before activation');
$outerScope = LogBrewTelemetry::activateContext($ambient);
$traceScope = LogBrewTrace::activate($activeTrace);
try {
    $nestedScope = LogBrewTelemetry::activateContext($nested);
    try {
        $client->log('context_override', $timestamp, [
            'message' => 'payment confirmation failed',
            'level' => 'error',
            'context' => $eventOverride,
        ]);
    } finally {
        $nestedScope->close();
    }

    $client->log('context_ambient', $timestamp, [
        'message' => 'request continued',
        'level' => 'info',
    ]);
} finally {
    $traceScope->close();
    $outerScope->close();
}
assertTrue(LogBrewTelemetry::currentContext() === null, 'expected ambient PHP context to unwind');

$automaticScope = LogBrewTelemetry::activateContext($ambient);
assertTrue(LogBrewTelemetry::currentContext() !== null, 'expected automatically owned ambient PHP context');
unset($automaticScope);
assertTrue(LogBrewTelemetry::currentContext() === null, 'expected abandoned ambient PHP scope to unwind');

$events = telemetryContextEvents($client);
$overrideContext = telemetryContextValue($events[7]);
assertTrue(telemetryContextAt($overrideContext, ['trace', 'traceId']) === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'expected event trace to win last');
assertTrue(telemetryContextAt($overrideContext, ['trace', 'spanId']) === 'bbbbbbbbbbbbbbbb', 'expected event span to win last');
assertTrue(telemetryContextAt($overrideContext, ['trace', 'sampled']) === false, 'expected explicit event sampling decision');
assertTrue(telemetryContextAt($overrideContext, ['session', 'id']) === 'session_ambient', 'expected ambient session to override client session');
assertTrue(telemetryContextAt($overrideContext, ['subject', 'id']) === 'subject_user', 'expected ambient subject');
assertTrue(telemetryContextAt($overrideContext, ['tags', 'journey']) === 'event-override', 'expected event tag to win last');
assertTrue(telemetryContextAt($overrideContext, ['tags', 'step']) === 'confirm', 'expected nested ambient tag');

$ambientContext = telemetryContextValue($events[8]);
assertTrue(telemetryContextAt($ambientContext, ['trace', 'traceId']) === '11111111111111111111111111111111', 'expected active trace on direct capture');
assertTrue(telemetryContextAt($ambientContext, ['trace', 'spanId']) === '3333333333333333', 'expected active span on direct capture');
assertTrue(telemetryContextAt($ambientContext, ['trace', 'parentSpanId']) === '2222222222222222', 'expected active parent span');
assertTrue(!telemetryContextHas($ambientContext, ['tags', 'step']), 'expected nested context to unwind exactly');

$traceSignalClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    captureRuntimeContext: false
);
$traceSignalAttributes = $baseAttributes;
$traceSpanAttributes = [
    'name' => 'POST /checkout',
    'traceId' => $activeTrace->traceId,
    'spanId' => $activeTrace->spanId,
    'status' => 'ok',
];
if ($activeTrace->parentSpanId !== null) {
    $traceSpanAttributes['parentSpanId'] = $activeTrace->parentSpanId;
}
$traceSignalAttributes['span'] = $traceSpanAttributes;
LogBrewTrace::withTrace($activeTrace, static function () use (
    $traceSignalClient,
    $traceSignalAttributes,
    $timestamp
): void {
    foreach ($traceSignalAttributes as $signal => $attributes) {
        $traceSignalClient->{$signal}("active_trace_{$signal}", $timestamp, $attributes);
    }
});
foreach (telemetryContextEvents($traceSignalClient) as $event) {
    $context = telemetryContextValue($event);
    assertTrue(
        telemetryContextAt($context, ['trace', 'traceId']) === $activeTrace->traceId
            && telemetryContextAt($context, ['trace', 'spanId']) === $activeTrace->spanId,
        'expected active trace context on every PHP signal type'
    );
}

$runtimeClient = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$runtimeClient->log('runtime_default', $timestamp, ['message' => 'runtime', 'level' => 'info']);
$runtime = telemetryContextAt(
    telemetryContextValue(telemetryContextEvents($runtimeClient)[0]),
    ['resource', 'runtime']
);
assertTrue(is_array($runtime), 'expected safe PHP runtime context by default');
$runtimeContext = telemetryContextValue(telemetryContextEvents($runtimeClient)[0]);
assertTrue(telemetryContextAt($runtimeContext, ['resource', 'runtime', 'name']) === 'php', 'expected PHP runtime name');
assertTrue(telemetryContextAt($runtimeContext, ['resource', 'runtime', 'version']) === PHP_VERSION, 'expected PHP runtime version');

$optOutClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    captureRuntimeContext: false
);
$optOutClient->log('runtime_opt_out', $timestamp, ['message' => 'no runtime', 'level' => 'info']);
assertTrue(
    !array_key_exists('context', telemetryContextAttributes(telemetryContextEvents($optOutClient)[0])),
    'expected explicit runtime context opt-out'
);

expectTelemetryContextError('telemetry resource must not be empty', static fn () => TelemetryResource::create()->build());
expectTelemetryContextError('telemetry context must include', static fn () => TelemetryContext::create()->build());
expectTelemetryContextError('traceId must be 32 non-zero hex characters', static fn () => TelemetryContext::create()
    ->withTraceIds('00000000000000000000000000000000')
    ->build());
expectTelemetryContextError('session previousId must differ from id', static fn () => TelemetryContext::create()
    ->withSession('same', 'same')
    ->build());
expectTelemetryContextError('session id is invalid', static fn () => TelemetryContext::create()
    ->withSession("\u{00A0}")
    ->build());
expectTelemetryContextError('subject kind must be anonymous or user', static fn () => TelemetryContext::create()
    ->withSubject('opaque', 'email')
    ->build());
expectTelemetryContextError('tag key is invalid', static fn () => TelemetryContext::create()
    ->withTag('user email', 'not-allowed')
    ->build());
expectTelemetryContextError('must contain 1-32 entries', static function (): void {
    $builder = TelemetryContext::create();
    for ($index = 0; $index < 33; $index++) {
        $builder->withTag("tag.{$index}", 'bounded');
    }
    $builder->build();
});
expectTelemetryContextError('event context must be a TelemetryContext', static fn () => (new ReflectionMethod(
    $optOutClient,
    'log'
))->invoke($optOutClient, 'invalid_context', $timestamp, [
    'message' => 'invalid',
    'level' => 'info',
    'context' => [],
]));
expectTelemetryContextError('contains unsupported field rawUser', static fn () => TelemetryContext::fromArray([
    'schemaVersion' => 1,
    'rawUser' => ['email' => 'not-allowed'],
]));

$contextualIssueClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    captureRuntimeContext: false
);
$contextualIssueClient->issue('context_issue_helper', $timestamp, IssueDiagnostics::fromThrowable(
    new RuntimeException('message remains omitted'),
    context: TelemetryContext::create()->withSession('issue_session')->withTag('journey', 'recovery')->build()
));
$contextualIssue = telemetryContextValue(telemetryContextEvents($contextualIssueClient)[0]);
assertTrue(telemetryContextAt($contextualIssue, ['session', 'id']) === 'issue_session', 'expected issue helper context');
assertTrue(telemetryContextAt($contextualIssue, ['tags', 'journey']) === 'recovery', 'expected issue helper tag');

$persistentDirectory = persistentDeliveryDirectory();
$persistentKey = random_bytes(32);
$persistentStore = EncryptedFileEventStore::open($persistentDirectory, $persistentKey);
$persistentClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $persistentStore,
    context: TelemetryContext::create()->withSession('persisted_session')->withTag('journey', 'recovery')->build(),
    captureRuntimeContext: false
);
$persistentClient->issue('context_persisted', $timestamp, [
    'title' => 'Persistent issue',
    'level' => 'error',
]);
$beforeRestart = $persistentClient->previewJson();
$persistentStore->close();
unset($persistentClient, $persistentStore);

$reopenedStore = EncryptedFileEventStore::open($persistentDirectory, $persistentKey);
$reopenedClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $reopenedStore
);
assertTrue($reopenedClient->previewJson() === $beforeRestart, 'expected byte-stable shared context after queue restart');
$recoveredContext = telemetryContextValue(telemetryContextEvents($reopenedClient)[0]);
assertTrue(telemetryContextAt($recoveredContext, ['session', 'id']) === 'persisted_session', 'expected persisted session context');
assertTrue(!telemetryContextHas($recoveredContext, ['resource', 'runtime']), 'expected restart not to rewrite admitted context');
$reopenedClient->purgePersistedEvents();
$reopenedStore->close();
unset($reopenedClient, $reopenedStore);
removePersistentDeliveryDirectory($persistentDirectory);

fwrite(STDOUT, "php telemetry context checks passed\n");
