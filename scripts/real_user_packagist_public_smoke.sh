#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:-${LOGBREW_PACKAGIST_VERSION:-0.1.2}}"
tmp_dir="$(mktemp -d)"
receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"
trap 'rm -rf "$tmp_dir"' EXIT

receipt_failure() {
  echo "Packagist release receipt failed" >&2
}

export COMPOSER_HOME="$tmp_dir/composer-home"
export COMPOSER_CACHE_DIR="$tmp_dir/composer-cache"
export COMPOSER_ROOT_VERSION="1.0.0"
export LOGBREW_PACKAGIST_INSTALLED_VERSION="$version"

run_receipt_smoke() {
  local bound="$tmp_dir/receipt-artifacts"
  local extracted="$tmp_dir/receipt-source"
  local metadata="$tmp_dir/receipt-metadata.json"
  python3 "$repo_root/scripts/release_artifact_receipt.py" bind \
    --family "packagist" --output-dir "$bound" --metadata "$metadata" \
    >"$tmp_dir/receipt-bind.out" 2>"$tmp_dir/receipt-bind.err"
  python3 "$repo_root/scripts/release_artifact_receipt.py" extract \
    --family "packagist" --metadata "$metadata" --index 0 --output-dir "$extracted" \
    >"$tmp_dir/receipt-extract.out" 2>"$tmp_dir/receipt-extract.err"
  local package_root
  package_root="$(python3 - "$extracted" <<'PY'
import json
import sys
from pathlib import Path

extracted = Path(sys.argv[1])
roots = list(extracted.iterdir())
if len(roots) != 1 or not roots[0].is_dir():
    raise SystemExit(1)
package_root = roots[0]
manifest = package_root / "composer.json"
try:
    payload = json.loads(manifest.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    raise SystemExit(1)
if payload.get("name") != "logbrew/sdk" or payload.get("type") != "library":
    raise SystemExit(1)
if payload.get("autoload") != {"psr-4": {"LogBrew\\": "php/logbrew-php/src/"}}:
    raise SystemExit(1)
source = package_root / "php" / "logbrew-php" / "src"
if not source.is_dir() or not (source / "LogBrewClient.php").is_file():
    raise SystemExit(1)
print(package_root)
PY
)"
  mkdir -p "$tmp_dir/receipt-app"
  cd "$tmp_dir/receipt-app"
  composer init --name logbrew/release-receipt --type project --no-interaction --quiet
  RECEIPT_PACKAGE_ROOT="$package_root" RECEIPT_VERSION="$version" python3 \
    > "$tmp_dir/receipt-package.json" <<'PY'
import json
import os

version = os.environ["RECEIPT_VERSION"]
print(json.dumps({
    "type": "path",
    "url": os.environ["RECEIPT_PACKAGE_ROOT"],
    "options": {
        "symlink": False,
        "versions": {"logbrew/sdk": version},
    },
}, separators=(",", ":")))
PY
  composer config --json repositories.receipt "$(cat "$tmp_dir/receipt-package.json")"
  composer require "logbrew/sdk:${version}" --no-interaction --prefer-dist --no-progress \
    >"$tmp_dir/receipt-install.out" 2>"$tmp_dir/receipt-install.err"
  [[ ! -L vendor/logbrew/sdk ]]
  cmp "$package_root/composer.json" "vendor/logbrew/sdk/composer.json"
  cmp "$package_root/php/logbrew-php/src/LogBrewClient.php" \
    "vendor/logbrew/sdk/php/logbrew-php/src/LogBrewClient.php"
  php >"$tmp_dir/receipt-run.out" 2>"$tmp_dir/receipt-run.err" <<'PHP'
<?php
declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';
use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;

$client = LogBrewClient::create('key', 'receipt', '0.1.0');
$client->log('event', '2026-01-01T00:00:00Z', ['message' => 'ok', 'level' => 'info']);
$response = $client->shutdown(RecordingTransport::alwaysAccept());
if ($response->statusCode !== 202) {
    exit(1);
}
PHP
  python3 "$repo_root/scripts/release_artifact_receipt.py" attest \
    --family "packagist" --metadata "$metadata"
}

if [[ "$receipt_mode" == "1" ]]; then
  trap receipt_failure ERR
  run_receipt_smoke
  exit 0
fi

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

$version = getenv('LOGBREW_PACKAGIST_INSTALLED_VERSION') ?: '0.1.2';
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
