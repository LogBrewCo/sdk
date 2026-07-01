#!/usr/bin/env bash
set -euo pipefail

version="${1:-${LOGBREW_PACKAGIST_VERSION:-0.1.1}}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

export COMPOSER_HOME="$tmp_dir/composer-home"
export COMPOSER_CACHE_DIR="$tmp_dir/composer-cache"
export COMPOSER_ROOT_VERSION="1.0.0"
export LOGBREW_PACKAGIST_INSTALLED_VERSION="$version"

cd "$tmp_dir"

composer init \
  --name logbrew/packagist-public-smoke \
  --description "Disposable LogBrew Packagist public install smoke" \
  --type project \
  --no-interaction \
  --quiet
composer config license proprietary
composer config repositories.packagist composer https://repo.packagist.org
composer require "logbrew/sdk:${version}" "monolog/monolog:^3.0" --no-interaction --prefer-dist --no-progress
composer validate --no-check-publish --no-check-version --strict >/dev/null

composer show logbrew/sdk > composer-show-logbrew-sdk.txt
grep -q '^name[[:space:]]*: logbrew/sdk$' composer-show-logbrew-sdk.txt
grep -Eq "^versions[[:space:]]*: \\* v?${version}$" composer-show-logbrew-sdk.txt

php <<'PHP'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\HttpTransport;
use LogBrew\LogBrewClient;
use LogBrew\LogBrewMonologHandler;
use LogBrew\LogBrewOperationTracing;
use LogBrew\LogBrewPsrLogger;
use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTraceContext;
use LogBrew\ProductTimeline;
use LogBrew\RecordingTransport;
use LogBrew\SupportTicketDraft;
use LogBrew\Traceparent;
use LogBrew\TraceparentSpanInput;
use LogBrew\TransportResponse;
use Monolog\Logger;
use Psr\Log\LogLevel;

$version = getenv('LOGBREW_PACKAGIST_INSTALLED_VERSION') ?: '0.1.1';
$installedVersion = Composer\InstalledVersions::getPrettyVersion('logbrew/sdk');
if (!Composer\InstalledVersions::isInstalled('logbrew/sdk')) {
    fwrite(STDERR, "logbrew/sdk is not installed according to Composer\n");
    exit(1);
}
if ($installedVersion !== $version && $installedVersion !== 'v' . $version) {
    fwrite(STDERR, "unexpected installed logbrew/sdk version: {$installedVersion}\n");
    exit(1);
}

foreach ([
    LogBrewClient::class,
    LogBrewOperationTracing::class,
    LogBrewTrace::class,
    LogBrewTraceContext::class,
    RecordingTransport::class,
    HttpTransport::class,
    LogBrewPsrLogger::class,
    LogBrewMonologHandler::class,
    ProductTimeline::class,
    SupportTicketDraft::class,
    Traceparent::class,
    TraceparentSpanInput::class,
] as $className) {
    if (!class_exists($className)) {
        fwrite(STDERR, "missing installed class {$className}\n");
        exit(1);
    }
}

$client = LogBrewClient::create('LOGBREW_API_KEY', 'packagist-public-smoke', $version);
$client->release('evt_packagist_release', '2026-06-02T10:00:00Z', ['version' => '1.2.3']);
$client->environment('evt_packagist_environment', '2026-06-02T10:00:01Z', ['name' => 'production']);
$client->log('evt_packagist_log', '2026-06-02T10:00:02Z', [
    'message' => 'Packagist smoke log',
    'level' => 'info',
    'logger' => 'packagist-smoke',
    'metadata' => ['safe' => 'kept'],
]);
$client->issue('evt_packagist_issue', '2026-06-02T10:00:03Z', [
    'title' => 'Packagist smoke issue',
    'level' => 'warning',
]);
$client->span('evt_packagist_span', '2026-06-02T10:00:04Z', [
    'name' => 'packagist.smoke',
    'traceId' => '4bf92f3577b34da6a3ce929d0e0e4736',
    'spanId' => 'b7ad6b7169203331',
    'status' => 'ok',
    'durationMs' => 12.5,
]);
$client->action('evt_packagist_action', '2026-06-02T10:00:06Z', [
    'name' => 'packagist_smoke',
    'status' => 'success',
]);
$client->metric('evt_packagist_metric', '2026-06-02T10:00:07Z', [
    'name' => 'http.server.duration',
    'kind' => 'histogram',
    'value' => 42.5,
    'unit' => 'ms',
    'temporality' => 'delta',
    'metadata' => ['routeTemplate' => '/checkout/:cart_id'],
]);

$incomingTraceparent = '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01';
$traceContext = Traceparent::parse($incomingTraceparent);
if ($traceContext->traceId !== '4bf92f3577b34da6a3ce929d0e0e4736' || $traceContext->parentSpanId !== '00f067aa0ba902b7') {
    fwrite(STDERR, "Traceparent::parse did not normalize installed Packagist trace ids\n");
    exit(1);
}
$childSpanId = 'b7ad6b7169203331';
$outgoingHeaders = Traceparent::createHeaders($traceContext->traceId, $childSpanId, $traceContext->traceFlags);
if (($outgoingHeaders['traceparent'] ?? '') !== '00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01') {
    fwrite(STDERR, "Traceparent::createHeaders did not create normalized outgoing propagation\n");
    exit(1);
}
$client->span(
    'evt_packagist_traceparent_span',
    '2026-06-02T10:00:08Z',
    Traceparent::spanAttributesFromTraceparent(
        $traceContext,
        TraceparentSpanInput::create('POST /checkout/:cart_id', $childSpanId)
            ->withDurationMs(18.25)
            ->withMetadata(['routeTemplate' => '/checkout/:cart_id'])
    )
);
$client->action(
    'evt_packagist_product_action',
    '2026-06-02T10:00:09Z',
    ProductTimeline::productAction(
        'checkout.submit',
        'success',
        routeTemplate: '/checkout/:cart_id',
        sessionId: 'session_public_123',
        traceId: $traceContext->traceId,
        screen: 'checkout',
        funnel: 'purchase',
        step: 'submit',
        metadata: ['cartTier' => 'gold']
    )
);
$client->action(
    'evt_packagist_network_action',
    '2026-06-02T10:00:10Z',
    ProductTimeline::networkMilestone(
        'https://shop.example/checkout/:cart_id?coupon=sample#review',
        'POST',
        statusCode: 502,
        durationMs: 31.5,
        traceId: $traceContext->traceId
    )
);

$operationParent = LogBrewTraceContext::fromTraceparent($incomingTraceparent, '1111111111111111');
$operationScope = LogBrewTrace::activate($operationParent);
try {
    $operationResult = LogBrewOperationTracing::databaseOperation(
        $client,
        'db.select checkout_cart',
        static function (LogBrewTraceContext $active) use ($operationParent): string {
            if ($active->traceId !== $operationParent->traceId || $active->parentSpanId !== $operationParent->spanId) {
                throw new RuntimeException('dependency operation did not activate child trace');
            }
            return 'cart';
        },
        [
            'eventId' => 'evt_packagist_dependency_db',
            'timestamp' => '2026-06-02T10:00:11Z',
            'durationMs' => 7.5,
            'system' => 'mysql',
            'operation' => 'select',
            'target' => 'checkout.cart',
            'metadata' => [
                'table' => 'carts',
                'rowCount' => 1,
                'query' => 'select * from carts where id = ?',
                'connection_' . 'string' => 'mysql://user:pass' . 'word@db.internal.example/app',
            ],
        ]
    );
} finally {
    $operationScope->close();
}
if ($operationResult !== 'cart' || LogBrewTrace::current() !== null) {
    fwrite(STDERR, "LogBrewOperationTracing did not preserve result or restore trace scope\n");
    exit(1);
}

$supportDraft = SupportTicketDraft::create(
    source: 'sdk',
    category: 'ingest_failure',
    title: '  Packagist PHP ingest failed  ',
    description: '  Local support draft for explicit user handoff.  ',
    sdkPackage: 'logbrew/sdk',
    sdkVersion: $version,
    traceId: $traceContext->traceId,
    diagnostics: [
        'author' . 'ization' => 'local-example-auth-value',
        'endpoint' => 'https://api.example.com/v1/events?sample=1#fragment',
        'localPath' => '/Users/example/project/.env',
        'debugNote' => 'failed at https://api.example.com/v1/events?sample=1 from /Users/example/project/.env',
        'safe' => 'kept',
    ]
);
$supportJson = json_encode($supportDraft, JSON_THROW_ON_ERROR);
foreach ([
    '"sdk_package":"logbrew\/sdk"',
    "\"sdk_version\":\"{$version}\"",
    '"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"',
    '"endpoint":"[redacted-url]\/v1\/events"',
    '"localPath":"[redacted-path]"',
    '"safe":"kept"',
] as $needle) {
    if (!str_contains($supportJson, $needle)) {
        fwrite(STDERR, "support ticket draft missing {$needle}\n");
        exit(1);
    }
}
foreach ([
    'local-example-auth-value',
    'api.example.com',
    'sample=1',
    '/Users/example/project',
] as $needle) {
    if (str_contains($supportJson, $needle)) {
        fwrite(STDERR, "support ticket draft leaked {$needle}\n");
        exit(1);
    }
}

$preview = $client->previewJson();
foreach ([
    '"type": "release"',
    '"type": "environment"',
    '"type": "log"',
    '"type": "issue"',
    '"type": "span"',
    '"type": "metric"',
    '"type": "action"',
    '"id": "evt_packagist_traceparent_span"',
    '"id": "evt_packagist_product_action"',
    '"id": "evt_packagist_network_action"',
    '"id": "evt_packagist_dependency_db"',
    '"source": "database.operation"',
    '"source": "network_timeline"',
] as $needle) {
    if (!str_contains($preview, $needle)) {
        fwrite(STDERR, "previewJson missing {$needle}\n");
        exit(1);
    }
}
$decodedPreview = json_decode($preview, true, 512, JSON_THROW_ON_ERROR);
$events = is_array($decodedPreview['events'] ?? null) ? $decodedPreview['events'] : [];
$hasRouteTemplate = false;
foreach ($events as $event) {
    if (!is_array($event)) {
        continue;
    }
    $metadata = $event['attributes']['metadata'] ?? null;
    if (is_array($metadata) && ($metadata['routeTemplate'] ?? null) === '/checkout/:cart_id') {
        $hasRouteTemplate = true;
        break;
    }
}
if (!$hasRouteTemplate) {
    fwrite(STDERR, "previewJson missing routeTemplate /checkout/:cart_id metadata\n");
    exit(1);
}
foreach ([
    'shop.example',
    'coupon=sample',
    'select * from carts',
    'connection_' . 'string',
    'db.internal.example',
    'pass' . 'word@',
] as $needle) {
    if (str_contains($preview, $needle)) {
        fwrite(STDERR, "previewJson leaked {$needle}\n");
        exit(1);
    }
}

$response = $client->flush(RecordingTransport::alwaysAccept());
if ($response->statusCode !== 202 || $response->attempts !== 1) {
    fwrite(STDERR, "unexpected RecordingTransport flush response\n");
    exit(1);
}
echo "flush-status=202\n";

$httpCalls = [];
$httpTransport = new HttpTransport(
    'https://example.invalid/logbrew-intake',
    ['x-logbrew-smoke' => 'packagist'],
    1.0,
    static function (string $endpoint, mixed $context) use (&$httpCalls): TransportResponse {
        $httpCalls[] = [$endpoint, $context];
        return new TransportResponse(202, 1);
    }
);
$httpClient = LogBrewClient::create('LOGBREW_API_KEY', 'packagist-public-http-smoke', $version);
$httpClient->log('evt_packagist_http', '2026-06-02T10:00:07Z', [
    'message' => 'HTTP transport callback smoke',
    'level' => 'info',
]);
$httpResponse = $httpClient->flush($httpTransport);
if ($httpResponse->statusCode !== 202 || count($httpCalls) !== 1 || $httpCalls[0][0] !== 'https://example.invalid/logbrew-intake') {
    fwrite(STDERR, "HTTP transport callback was not used\n");
    exit(1);
}

$psrClient = LogBrewClient::create('LOGBREW_API_KEY', 'packagist-public-psr-smoke', $version);
$psrLogger = new LogBrewPsrLogger(
    $psrClient,
    loggerName: 'packagist-psr',
    eventIdPrefix: 'evt_packagist_psr',
    timestampProvider: static fn (): DateTimeImmutable => new DateTimeImmutable('2026-06-02T10:00:08Z')
);
$psrLogger->log(LogLevel::WARNING, 'PSR smoke {cart}', ['cart' => 'cart_123', 'nested' => ['drop']]);
$psrPreview = $psrClient->previewJson();
foreach ([
    '"logger": "packagist-psr"',
    '"message": "PSR smoke cart_123"',
    '"context.cart": "cart_123"',
] as $needle) {
    if (!str_contains($psrPreview, $needle)) {
        fwrite(STDERR, "PSR logger preview missing {$needle}\n");
        exit(1);
    }
}
if (str_contains($psrPreview, 'nested')) {
    fwrite(STDERR, "PSR logger retained nested context metadata\n");
    exit(1);
}

$monologClient = LogBrewClient::create('LOGBREW_API_KEY', 'packagist-public-monolog-smoke', $version);
$monolog = new Logger('packagist-monolog');
$monolog->pushHandler(new LogBrewMonologHandler(
    $monologClient,
    loggerName: 'packagist-monolog',
    eventIdPrefix: 'evt_packagist_monolog',
    timestampProvider: static fn (): DateTimeImmutable => new DateTimeImmutable('2026-06-02T10:00:09Z')
));
$monolog->warning('Monolog smoke {cart}', ['cart' => 'cart_456', 'nested' => ['drop']]);
$monologPreview = $monologClient->previewJson();
foreach ([
    '"logger": "packagist-monolog"',
    '"message": "Monolog smoke cart_456"',
    '"context.cart": "cart_456"',
] as $needle) {
    if (!str_contains($monologPreview, $needle)) {
        fwrite(STDERR, "Monolog preview missing {$needle}\n");
        exit(1);
    }
}
if (str_contains($monologPreview, 'nested')) {
    fwrite(STDERR, "Monolog handler retained nested context metadata\n");
    exit(1);
}

echo "php public Packagist install smoke passed for logbrew/sdk {$version}\n";
PHP
