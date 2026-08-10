# logbrew/sdk

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public PHP SDK for creating LogBrew event batches, validating them locally, and flushing them through dependency-free HTTP delivery, with opt-in request trace correlation plus PSR-3, Monolog, a native Symfony bundle, and a config-cache-safe Laravel logger factory.

## Install

```bash
composer require logbrew/sdk
```

The public API is annotated with shaped-array PHPDoc, including `IssueAttributes` and `MetricAttributes`, so static-analysis tools can understand common consumer calls directly. The package includes copyable examples for PHP services, issue diagnostics, PSR-3 loggers, Monolog, Symfony, and Laravel. Use the fake `LOGBREW_API_KEY` placeholder in docs, keep the real key in app configuration, and call `previewJson()` when you want to inspect queued JSON before sending.

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

## Typed Issue Diagnostics

Use `IssueDiagnostics::fromThrowable(...)` when the application catches or reports a PHP failure and wants a useful issue rather than a title-only event. It builds first-class exception identity, mechanism and handled state, follows `getPrevious()` into a bounded parent-first exception chain, retains up to 32 newest-first frames with function/module identity, and keeps up to 64 application-supplied breadcrumbs in oldest-first order. Automatic node messages are redacted, missing per-node stacks are explicit, and cycles or the eight-node cap mark truncation. Symfony capture reuses the same projection. See the shared [exception-chain contract](../../docs/exception-chain-evidence.md).

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\IssueDiagnostics;
use LogBrew\LogBrewClient;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'checkout-php-service', '1.4.2');
$breadcrumbs = [
    IssueDiagnostics::breadcrumb(
        timestamp: '2026-08-02T10:14:58.125+00:00',
        category: 'checkout.navigation',
        type: 'navigation',
        level: 'info',
        message: 'User reached payment review',
        data: ['step' => 'payment']
    ),
    IssueDiagnostics::breadcrumb(
        timestamp: '2026-08-02T10:14:59Z',
        category: 'checkout.request',
        type: 'http',
        level: 'warn',
        data: ['method' => 'POST', 'statusCode' => 503]
    ),
];

try {
    runCheckout();
} catch (Throwable $error) {
    $client->issue(
        'evt_issue_checkout_failure',
        '2026-08-02T10:15:00Z',
        IssueDiagnostics::fromThrowable(
            $error,
            message: 'Checkout could not be completed.',
            mechanismType: 'php.exception',
            handled: true,
            metadata: ['routeTemplate' => '/checkout/:cart_id'],
            breadcrumbs: $breadcrumbs
        )
    );
}
```

Throwable capture deliberately omits the throwable message by default. It also never copies raw trace text, arguments, locals, source text, or absolute source paths; generated filenames are basename-only. Pass a deliberately safe `message` only when it adds user-facing value. `fromThrowable(..., context: $context)` can attach the same typed request context as nearby signals. Use `IssueDiagnostics::stackFrame(...)` for an explicit frame, and set `breadcrumbsTruncated: true` when the application retained only the newest 64 breadcrumbs. Run the shipped example with `php vendor/logbrew/sdk/examples/issue_diagnostics.php` or `make run-issue-diagnostics` from `vendor/logbrew/sdk/examples`.

## Shared Telemetry Context

Issues, logs, spans, metrics, actions, releases, and environment events all accept the same immutable schema-v1 `TelemetryContext`. Use it to give a human or AI the stable facts needed to move from a symptom to the affected deployment, request trace, session, and product journey without repeating those values in every flat metadata map.

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\LogBrewTelemetry;
use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTraceContext;
use LogBrew\TelemetryContext;
use LogBrew\TelemetryResource;

$clientContext = TelemetryContext::create()
    ->withResource(
        TelemetryResource::create()
            ->withService('checkout-api', '1.4.0')
            ->withDeployment('production', 'checkout@1.4.0')
            ->withFramework('symfony', '7.3.1')
            ->withApplication('checkout', '1.4.0', '20260803.1')
            ->build()
    )
    ->withTag('region', 'global')
    ->build();

$client = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'checkout-api',
    '1.4.0',
    context: $clientContext
);

$requestContext = TelemetryContext::create()
    ->withSession('session_checkout_123')
    ->withSubject('visitor_checkout_123', 'anonymous')
    ->withTag('journey', 'checkout')
    ->build();
$trace = LogBrewTraceContext::fromIncomingTraceparentOrCreateRoot(
    $_SERVER['HTTP_TRACEPARENT'] ?? null
);
$contextScope = LogBrewTelemetry::activateContext($requestContext);
$traceScope = LogBrewTrace::activate($trace);

try {
    $client->log('evt_checkout_started', '2026-08-03T10:00:00Z', [
        'message' => 'checkout started',
        'level' => 'info',
        'metadata' => ['routeTemplate' => '/checkout/:cart_id'],
    ]);
} finally {
    $traceScope->close();
    $contextScope->close();
}
```

The final merge order is client context, active `LogBrewTelemetry` context plus `LogBrewTrace::current()`, then the event's optional `context`. Resource sections and tags merge field by field; a later trace, session, or subject replaces the earlier section. Builders validate and detach values before queue admission. Tags are limited to 32 low-cardinality string dimensions, identifiers are opaque and bounded, and subject IDs should never be email addresses, authorization values, or other direct PII.

By default the client adds only safe PHP runtime identity: PHP version, OS family, and process architecture. Pass `captureRuntimeContext: false` when even that identity is inappropriate. The synchronous ambient scopes match the SDK's existing trace scope and must not be shared across overlapping Swoole coroutines or other concurrent request handlers; use an explicit client or event context in those environments.

## Explicit Metrics

Metrics answer aggregate questions: a counter shows how often something happened, a gauge shows the current level, and a histogram shows the distribution of values such as latency. In the dashboard they become time-series trends, comparisons, regression signals, and alert thresholds. A metric usually tells a user or AI **what changed**, not **why**; attach the same service, deployment, trace, session, and journey context as nearby logs, issues, and spans so an abnormal chart can lead directly to the evidence that explains it.

Use the `MetricAttributes` shaped array when your application already knows the measurement it wants to report:

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'my-php-app', '1.0.0');
$client->metric('evt_metric_001', '2026-06-02T10:00:06Z', [
    'name' => 'queue.depth',
    'description' => 'Number of items waiting in the checkout queue.',
    'kind' => 'gauge',
    'value' => 42,
    'unit' => '{items}',
    'temporality' => 'instant',
    'metadata' => ['queue' => 'default'],
]);
```

Metric kinds are `counter`, `gauge`, and `histogram`. Counters and histograms use `delta` or `cumulative` temporality and must be non-negative; gauges use `instant` temporality and may go up or down. An optional `description` gives people and investigation tools the stable meaning of the measurement. Keep it generic, single-line, between 1 and 1,024 Unicode scalar values, and free of identifiers, personal data, or changing values. It is not a query dimension. Prefer stable, low-cardinality primitive metadata such as queue or route pattern and put shared identity in `TelemetryContext`. The runtime identity described above is context, not a runtime measurement: this SDK does not automatically collect PHP memory, CPU, FPM, framework, or database metrics yet.

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

For first useful PHP service telemetry, combine release, environment, log, action, metric, and span events under the same resource, request, and trace context. This keeps each event readable on its own while letting dashboard users and agents traverse the complete causal chain.

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\LogBrewTelemetry;
use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTraceContext;
use LogBrew\ProductTimeline;
use LogBrew\TelemetryContext;
use LogBrew\TelemetryResource;

$incomingTraceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
$trace = LogBrewTraceContext::fromTraceparent($incomingTraceparent, 'b7ad6b7169203331');
$outgoingHeaders = $trace->headers();

$baseContext = TelemetryContext::create()
    ->withResource(
        TelemetryResource::create()
            ->withService('checkout-service', '1.2.3')
            ->withDeployment('production', 'checkout@1.2.3')
            ->build()
    )
    ->build();
$client = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'checkout-service',
    '1.2.3',
    context: $baseContext
);
$client->release('evt_release_checkout', '2026-06-02T10:00:00Z', ['version' => '1.2.3']);
$client->environment('evt_environment_checkout', '2026-06-02T10:00:01Z', ['name' => 'production']);

$requestContext = TelemetryContext::create()
    ->withSession('sess_checkout_123')
    ->withSubject('visitor_checkout_123', 'anonymous')
    ->withTag('journey', 'checkout')
    ->build();
$contextScope = LogBrewTelemetry::activateContext($requestContext);
$traceScope = LogBrewTrace::activate($trace);
try {
    $client->log('evt_log_checkout_started', '2026-06-02T10:00:02Z', [
        'message' => 'checkout request started',
        'level' => 'info',
        'metadata' => ['routeTemplate' => '/checkout/:cart_id'],
    ]);
    $client->action('evt_action_payment_api', '2026-06-02T10:00:04Z', ProductTimeline::networkMilestone(
        routeTemplate: 'https://api.example.com/payments/:payment_id?card=sample',
        method: 'POST',
        statusCode: 202,
        durationMs: 183.4
    ));
    $client->metric('evt_metric_http_server_duration', '2026-06-02T10:00:05Z', [
        'name' => 'http.server.duration',
        'kind' => 'histogram',
        'value' => 183.4,
        'unit' => 'ms',
        'temporality' => 'delta',
        'metadata' => ['routeTemplate' => '/checkout/:cart_id'],
    ]);
    $client->span('evt_span_checkout_request', '2026-06-02T10:00:06Z', [
        'name' => 'POST /checkout/:cart_id',
        'traceId' => $trace->traceId,
        'spanId' => $trace->spanId,
        'parentSpanId' => $trace->parentSpanId,
        'status' => 'ok',
        'durationMs' => 183.4,
    ]);
} finally {
    $traceScope->close();
    $contextScope->close();
}
```

Attach `$outgoingHeaders['traceparent']` to the next service call when your application owns that request. Keep route metadata as stable patterns such as `/checkout/:cart_id`; avoid raw URLs, request bodies, response bodies, and arbitrary headers.

## HTTP Request Trace Correlation

Use `LogBrewHttpRequestTelemetry` when a PHP service owns request handling and wants one W3C trace to link request logs, handler errors, request spans, request-duration metrics, and outgoing propagation. The helper keeps capture explicit: it does not patch global HTTP clients, read payloads, collect arbitrary headers, or serialize the raw `traceparent` value.

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\LogBrewHttpRequestTelemetry;
use LogBrew\IssueDiagnostics;
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
    try {
        runCheckout();
    } catch (RuntimeException $error) {
        $client->issue(
            'evt_issue_checkout_trace',
            '2026-06-02T10:00:04Z',
            IssueDiagnostics::fromThrowable(
                $error,
                title: 'Checkout handler failed',
                message: 'Payment provider failed.',
                metadata: LogBrewTrace::metadataWithCurrentTrace([
                    'routeTemplate' => $request->routeTemplate,
                ])
            )
        );
    }
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

`LogBrewHttpRequestTelemetry::start(...)` continues valid incoming W3C `traceparent` values and falls back to a local root trace when propagation is missing or malformed, so bad upstream headers do not interrupt request handling. `LogBrewTrace::current()` returns the active request trace. The core client promotes it into first-class typed context on every signal, including direct client calls; `LogBrewPsrLogger` and `LogBrewMonologHandler` also retain compatibility trace metadata, and app metadata cannot spoof those correlation fields.

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

## Outbound HTTP Tracing

Use `LogBrewHttpClientTracing` when your application owns a PSR-18 or Guzzle 7 client and wants each actual HTTP send to become a child of the active LogBrew trace:

```shell
composer require logbrew/sdk guzzlehttp/guzzle
```

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use GuzzleHttp\Client;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Request;
use LogBrew\LogBrewClient;
use LogBrew\LogBrewHttpClientTracing;
use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTraceContext;

$logBrew = LogBrewClient::create('LOGBREW_API_KEY', 'checkout-php-service', '1.4.2');
$stack = HandlerStack::create();
$stack->push(LogBrewHttpClientTracing::guzzleMiddleware($logBrew), 'logbrew-tracing');
$guzzle = new Client(['handler' => $stack]);
$psr18 = LogBrewHttpClientTracing::wrapPsr18(new Client(), $logBrew);
$parent = LogBrewTraceContext::fromIncomingTraceparentOrCreateRoot($_SERVER['HTTP_TRACEPARENT'] ?? null);

$scope = LogBrewTrace::activate($parent);
try {
    $response = $psr18->sendRequest(new Request('GET', 'https://inventory.example/check'));
    $promise = $guzzle->requestAsync('POST', 'https://inventory.example/check');
} finally {
    $scope->close();
}
$asyncResponse = $promise->wait();
```

When a LogBrew trace is active, both adapters replace only `traceparent` on the immutable outgoing request, reinstate the caller's active trace before returning control, and preserve the original response, exception, rejection, and cancellation behavior. Without an active LogBrew trace, they pass the original request through without propagation, span capture, or capture callbacks. Rewrapping a LogBrew PSR-18 client or installing the middleware more than once still emits one span per actual send. Capture failures are advisory and may be observed through the optional `onCaptureError` callback.

Outbound spans contain only method, normalized host, status code when available, duration, fixed client source, sampled state, and exception type. They never contain the URL path, query, fragment, arbitrary headers, request or response bodies, exception messages, authorization values, baggage, or tracestate. Instrumentation is explicit and app-owned; the SDK does not patch global clients or install runtime hooks.

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

`HttpTransport` uses PHP's standard stream context HTTP support, posts JSON, passes the SDK key through the `authorization` header, supports custom endpoint, header, timeout, and requester settings, maps HTTP statuses through the client's retry rules, and converts request failures into retryable transport errors. Public transport failures contain only a stable code and generic message; callback and request details are never propagated by the SDK.

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

`EncryptedFileEventStore` requires OpenSSL AES-256-GCM support and never stores its key. Each compact event and staged retry body is authenticated and encrypted with a fresh nonce. Records use owner-only permissions, full writes, file `fflush()`/`fsync()`, atomic publication, and containing-directory `fsync()`. If a new event's directory entry cannot be confirmed, admission removes it and durably syncs that rollback before returning an error. Recovery is oldest-first and fails closed on a wrong key, tampering, unsafe links, unexpected files, a replaced directory, a copied post-fork handle, or queue bounds that no longer fit. The queue never includes the API key.

Before a transport call, the exact request body is staged. A later process retries those bytes before newer events. After a 2xx response, an accepted-sequence marker is committed before record removal, so interrupted compaction cannot reintroduce the accepted prefix. Backend event IDs remain the final duplicate-safety boundary if a process dies after the server accepts a request but before the local acknowledgement is durable.

Persistence is explicit and synchronous: successful capture returns only after its encrypted record and directory entry are fsynced. The SDK does not add a shutdown hook, destructor flush, timer, signal handler, thread, or background sender. Normal clients remain memory-only when `eventStore` is omitted. Do not share one directory between active workers; assign a stable application worker-slot directory and let the exclusive lock reject accidental overlap.

For PHP-FPM, keep the memory-only default and flush inside the request unless the application can assign a stable, serialized queue directory to each worker slot. Create and open any persistent client inside the worker process, never in a pre-fork master. A process cannot flush, purge, close, or otherwise manage another worker's queue; the SDK lock coordinates exclusive recovery after ownership ends but does not create cross-worker lifecycle control.

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

## Symfony Quick Start

Symfony applications can use the native bundle without an application-owned handler factory, service definition, or Monolog handler block. Install `logbrew/sdk`, then register the bundle beside the application's existing bundles:

```php
// config/bundles.php
return [
    // Keep the application's existing bundles.
    LogBrew\Symfony\LogBrewBundle::class => ['all' => true],
];
```

Set a project-scoped server/SDK ingest key in the deployment environment or an uncommitted `.env.local` file:

```dotenv
LOGBREW_SERVER_API_KEY=
```

If the application does not have a project yet, the authenticated CLI can create both the project and an owner-only key file without a dashboard step:

```shell
logbrew login
logbrew projects create "Symfony App" \
  --runtime php \
  --environment development \
  --ingest-key-file "$HOME/.logbrew/symfony-app.key" \
  --json
```

Load that file through the deployment's environment mechanism. For a local confirmation that does not print the key:

```shell
LOGBREW_SERVER_API_KEY="$(<"$HOME/.logbrew/symfony-app.key")" \
  php bin/console logbrew:status --send-probe --json
```

That is enough to preserve the existing Monolog handlers while adding warning-and-higher LogBrew delivery, stable route-name request spans, W3C `traceparent` continuation, and issues for uncaught exceptions that produce 5xx responses. A missing key makes the bundle a safe no-op instead of preventing the application from booting.

Confirm configuration and perform an intake probe without adding an application route:

```shell
php bin/console logbrew:status --send-probe --json
```

The JSON output reports `ready`, `missing_api_key`, or `disabled`; `--send-probe` reports the accepted intake status without printing the key. Accepted warning logs and completed requests use immediate delivery with a 2-second timeout and zero in-call retries. A failed batch remains bounded in the client and is retried before newer telemetry on the next accepted log or request event. Capture failures do not change the application response or normal logging behavior.

Optional configuration can name the service/release and adjust capture policy:

```yaml
# config/packages/log_brew.yaml
log_brew:
  service: checkout-api
  release: 'unversioned'
  level: warning
  capture_requests: true
  capture_exceptions: true
  include_exception_message: false
  include_exception_trace: false
  context_provider: App\Observability\LogBrewContextProvider
```

The optional provider is an invokable autowired service. It is the explicit privacy boundary for request-specific identity; return only opaque application-owned IDs and low-cardinality tags:

```php
<?php

namespace App\Observability;

use LogBrew\TelemetryContext;
use Symfony\Component\HttpFoundation\Request;

final class LogBrewContextProvider
{
    public function __invoke(Request $request): ?TelemetryContext
    {
        $sessionId = $request->attributes->get('telemetry_session_id');
        $subjectId = $request->attributes->get('telemetry_subject_id');
        if (!is_string($sessionId) || !is_string($subjectId)) {
            return null;
        }

        return TelemetryContext::create()
            ->withSession($sessionId)
            ->withSubject($subjectId, 'user')
            ->withTag('journey', 'checkout')
            ->build();
    }
}
```

The provider context and continued trace stay active while the main request runs, so application logs, captured issues, request spans, and request metrics share the same correlation. Provider failures are reported through the optional error callback and never change the application response. Do not return email addresses, cookies, authorization data, concrete paths, or arbitrary request attributes.

Automatic request telemetry records only the method, bounded Symfony route name, status, duration, typed PHP/framework/service/release/environment identity, and normalized trace identifiers. It does not record concrete paths, query strings, request or response bodies, arbitrary headers, or the raw `traceparent` value. Automatic exception issues include a first-class exception type, `symfony.kernel_exception` mechanism with `handled: false`, up to 32 newest-first basename-only frames with safe function/module identity, and a hashed type/route/file grouping key. Arguments, locals, source text, and absolute paths are never captured; exception messages and raw trace text remain off unless explicitly enabled. The handler excludes Symfony's `request`, `event`, `doctrine`, and `deprecation` channels to avoid duplicating framework exception reports or copying Symfony's formatted exception message. Application-authored log messages and primitive context remain under the application's control.

## Laravel Quick Start

Laravel already owns Monolog, so `logbrew/sdk` keeps it optional and supplies the framework glue. Add this scalar-only channel to `config/logging.php`; it is safe to persist with `php artisan config:cache`:

```php
use LogBrew\LaravelLoggerFactory;

'channels' => [
    // Keep the application's existing channels.
    'logbrew' => LaravelLoggerFactory::configuration(
        apiKey: env('LOGBREW_SERVER_API_KEY'),
        service: env('APP_NAME', 'laravel-app'),
        release: env('APP_VERSION', 'unversioned'),
        environment: env('APP_ENV', 'production'),
    ),
],
```

Keep the existing local log channel in the stack and opt in through environment configuration:

```dotenv
LOG_CHANNEL=stack
LOG_STACK=single,logbrew
LOGBREW_SERVER_API_KEY=
```

Use a project-scoped server/SDK ingest key, never a user login key. The channel is not resolved when it is absent from the active stack; if the channel is enabled without a key, the factory raises an actionable configuration error.

The Laravel factory accepts warning-and-higher records by default and immediately flushes every accepted record with a 2-second timeout and zero retries. Every record gets typed PHP/Laravel/service/deployment context. Application middleware can activate an explicit `LogBrewTelemetry` scope to add opaque session, subject, and journey context to logs written during that request. Delivery failures stay inside the handler and do not interrupt application logging; a retained failed record is retried with the next accepted record. Override `level`, `timeout`, or `maxRetries` through named arguments to `configuration(...)` when the application has a different bounded policy. Write directly with `Log::channel('logbrew')->warning(...)` or include `logbrew` beside the existing channel in Laravel's stack.

## Custom Monolog Integration

Use `LogBrewMonologHandler` directly when a non-Laravel PHP app already logs through Monolog. Install `monolog/monolog:^3.0` in the application, construct a client and transport, and choose an explicit delivery boundary. The generic handler queues by default; pass both `transport` and `flushOnLog: true` for immediate delivery, or call the client's `flush()` or `shutdown()` at an application-owned lifecycle boundary.

`LogBrewMonologHandler` captures the Monolog channel, level, message template, primitive context fields, primitive `extra` fields, active LogBrew trace metadata, and exception type/message. Exception trace text is omitted unless `includeExceptionTrace` is enabled. The handler preserves normal app logging by default: capture failures are reported through `onError` when provided, and only rethrown when `raiseErrors` is enabled. Use `previewJson()` when you want a stable local JSON preview before sending anything.
