# logbrew/sdk

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public PHP SDK for creating LogBrew event batches, validating them locally, and flushing them through dependency-free HTTP delivery, with opt-in request trace correlation plus PSR-3 and Monolog/Laravel logger support.

## Install

```bash
composer require logbrew/sdk
```

The public API is annotated with shaped-array PHPDoc, including `MetricAttributes`, so static-analysis tools can understand common consumer calls directly. The package includes copyable examples for PHP services, PSR-3 loggers, Monolog, and Laravel. Use the fake `LOGBREW_API_KEY` placeholder in docs, keep the real key in app configuration, and call `previewJson()` when you want to inspect queued JSON before sending.

## Support Ticket Drafts

Use `SupportTicketDraft` only when a user or agent explicitly wants a local payload draft for the planned support-ticket API. It validates the public create fields, normalizes W3C trace IDs, and redacts token-free diagnostics before handoff. It does not open a ticket, call backend support routes, send telemetry, or use account/session API credentials.

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\SupportTicketDraft;

$draft = SupportTicketDraft::create(
    source: 'sdk',
    category: 'ingest_failure',
    title: 'PHP ingest failed',
    description: 'Events reached the retry limit in production.',
    projectId: 'proj_public_123',
    environment: 'production',
    runtime: PHP_VERSION,
    framework: 'laravel',
    sdkPackage: 'logbrew/sdk',
    sdkVersion: '0.1.0',
    release: 'checkout@1.2.3',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    eventId: 'evt_issue_001',
    diagnostics: [
        'endpoint' => 'https://api.example.com/v1/events?debug=sample',
        'authorization' => 'Bearer lbw_ingest_sample',
        'exception' => new RuntimeException('local message is not included'),
    ],
);
```

Diagnostics keep primitive JSON-friendly values, URL paths without host/query/fragment text, and exception types only. Sensitive keys such as `authorization`, `cookie`, `secret`, `session`, and `token` are replaced with `[redacted]`; local filesystem paths are replaced with `[redacted-path]`.

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
    'batches' => $response->batches,
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

## Product and Network Timelines

Use `ProductTimeline` when your PHP service already knows important product steps or API milestones. The helpers create normal `action` events with primitive metadata that AI assistants can analyze across sessions without visual replay, HTTP client patching, request/response payload capture, or header capture.

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\ProductTimeline;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'my-php-app', '1.0.0');

$client->action('evt_action_checkout_submit', '2026-06-02T10:00:05Z', ProductTimeline::productAction(
    name: 'checkout.submit',
    routeTemplate: '/checkout/:step',
    sessionId: 'session_123',
    traceId: 'trace_abc',
    screen: 'Checkout',
    funnel: 'checkout',
    step: 'submit',
    metadata: ['cartTier' => 'gold']
));

$client->action('evt_network_payment', '2026-06-02T10:00:06Z', ProductTimeline::networkMilestone(
    routeTemplate: 'https://api.example.com/v1/payments/:id?debug=sample',
    method: 'POST',
    statusCode: 202,
    durationMs: 183.4,
    sessionId: 'session_123',
    traceId: 'trace_abc'
));
```

`ProductTimeline` strips query strings and fragments from route templates, keeps metadata primitive-only, infers failed network milestones from 4xx/5xx status codes, and leaves all capture under app control.

## First Useful Service Telemetry

For first useful PHP service telemetry, combine release, environment, log, action, metric, and span events in one request path. `Traceparent` accepts W3C `traceparent` headers, normalizes IDs, rejects forbidden all-zero identifiers, exposes the sampled flag, and creates outbound propagation headers without patching HTTP clients.

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\ProductTimeline;
use LogBrew\Traceparent;
use LogBrew\TraceparentSpanInput;

$incomingTraceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
$traceContext = Traceparent::parse($incomingTraceparent);
$childSpanId = 'b7ad6b7169203331';
$outgoingHeaders = Traceparent::createHeaders($traceContext->traceId, $childSpanId, $traceContext->traceFlags);

$client = LogBrewClient::create('LOGBREW_API_KEY', 'checkout-service', '1.2.3');
$client->release('evt_release_checkout', '2026-06-02T10:00:00Z', ['version' => '1.2.3']);
$client->environment('evt_environment_checkout', '2026-06-02T10:00:01Z', ['name' => 'production']);
$client->log('evt_log_checkout_started', '2026-06-02T10:00:02Z', [
    'message' => 'checkout request started',
    'level' => 'info',
    'metadata' => [
        'traceId' => $traceContext->traceId,
        'sessionId' => 'sess_checkout_123',
        'routeTemplate' => '/checkout/:cart_id',
    ],
]);
$client->action('evt_action_payment_api', '2026-06-02T10:00:04Z', ProductTimeline::networkMilestone(
    routeTemplate: 'https://api.example.com/payments/:payment_id?card=sample',
    method: 'POST',
    statusCode: 202,
    durationMs: 183.4,
    sessionId: 'sess_checkout_123',
    traceId: $traceContext->traceId
));
$client->metric('evt_metric_http_server_duration', '2026-06-02T10:00:05Z', [
    'name' => 'http.server.duration',
    'kind' => 'histogram',
    'value' => 183.4,
    'unit' => 'ms',
    'temporality' => 'delta',
    'metadata' => [
        'method' => 'POST',
        'routeTemplate' => '/checkout/:cart_id',
        'statusCode' => 202,
        'traceId' => $traceContext->traceId,
    ],
]);
$client->span('evt_span_checkout_request', '2026-06-02T10:00:06Z', Traceparent::spanAttributesFromTraceparent(
    $traceContext,
    TraceparentSpanInput::create('POST /checkout/:cart_id', $childSpanId)
        ->withDurationMs(183.4)
        ->withMetadata(['sampled' => $traceContext->sampled, 'sessionId' => 'sess_checkout_123'])
));
```

Attach `$outgoingHeaders['traceparent']` to the next service call when your application owns that request. Keep route metadata as stable patterns such as `/checkout/:cart_id`; avoid raw URLs, request bodies, response bodies, and arbitrary headers.

## HTTP Request Trace Correlation

Use `LogBrewHttpRequestTelemetry` when a PHP service owns request handling and wants one W3C trace to link request logs, handler errors, request spans, request-duration metrics, and outgoing propagation. The helper keeps capture explicit: it does not patch global HTTP clients, read payloads, collect arbitrary headers, or serialize the raw `traceparent` value.

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\LogBrewHttpRequestTelemetry;
use LogBrew\LogBrewPsrLogger;
use LogBrew\LogBrewTrace;
use Psr\Log\LogLevel;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'checkout-php-service', '1.4.2');
$request = LogBrewHttpRequestTelemetry::start(
    $client,
    'POST',
    'https://shop.example/checkout/:cart_id?coupon=sample#review',
    $_SERVER['HTTP_TRACEPARENT'] ?? null
);
$logger = new LogBrewPsrLogger($client, loggerName: 'checkout');

$scope = $request->activate();
try {
    $logger->log(LogLevel::WARNING, 'checkout slow for {cartId}', ['cartId' => 'cart_123']);
    $client->issue('evt_issue_checkout_trace', '2026-06-02T10:00:04Z', [
        'title' => 'Checkout handler failed',
        'level' => 'error',
        'message' => 'payment provider failed',
        'metadata' => LogBrewTrace::metadataWithCurrentTrace([
            'routeTemplate' => $request->routeTemplate,
            'exceptionType' => RuntimeException::class,
            'exceptionMessage' => 'payment provider failed',
        ]),
    ]);
} finally {
    $scope->close();
}

$request->finishSpanAndMetric(
    'evt_span_checkout_trace',
    'evt_metric_checkout_trace',
    '2026-06-02T10:00:06Z',
    503
);

$outgoingHeaders = $request->outgoingHeaders();
```

`LogBrewHttpRequestTelemetry::start(...)` continues valid incoming W3C `traceparent` values and falls back to a local root trace when propagation is missing or malformed, so bad upstream headers do not interrupt request handling. `LogBrewTrace::current()` returns the active request trace, and `LogBrewTrace::metadataWithCurrentTrace(...)` merges primitive metadata with `traceId`, `spanId`, `parentSpanId`, `traceFlags`, and `traceSampled`. Active trace metadata is automatically added to `LogBrewPsrLogger` and `LogBrewMonologHandler` records, and app metadata cannot spoof those correlation fields.

For a copyable service example, run `php vendor/logbrew/sdk/examples/http_trace_correlation.php` or `make run-http-trace-correlation` from `vendor/logbrew/sdk/examples`.

## Dependency Spans

Use `LogBrewOperationTracing` around app-owned database, cache, or queue calls when you want the operation to show up as a child span under the active request trace. The helper creates one span per callback, returns to the previous trace scope, preserves your callback return value or original exception, and reports telemetry capture failures only through the optional `onCaptureError` callback.

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\LogBrewOperationTracing;
use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTraceContext;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'checkout-php-service', '1.4.2');
$trace = LogBrewTraceContext::fromIncomingTraceparentOrCreateRoot($_SERVER['HTTP_TRACEPARENT'] ?? null);
$scope = LogBrewTrace::activate($trace);

try {
    $cart = LogBrewOperationTracing::databaseOperation(
        $client,
        'db.select checkout_cart',
        static fn (): array => ['id' => 'cart_123'],
        [
            'system' => 'mysql',
            'operation' => 'select',
            'target' => 'checkout.cart',
            'metadata' => ['table' => 'carts', 'rowCount' => 1],
        ]
    );
} finally {
    $scope->close();
}
```

`databaseOperation`, `cacheOperation`, and `queueOperation` keep instrumentation explicit and dependency-free. They do not patch PDO, Doctrine, Redis, Laravel queues, or global PHP runtime hooks; they avoid SQL text, connection strings, network locations, login fields, cache identifiers, message bodies, arbitrary headers, baggage, and tracestate. Metadata is primitive-only and sensitive-looking keys are dropped before enqueue.

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

## Bounded Delivery

The client bounds its in-memory queue to 1,000 events and 4 MiB of compact serialized event data by default. Each HTTP request is also limited to 100 events and 256 KiB of exact UTF-8 JSON. Queue pressure rejects the new event so earlier release, environment, and trace context stays available for the next flush. Request pressure splits retained events into another ordered batch; only a single event that cannot fit one request is rejected. Pressure never blocks the application or changes the result of a logger or instrumentation callback.

Tune both limits and observe local loss without exposing event attributes:

```php
<?php

use LogBrew\DroppedEvent;
use LogBrew\LogBrewClient;

$client = LogBrewClient::create(
    apiKey: 'LOGBREW_API_KEY',
    sdkName: 'my-php-app',
    sdkVersion: '1.0.0',
    maxQueueSize: 2_000,
    maxQueueBytes: 8 * 1024 * 1024,
    maxBatchEvents: 100,
    maxBatchBytes: 256 * 1024,
    onEventDropped: static function (DroppedEvent $drop): void {
        error_log(sprintf(
            'LogBrew dropped %s telemetry (%s); total=%d pending=%d bytes=%d',
            $drop->eventType,
            $drop->reason,
            $drop->droppedEvents,
            $drop->pendingEvents,
            $drop->pendingEventBytes
        ));
    }
);
```

`DroppedEvent` contains only the rejected event ID/type, stable reason, cumulative drop count, and retained queue count/bytes. It never contains attributes, log messages, exception details, headers, bodies, query text, or trace state. Exceptions from `onEventDropped` are ignored so application behavior remains isolated. Use `pendingEvents()`, `pendingEventBytes()`, and `droppedEvents()` for explicit health checks.

`flush()` and `shutdown()` snapshot the queue, send compact ordered batches, retry each failed batch with byte-identical JSON, and acknowledge only a 2xx prefix. A failed request body stays frozen across later flush/shutdown calls; newly appended events are sent only after that exact prefix succeeds. If a later batch fails, accepted earlier batches stay removed while the failed batch and everything after it remain queued. Events captured by app-owned transport code during `flush()` remain for the next call. `shutdown()` rejects new capture while delivery is running, closes only after every snapshot batch succeeds, and reopens the intact queue after failure. `TransportResponse::attempts` counts all requests including retries, while `TransportResponse::batches` counts accepted batches.

Applications that intentionally queued events larger than 256 KiB can temporarily raise `maxBatchBytes` enough to include the compact event plus its SDK envelope while reducing those payloads; `maxQueueBytes` continues to bound queued event data. The safer long-term contract is small telemetry with identifiers and primitive metadata rather than request bodies, full documents, stack archives, or other large content.

## Long-Running Workers

Use `LogBrewWorkerLifecycle` when a RoadRunner, queue, or other serialized long-running PHP worker needs one explicit telemetry boundary per work item:

```php
<?php

use LogBrew\HttpTransport;
use LogBrew\LogBrewClient;
use LogBrew\LogBrewWorkerLifecycle;
use LogBrew\WorkerDeliveryFailure;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'checkout-worker', '1.0.0');
$lifecycle = LogBrewWorkerLifecycle::create(
    $client,
    new HttpTransport(),
    static function (WorkerDeliveryFailure $failure): void {
        error_log(sprintf(
            'LogBrew %s failed (%s); pending=%d bytes=%d',
            $failure->stage,
            $failure->codeName,
            $failure->pendingEvents,
            $failure->pendingEventBytes
        ));
    }
);

while (($job = nextJob()) !== null) {
    $lifecycle->run(static function () use ($client, $job): void {
        processJob($job);
        $client->log($job->telemetryId(), gmdate(DATE_ATOM), [
            'message' => 'job completed',
            'level' => 'info',
            'logger' => 'checkout-worker',
        ]);
    });
}

$lifecycle->shutdown();
```

`run()` always attempts a bounded flush after the callback, including when the callback throws. A delivery failure retains the queue for the next boundary and cannot replace the callback result or original exception. `WorkerDeliveryFailure` contains only stage, stable code, retained count, and retained bytes; it never contains event attributes, messages, credentials, URLs, headers, bodies, exception text, stack traces, or process identifiers. Exceptions from the diagnostic callback are ignored.

Create the client and lifecycle inside each child after `pcntl_fork()`. An inherited pre-fork lifecycle rejects `run()` and `shutdown()` with `process_ownership_error` before work or delivery, preventing a child from replaying the parent's copied queue. Successful `shutdown()` is terminal-idempotent; failed shutdown reports and rethrows the delivery error so the same retained batch can be retried.

The lifecycle is opt-in and app-scoped. It does not register a PHP shutdown function, flush from a destructor, install a timer, patch a framework, or intercept `pcntl_fork()`. Existing applications can keep calling `LogBrewClient::flush()` and `shutdown()` directly. Migrate a long-running worker by wrapping one existing job callback at a time, creating the lifecycle after any fork, then replacing its final direct client shutdown with `$lifecycle->shutdown()`.

One lifecycle is deliberately single-flight. Do not share it across overlapping Swoole coroutine handlers or other concurrent callbacks: reentrant `run()` and `shutdown()` calls fail before invoking inner work. Use one client/lifecycle per serialized execution context, or keep explicit direct client boundaries until the application can guarantee serialization.

## Encrypted Restart Delivery

Long-running POSIX workers can opt into an encrypted file queue when process restarts must not discard accepted telemetry. Decode a stable application-managed key to exactly 32 raw bytes, use one dedicated owner-only directory per serialized worker slot, and create the store after any fork:

```php
<?php

use LogBrew\EncryptedFileEventStore;
use LogBrew\HttpTransport;
use LogBrew\LogBrewClient;
use LogBrew\LogBrewWorkerLifecycle;

$encodedKey = $_ENV['LOGBREW_PERSISTENCE_KEY'] ?? '';
$key = base64_decode($encodedKey, true);
if (!is_string($key) || strlen($key) !== 32) {
    throw new RuntimeException('LogBrew persistence key is unavailable');
}

$store = EncryptedFileEventStore::open(
    '/var/lib/my-worker/logbrew/worker-0',
    $key
);
$client = LogBrewClient::create(
    apiKey: $_ENV['LOGBREW_API_KEY'],
    sdkName: 'checkout-worker',
    sdkVersion: '1.0.0',
    eventStore: $store
);
$lifecycle = LogBrewWorkerLifecycle::create($client, new HttpTransport());

while (($job = nextJob()) !== null) {
    $lifecycle->run(static function () use ($client, $job): void {
        processJob($job);
        $client->log($job->telemetryId(), gmdate(DATE_ATOM), [
            'message' => 'job completed',
            'level' => 'info',
        ]);
    });
}

$lifecycle->shutdown();
```

`EncryptedFileEventStore` requires OpenSSL AES-256-GCM support and never stores its key. Each compact event and staged retry body is authenticated and encrypted with a fresh nonce. Records use owner-only permissions, full writes, `fflush()`/`fsync()`, and atomic rename. Recovery is oldest-first and fails closed on a wrong key, tampering, unsafe links, unexpected files, a replaced directory, a copied post-fork handle, or queue bounds that no longer fit. The queue never includes the API key.

Before a transport call, the exact request body is staged. A later process retries those bytes before newer events. After a 2xx response, an accepted-sequence marker is committed before record removal, so interrupted compaction cannot reintroduce the accepted prefix. Backend event IDs remain the final duplicate-safety boundary if a process dies after the server accepts a request but before the local acknowledgement is durable.

Persistence is explicit and synchronous: successful capture returns only after its encrypted record is fsynced. The SDK does not add a shutdown hook, destructor flush, timer, signal handler, thread, or background sender. Normal clients remain memory-only when `eventStore` is omitted. Do not share one directory between active workers; assign a stable application worker-slot directory and let the exclusive lock reject accidental overlap. Filesystem directory-entry durability still depends on the host filesystem and operating system after atomic rename.

Successful `shutdown()` drains the queue and releases the store lock. Failed shutdown leaves the exact retry body available to the same client or a later process. Use `$client->purgePersistedEvents()` only for an explicit local discard decision; it clears memory and commits the durable prefix without sending telemetry. To rotate the encryption key, drain or explicitly purge and close the old store, then switch the next client to a new empty owner-only directory with the new key. Do not reopen an existing directory under a different key.

See `examples/persistent_worker_delivery.php` for a local usage sample with an ephemeral queue and `RecordingTransport`.

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

`LogBrewPsrLogger` interpolates PSR-3 placeholders, maps `debug`/`info`/`notice` to LogBrew `info`, `warning` to `warning`, `error` to `error`, and `critical`/`alert`/`emergency` to `critical`, captures primitive context values under `context.*`, and records exception type/message when the `exception` context value is a `Throwable`. When `LogBrewTrace::current()` is active, the logger automatically adds trace correlation metadata to each record. Exception trace text is omitted unless `includeExceptionTrace` is enabled. Logs are queued by default; pass both `transport` and `flushOnLog: true` only when each logger call should flush immediately.

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

`LogBrewMonologHandler` captures the Monolog channel, level, message template, primitive context fields, primitive `extra` fields, active LogBrew trace metadata, and exception type/message. Exception trace text is omitted unless `includeExceptionTrace` is enabled. The handler preserves normal app logging by default: capture failures are reported through `onError` when provided, and only rethrown when `raiseErrors` is enabled.

Use a clearly fake placeholder like `LOGBREW_API_KEY` in examples. Call `flush()` or `shutdown()` to send queued events through a transport, and use `previewJson()` when you want a stable local JSON preview before sending anything.
