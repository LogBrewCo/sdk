<?php

declare(strict_types=1);

use LogBrew\LogBrewClient;
use LogBrew\LogBrewHttpRequestTelemetry;
use LogBrew\LogBrewMonologHandler;
use LogBrew\LogBrewPsrLogger;
use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTraceContext;
use Monolog\Logger as MonologLogger;
use Psr\Log\LogLevel;

/**
 * @param array<string, mixed> $payload
 * @return array<string, mixed>
 */
function phpTraceEvent(array $payload, string $eventId): array
{
    $events = $payload['events'] ?? null;
    if (!is_array($events)) {
        fwrite(STDERR, 'expected trace payload events array' . PHP_EOL);
        exit(1);
    }

    foreach ($events as $event) {
        if (!is_array($event) || ($event['id'] ?? null) !== $eventId) {
            continue;
        }

        return phpTraceStringKeyed($event);
    }

    fwrite(STDERR, "missing trace event {$eventId}" . PHP_EOL);
    exit(1);
}

/**
 * @param array<string, mixed> $event
 * @return array<string, mixed>
 */
function phpTraceMetadata(array $event): array
{
    $attributes = phpTraceAttributes($event);
    $metadata = $attributes['metadata'] ?? null;
    if (!is_array($metadata)) {
        fwrite(STDERR, 'expected trace metadata object' . PHP_EOL);
        exit(1);
    }
    return phpTraceStringKeyed($metadata);
}

/**
 * @param array<string, mixed> $event
 * @return array<string, mixed>
 */
function phpTraceAttributes(array $event): array
{
    $attributes = $event['attributes'] ?? null;
    if (!is_array($attributes)) {
        fwrite(STDERR, 'expected trace attributes object' . PHP_EOL);
        exit(1);
    }
    return phpTraceStringKeyed($attributes);
}

/**
 * @param array<string, mixed> $metadata
 */
function phpTraceAssertCorrelation(array $metadata, string $traceId, string $spanId): void
{
    assertTrue(($metadata['traceId'] ?? null) === $traceId, 'expected correlated trace id');
    assertTrue(($metadata['spanId'] ?? null) === $spanId, 'expected correlated span id');
    assertTrue(($metadata['traceFlags'] ?? null) === '01', 'expected trace flags metadata');
    assertTrue(($metadata['traceSampled'] ?? null) === true, 'expected sampled trace metadata');
}

/**
 * @param array<mixed> $values
 * @return array<string, mixed>
 */
function phpTraceStringKeyed(array $values): array
{
    $copied = [];
    foreach ($values as $key => $value) {
        if (is_string($key)) {
            $copied[$key] = $value;
        }
    }

    return $copied;
}

$incomingTraceparent = '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01';
$trace = LogBrewTraceContext::fromTraceparent($incomingTraceparent, 'B7AD6B7169203331');
assertTrue($trace->traceId === '4bf92f3577b34da6a3ce929d0e0e4736', 'expected PHP trace context trace id');
assertTrue($trace->spanId === 'b7ad6b7169203331', 'expected PHP trace context span id');
assertTrue($trace->parentSpanId === '00f067aa0ba902b7', 'expected PHP trace context parent span id');
assertTrue($trace->traceFlags === '01', 'expected PHP trace context flags');
assertTrue($trace->sampled === true, 'expected PHP trace context sampled flag');
assertTrue(
    $trace->headers() === ['traceparent' => '00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01'],
    'expected PHP trace context outgoing header'
);
assertTrue(!array_key_exists('traceparent', $trace->metadata()), 'expected raw traceparent to be omitted from metadata');

$unsampledRoot = LogBrewTraceContext::createRoot('00');
assertTrue($unsampledRoot->sampled === false, 'expected unsampled local root');
assertTrue($unsampledRoot->parentSpanId === null, 'expected local root without parent');
$fallbackRoot = LogBrewTraceContext::fromIncomingTraceparentOrCreateRoot('not-a-traceparent');
assertTrue($fallbackRoot->parentSpanId === null, 'expected malformed propagation to fall back to local root');
expectThrows(
    fn () => LogBrewTraceContext::fromTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
    'traceparent trace id must be 32 non-zero hex characters'
);

assertTrue(LogBrewTrace::current() === null, 'expected no active PHP trace initially');
$outer = LogBrewTraceContext::createRoot();
$inner = LogBrewTraceContext::createChild($outer);
$outerScope = LogBrewTrace::activate($outer);
assertTrue(LogBrewTrace::current() === $outer, 'expected outer active trace');
$innerResult = LogBrewTrace::withTrace($inner, static function (LogBrewTraceContext $active) use ($inner): string {
    assertTrue($active === $inner, 'expected withTrace callback argument');
    assertTrue(LogBrewTrace::current() === $inner, 'expected inner active trace');
    return 'ok';
});
assertTrue($innerResult === 'ok', 'expected withTrace callback return value');
assertTrue(LogBrewTrace::current() === $outer, 'expected active trace restoration after withTrace');
$outerScope->close();
assertTrue(LogBrewTrace::current() === null, 'expected active trace cleared after scope close');
$firstScope = LogBrewTrace::activate($outer);
$secondScope = LogBrewTrace::activate($inner);
$firstScope->close();
assertTrue(LogBrewTrace::current() === $inner, 'expected out-of-order scope close not to clear newer trace');
$secondScope->close();
assertTrue(LogBrewTrace::current() === null, 'expected closing newer scope to leave no active trace after outer was removed');

$client = sampleClient();
$request = LogBrewHttpRequestTelemetry::start(
    $client,
    'post',
    'https://shop.example/checkout/:cart_id?coupon=sample#review',
    $incomingTraceparent
);
$logger = new LogBrewPsrLogger(
    client: $client,
    loggerName: 'checkout.trace',
    eventIdPrefix: 'php_trace_psr',
    metadata: ['service' => 'checkout', 'traceId' => 'spoofed', 'ignoredBase' => []],
    timestampProvider: static fn (): DateTimeImmutable => new DateTimeImmutable('2026-06-02T10:00:03+00:00')
);
$scope = $request->activate();
try {
    $logger->log(LogLevel::WARNING, 'checkout slow for {cartId}', [
        'cartId' => 'cart_123',
        'ignoredContext' => [],
    ]);
    $client->issue('evt_issue_php_trace', '2026-06-02T10:00:04Z', [
        'title' => 'Checkout handler failed',
        'level' => 'error',
        'message' => 'payment provider failed',
        'metadata' => LogBrewTrace::metadataWithCurrentTrace([
            'routeTemplate' => $request->routeTemplate,
            'exceptionType' => RuntimeException::class,
            'exceptionMessage' => 'payment provider failed',
            'ignored' => [],
        ]),
    ]);
} finally {
    $scope->close();
}

$request->finishSpanAndMetric(
    'evt_span_php_trace',
    'evt_metric_php_trace',
    '2026-06-02T10:00:06Z',
    503,
    ['cartTier' => 'gold', 'ignored' => []]
);
$preview = $client->previewJson();
$decodedPayload = json_decode($preview, true, 512, JSON_THROW_ON_ERROR);
if (!is_array($decodedPayload)) {
    fwrite(STDERR, 'expected PHP trace payload object' . PHP_EOL);
    exit(1);
}
$payload = phpTraceStringKeyed($decodedPayload);
assertTrue(stripos($preview, 'traceparent') === false, 'expected raw traceparent to be omitted from PHP trace telemetry');
assertTrue(!str_contains($preview, 'coupon=sample'), 'expected PHP trace query text to be omitted');
assertTrue(!str_contains($preview, 'spoofed'), 'expected active trace metadata to overwrite spoofed trace id');
assertTrue(!str_contains($preview, 'ignoredBase'), 'expected PHP trace logger to omit non-primitive base metadata');
assertTrue(!str_contains($preview, 'ignoredContext'), 'expected PHP trace logger to omit non-primitive context metadata');
assertTrue(!str_contains($preview, '"ignored"'), 'expected PHP trace helper to omit non-primitive metadata');

$traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
$spanId = $request->trace->spanId;
$outgoingHeaders = $request->outgoingHeaders();
assertTrue(
    $outgoingHeaders['traceparent'] === sprintf('00-%s-%s-01', $traceId, $spanId),
    'expected PHP trace outgoing propagation to use request span id'
);

$logEvent = phpTraceEvent($payload, 'php_trace_psr_1');
$issueEvent = phpTraceEvent($payload, 'evt_issue_php_trace');
$spanEvent = phpTraceEvent($payload, 'evt_span_php_trace');
$metricEvent = phpTraceEvent($payload, 'evt_metric_php_trace');
$spanAttributes = phpTraceAttributes($spanEvent);
$metricAttributes = phpTraceAttributes($metricEvent);
phpTraceAssertCorrelation(phpTraceMetadata($logEvent), $traceId, $spanId);
phpTraceAssertCorrelation(phpTraceMetadata($issueEvent), $traceId, $spanId);
phpTraceAssertCorrelation(phpTraceMetadata($spanEvent), $traceId, $spanId);
phpTraceAssertCorrelation(phpTraceMetadata($metricEvent), $traceId, $spanId);
assertTrue(($spanAttributes['parentSpanId'] ?? null) === '00f067aa0ba902b7', 'expected PHP request span parent');
assertTrue(($spanAttributes['name'] ?? null) === 'POST /checkout/:cart_id', 'expected sanitized PHP request span name');
assertTrue(($spanAttributes['status'] ?? null) === 'error', 'expected 5xx request span error status');
assertTrue(($metricAttributes['name'] ?? null) === 'http.server.duration', 'expected PHP request duration metric');
assertTrue((phpTraceMetadata($metricEvent)['statusCode'] ?? null) === 503, 'expected PHP metric status code metadata');
assertTrue((phpTraceMetadata($logEvent)['context.cartId'] ?? null) === 'cart_123', 'expected PHP PSR context metadata');
assertTrue((phpTraceMetadata($issueEvent)['exceptionMessage'] ?? null) === 'payment provider failed', 'expected PHP issue metadata');

$client = sampleClient();
$monologTrace = LogBrewTraceContext::fromTraceparent($incomingTraceparent, '1111111111111111');
$monolog = new MonologLogger('checkout.monolog.trace');
$monolog->pushHandler(new LogBrewMonologHandler(
    client: $client,
    eventIdPrefix: 'php_trace_monolog',
    timestampProvider: static fn (): DateTimeImmutable => new DateTimeImmutable('2026-06-02T10:00:07+00:00')
));
$scope = LogBrewTrace::activate($monologTrace);
try {
    $monolog->error('Checkout failed for {cartId}', ['cartId' => 'cart_123']);
} finally {
    $scope->close();
}
$decodedPayload = json_decode($client->previewJson(), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($decodedPayload)) {
    fwrite(STDERR, 'expected PHP Monolog trace payload object' . PHP_EOL);
    exit(1);
}
$payload = phpTraceStringKeyed($decodedPayload);
$monologEvent = phpTraceEvent($payload, 'php_trace_monolog_1');
phpTraceAssertCorrelation(phpTraceMetadata($monologEvent), $traceId, '1111111111111111');
assertTrue((phpTraceMetadata($monologEvent)['monologChannel'] ?? null) === 'checkout.monolog.trace', 'expected PHP Monolog channel metadata');
assertTrue((phpTraceMetadata($monologEvent)['context.cartId'] ?? null) === 'cart_123', 'expected PHP Monolog context metadata');

expectThrows(
    fn () => LogBrewHttpRequestTelemetry::start(sampleClient(), 'GET /bad', '/health'),
    'HTTP request method must be a valid HTTP method'
);
expectThrows(
    fn () => LogBrewHttpRequestTelemetry::start(sampleClient(), 'GET', '?debug=sample'),
    'HTTP request routeTemplate must be non-empty'
);
expectThrows(
    fn () => LogBrewHttpRequestTelemetry::start(sampleClient(), 'GET', '/health')->finishSpan('evt_bad_status', '2026-06-02T10:00:06Z', 700),
    'HTTP request statusCode must be between 100 and 599'
);
$request = LogBrewHttpRequestTelemetry::start(sampleClient(), 'GET', '/health');
$request->finishSpan('evt_span_once', '2026-06-02T10:00:06Z', 204);
expectThrows(
    fn () => $request->finishSpan('evt_span_twice', '2026-06-02T10:00:07Z', 204),
    'HTTP request telemetry is already finished'
);
