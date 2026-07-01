#!/usr/bin/env bash
set -euo pipefail

version="${1:-${LOGBREW_PACKAGIST_VERSION:-0.1.0}}"
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
use LogBrew\LogBrewPsrLogger;
use LogBrew\RecordingTransport;
use LogBrew\TransportResponse;
use Monolog\Logger;
use Psr\Log\LogLevel;

$version = getenv('LOGBREW_PACKAGIST_INSTALLED_VERSION') ?: '0.1.0';
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
    RecordingTransport::class,
    HttpTransport::class,
    LogBrewPsrLogger::class,
    LogBrewMonologHandler::class,
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

$preview = $client->previewJson();
foreach ([
    '"type": "release"',
    '"type": "environment"',
    '"type": "log"',
    '"type": "issue"',
    '"type": "span"',
    '"type": "action"',
] as $needle) {
    if (!str_contains($preview, $needle)) {
        fwrite(STDERR, "previewJson missing {$needle}\n");
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
