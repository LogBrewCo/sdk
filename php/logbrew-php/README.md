# logbrew/sdk

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-espresso-bg-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public PHP SDK for creating LogBrew event batches, validating them locally, and flushing them through dependency-free HTTP delivery, with opt-in PSR-3 and Monolog/Laravel logger support.

## Install

```bash
composer require logbrew/sdk
```

The public API is annotated with shaped-array PHPDoc, including `MetricAttributes`, so static-analysis tools can understand common consumer calls directly. The package includes copyable examples for PHP services, PSR-3 loggers, Monolog, and Laravel. Use the fake `LOGBREW_API_KEY` placeholder in docs, keep the real key in app configuration, and call `previewJson()` when you want to inspect queued JSON before sending.

## Example

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$client->release('evt_release_001', '2026-06-02T10:00:00Z', [
    'version' => '1.2.3',
    'commit' => 'abc123def456',
    'notes' => 'Public release marker',
]);
$client->environment('evt_environment_001', '2026-06-02T10:00:01Z', [
    'name' => 'production',
    'region' => 'global',
]);
$client->issue('evt_issue_001', '2026-06-02T10:00:02Z', [
    'title' => 'Checkout timeout',
    'level' => 'error',
    'message' => 'Request timed out after retry budget',
]);
$client->log('evt_log_001', '2026-06-02T10:00:03Z', [
    'message' => 'worker started',
    'level' => 'info',
    'logger' => 'job-runner',
]);
$client->span('evt_span_001', '2026-06-02T10:00:04Z', [
    'name' => 'GET /health',
    'traceId' => 'trace_001',
    'spanId' => 'span_001',
    'status' => 'ok',
    'durationMs' => 12.5,
]);
$client->action('evt_action_001', '2026-06-02T10:00:05Z', [
    'name' => 'deploy',
    'status' => 'success',
]);

echo $client->previewJson() . PHP_EOL;

$transport = RecordingTransport::alwaysAccept();
$response = $client->shutdown($transport);
fwrite(STDERR, json_encode([
    'ok' => true,
    'status' => $response->statusCode,
    'attempts' => $response->attempts,
    'events' => 6,
], JSON_THROW_ON_ERROR) . PHP_EOL);
```

## Explicit Metrics

Use the `MetricAttributes` shaped array when your application already knows the measurement it wants to report:

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'my-php-app', '1.0.0');
$client->metric('evt_metric_001', '2026-06-02T10:00:06Z', [
    'name' => 'queue.depth',
    'kind' => 'gauge',
    'value' => 42,
    'unit' => '{items}',
    'temporality' => 'instant',
    'metadata' => ['queue' => 'default'],
]);
```

Metric kinds are `counter`, `gauge`, and `histogram`. Counters and histograms use `delta` or `cumulative` temporality and must be non-negative; gauges use `instant` temporality and may go up or down. Prefer stable, low-cardinality primitive metadata such as service, region, queue, or route pattern. This SDK does not automatically collect PHP runtime, FPM, framework, or database metrics yet.

## HTTP Delivery

Use `HttpTransport` when you want the SDK to POST queued batches to LogBrew:

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\HttpTransport;
use LogBrew\LogBrewClient;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'my-php-app', '1.0.0');
$client->log('evt_log_001', '2026-06-02T10:00:03Z', [
    'message' => 'worker started',
    'level' => 'info',
]);

$transport = new HttpTransport(
    endpoint: HttpTransport::DEFAULT_ENDPOINT,
    headers: ['x-logbrew-source' => 'php'],
    timeout: 10.0
);

$response = $client->shutdown($transport);
```

`HttpTransport` uses PHP's standard stream context HTTP support, posts JSON, passes the SDK key through the `authorization` header, supports custom endpoint, header, timeout, and requester settings, maps HTTP statuses through the client's retry rules, and converts request failures into retryable transport errors.

## PSR-3 Logger

Use `LogBrewPsrLogger` anywhere a `Psr\Log\LoggerInterface` is expected:

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\LogBrewPsrLogger;
use LogBrew\RecordingTransport;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'my-php-app', '1.0.0');
$transport = RecordingTransport::alwaysAccept();
$logger = new LogBrewPsrLogger(
    client: $client,
    loggerName: 'checkout',
    metadata: ['service' => 'checkout']
);

$logger->warning('Checkout slow for {region}', [
    'region' => 'global',
    'attempt' => 2,
]);

try {
    throw new RuntimeException('payment failed');
} catch (RuntimeException $error) {
    $logger->error('Checkout failed for {region}', [
        'region' => 'global',
        'exception' => $error,
    ]);
}

$client->flush($transport);
```

`LogBrewPsrLogger` interpolates PSR-3 placeholders, maps `debug`/`info`/`notice` to LogBrew `info`, `warning` to `warning`, `error` to `error`, and `critical`/`alert`/`emergency` to `critical`, captures primitive context values under `context.*`, and records exception type/message when the `exception` context value is a `Throwable`. Exception trace text is omitted unless `includeExceptionTrace` is enabled. Logs are queued by default; pass both `transport` and `flushOnLog: true` only when each logger call should flush immediately.

## Monolog And Laravel

Use `LogBrewMonologHandler` when a PHP app already logs through Monolog. Laravel apps can wire it as a normal `monolog` channel in `config/logging.php`:

```php
'logbrew' => [
    'driver' => 'monolog',
    'handler' => LogBrew\LogBrewMonologHandler::class,
    'with' => [
        'client' => LogBrew\LogBrewClient::create(
            env('LOGBREW_API_KEY', 'LOGBREW_API_KEY'),
            config('app.name', 'laravel-app'),
            config('app.version', '1.0.0')
        ),
        'transport' => new LogBrew\HttpTransport(
            endpoint: LogBrew\HttpTransport::DEFAULT_ENDPOINT,
            timeout: 10.0
        ),
        'flushOnLog' => false,
        'metadata' => [
            'framework' => 'laravel',
            'environment' => app()->environment(),
        ],
    ],
],
```

Then include `logbrew` in the Laravel logging stack or write to it directly with `Log::channel('logbrew')->warning(...)`.

`LogBrewMonologHandler` captures the Monolog channel, level, message template, primitive context fields, primitive `extra` fields, and exception type/message. Exception trace text is omitted unless `includeExceptionTrace` is enabled. The handler preserves normal app logging by default: capture failures are reported through `onError` when provided, and only rethrown when `raiseErrors` is enabled.

Use a clearly fake placeholder like `LOGBREW_API_KEY` in examples. Call `flush()` or `shutdown()` to send queued events through a transport, and use `previewJson()` when you want a stable local JSON preview before sending anything.
