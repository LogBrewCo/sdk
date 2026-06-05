# logbrew/sdk

Public PHP SDK for creating LogBrew event batches, validating them locally, and flushing them through dependency-free HTTP delivery, with opt-in PSR-3 and Monolog/Laravel logger support.

## Install

```bash
composer require logbrew/sdk
cd vendor/logbrew/sdk/examples && make
cd vendor/logbrew/sdk/examples && make run-readme-example
cd vendor/logbrew/sdk/examples && make run
cd vendor/logbrew/sdk/examples && make run-real-user-smoke
php vendor/logbrew/sdk/examples/readme_example.php
php vendor/logbrew/sdk/examples/real_user_smoke.php
```

The public API is annotated with shaped-array PHPDoc so static-analysis tools can check common consumer calls directly, and installed consumers can inspect the public payload-shape aliases plus the client, PSR-3 logger, optional Monolog handler, SDK error, transport interface, HTTP transport, recording transport, response, and lifecycle method surface through reflection, including property-level docs on transport responses and recorded request bodies.
Normal installs should also expose standard Composer metadata like `composer require logbrew/sdk`, `composer show logbrew/sdk`, `composer show logbrew/sdk --format=json`, `composer why logbrew/sdk`, `composer licenses --format=json`, `composer.lock`, `vendor/composer/installed.json`, and the generated autoload/version helpers under `vendor/composer/`. The plain `composer show` summary should keep the expected package name, description, selected version, library type, MIT license line, artifact zip source, install path, PSR-4 autoload block, PHP requirement, and `psr/log` dependency. Both the packaged archive and installed vendor package should ship `README.md`, `composer.json`, `examples/readme_example.php`, `examples/real_user_smoke.php`, and a tiny `examples/Makefile` helper. Those archive and installed README surfaces should still include the `composer require` command, the fake `LOGBREW_API_KEY` placeholder, the `previewJson()` usage note, PSR-3 logger guidance, and the shared `examples/Makefile` helper commands a real user would rely on after install. The shipped `examples/readme_example.php` and `examples/real_user_smoke.php` files should both run from the repo checkout and from `vendor/logbrew/sdk/examples/` after install, and the shipped `examples/Makefile` helper should give users one discoverable surface for both flows, with plain `make` printing copy-pasteable `make run-readme-example`, `make run`, and `make run-real-user-smoke` commands before the README example runs through `make run-readme-example` and the stronger real-user path runs through `make run` or `make run-real-user-smoke`. The temp consumer should also start from a Composer-native `composer init` bootstrap, stay valid under `composer validate`, survive a package-manager-native `composer remove logbrew/sdk` removal before `composer require logbrew/sdk:0.1.0` adds the artifact back, keep a generated lockfile strong enough to recreate the install with a clean `composer install` after `vendor/` is removed, survive a normal `composer dump-autoload --optimize` refresh without losing the SDK autoload surface, prove the direct `smoke/app -> logbrew/sdk` dependency edge through Composer's own `why` output, surface the installed dependency license through Composer's own `licenses` report, prove the structured `composer show --format=json` view for description, type, dist, install path, autoload, and PHP requirement metadata, and support tiny installed-user scripts that still exercise the public client through Composer's own script runner, including a static-analysis consumer script, one that mirrors the published README example before and after reinstall, a PSR-3 logger script, the happy-path smoke run itself, and the shipped example files from the installed vendor package.

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

`LogBrewPsrLogger` interpolates PSR-3 placeholders, maps `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, and `emergency` into LogBrew log levels, captures primitive context values under `context.*`, and records exception type/message when the `exception` context value is a `Throwable`. Exception trace text is omitted unless `includeExceptionTrace` is enabled. Logs are queued by default; pass both `transport` and `flushOnLog: true` only when each logger call should flush immediately.

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

Use a clearly fake placeholder like `LOGBREW_API_KEY` in local examples and tests. Call `flush()` or `shutdown()` to send queued events through a transport, and use `previewJson()` when you want a stable local JSON preview without sending anything.
