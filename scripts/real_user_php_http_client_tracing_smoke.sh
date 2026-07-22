#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
server_pid=""
app_pid=""

cleanup() {
  for pid in "$app_pid" "$server_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$tmp_dir"
}

trap cleanup EXIT
chmod 700 "$tmp_dir"
export COMPOSER_HOME="$tmp_dir/composer-home"
export COMPOSER_CACHE_DIR="$tmp_dir/composer-cache"

archive_src="$tmp_dir/logbrew-php"
artifacts_dir="$tmp_dir/artifacts"
base_app_dir="$tmp_dir/base-app"
app_dir="$tmp_dir/app"
intake_dir="$tmp_dir/intake"
mkdir -p "$artifacts_dir" "$base_app_dir" "$app_dir" "$intake_dir" "$COMPOSER_HOME" "$COMPOSER_CACHE_DIR"

cp -R "$repo_root/php/logbrew-php" "$archive_src"
rm -rf "$archive_src/vendor" "$archive_src/composer.lock"
cat >"$tmp_dir/version-archive.php" <<'PHP'
<?php

declare(strict_types=1);

$path = $argv[1];
$data = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
$data['version'] = '0.1.0';
file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL);
PHP
php "$tmp_dir/version-archive.php" "$archive_src/composer.json"
(
  cd "$archive_src"
  composer archive --format=zip --dir "$artifacts_dir" --file logbrew-sdk --quiet
)
archive_path="$artifacts_dir/logbrew-sdk.zip"
test -f "$archive_path"
archive_digest="$(shasum -a 256 "$archive_path" | awk '{print $1}')"

cd "$base_app_dir"
composer init --name=smoke/php-core-install --type=project --stability=stable --license=proprietary --no-interaction --quiet
composer config version 0.1.0 --no-interaction
composer config prefer-stable true --no-interaction
composer config repositories.artifacts artifact "$artifacts_dir" --no-interaction
composer require logbrew/sdk:0.1.0 --no-interaction --quiet
composer validate --no-check-publish --no-check-version --strict >/dev/null

cat >"$tmp_dir/check-base-install.php" <<'PHP'
<?php

declare(strict_types=1);

require 'vendor/autoload.php';

foreach (['guzzlehttp/promises', 'psr/http-client', 'psr/http-message'] as $optionalPackage) {
    if (Composer\InstalledVersions::isInstalled($optionalPackage)) {
        fwrite(STDERR, "base install contains an optional HTTP package\n");
        exit(1);
    }
}
foreach ([LogBrew\LogBrewClient::class, LogBrew\RecordingTransport::class] as $coreClass) {
    if (!class_exists($coreClass)) {
        fwrite(STDERR, "base install core API is unavailable\n");
        exit(1);
    }
}
$client = LogBrew\LogBrewClient::create('lb_base_install', 'base-install', '0.1.0');
$client->log('evt_base_install', '2026-07-20T10:00:00Z', ['message' => 'base install', 'level' => 'info']);
if ($client->pendingEvents() !== 1) {
    fwrite(STDERR, "base install core API failed\n");
    exit(1);
}
PHP
php "$tmp_dir/check-base-install.php"

cd "$app_dir"
composer init --name=smoke/php-http-client-tracing --type=project --stability=stable --license=proprietary --no-interaction --quiet
composer config version 0.1.0 --no-interaction
composer config prefer-stable true --no-interaction
composer config repositories.artifacts artifact "$artifacts_dir" --no-interaction
composer require logbrew/sdk:0.1.0 guzzlehttp/guzzle:^7.9 --no-interaction --quiet
composer validate --no-check-publish --no-check-version --strict >/dev/null

cat >"$tmp_dir/check-installed.php" <<'PHP'
<?php

declare(strict_types=1);

require 'vendor/autoload.php';
foreach ([LogBrew\LogBrewHttpClientTracing::class, Psr\Http\Client\ClientInterface::class, GuzzleHttp\Promise\PromiseInterface::class] as $class) {
    if (!class_exists($class) && !interface_exists($class)) {
        fwrite(STDERR, "installed HTTP tracing API is unavailable\n");
        exit(1);
    }
}
PHP
php "$tmp_dir/check-installed.php"
composer remove logbrew/sdk --no-interaction --quiet
cat >"$tmp_dir/check-removed.php" <<'PHP'
<?php

declare(strict_types=1);

require 'vendor/autoload.php';
if (class_exists(LogBrew\LogBrewHttpClientTracing::class)) {
    fwrite(STDERR, "removed HTTP tracing API remained importable\n");
    exit(1);
}
PHP
php "$tmp_dir/check-removed.php"
composer require logbrew/sdk:0.1.0 --no-interaction --quiet

cat >"$intake_dir/server.php" <<'PHP'
<?php

declare(strict_types=1);

$dir = $argv[1];
$server = stream_socket_server('tcp://127.0.0.1:0', $errorCode, $errorMessage);
if ($server === false) {
    file_put_contents($dir . '/failed', 'startup');
    exit(1);
}
$socketName = stream_socket_get_name($server, false);
if (!is_string($socketName)) {
    file_put_contents($dir . '/failed', 'identity');
    exit(1);
}
file_put_contents($dir . '/endpoint', 'http://' . $socketName);

for ($index = 0; $index < 3; $index++) {
    $connection = stream_socket_accept($server, 20);
    if ($connection === false) {
        file_put_contents($dir . '/failed', 'accept');
        exit(1);
    }
    stream_set_timeout($connection, 5);
    $head = '';
    while (($line = fgets($connection)) !== false) {
        $head .= $line;
        if (rtrim($line, "\r\n") === '') {
            break;
        }
    }
    $contentLength = 0;
    foreach (preg_split('/\r?\n/', trim($head)) ?: [] as $line) {
        if (stripos($line, 'content-length:') === 0) {
            $contentLength = (int) trim(substr($line, strlen('content-length:')));
        }
    }
    $body = '';
    while (strlen($body) < $contentLength && !feof($connection)) {
        $chunk = fread($connection, $contentLength - strlen($body));
        if ($chunk === false || $chunk === '') {
            break;
        }
        $body .= $chunk;
    }
    file_put_contents(sprintf('%s/request-%d.head', $dir, $index), $head);
    file_put_contents(sprintf('%s/request-%d.body', $dir, $index), $body);
    $status = $index === 0 ? 204 : 202;
    $reason = $status === 204 ? 'No Content' : 'Accepted';
    fwrite($connection, "HTTP/1.1 {$status} {$reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    fclose($connection);
}

fclose($server);
PHP

php "$intake_dir/server.php" "$intake_dir" >"$intake_dir/server.stdout" 2>"$intake_dir/server.stderr" &
server_pid=$!
for _ in $(seq 1 200); do
  [[ -f "$intake_dir/endpoint" ]] && break
  if ! kill -0 "$server_pid" 2>/dev/null; then
    printf '%s\n' "PHP HTTP tracing fake intake failed" >&2
    exit 1
  fi
  sleep 0.05
done
test -f "$intake_dir/endpoint"
endpoint="$(cat "$intake_dir/endpoint")"

cat >"$app_dir/app.php" <<'PHP'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use GuzzleHttp\Client;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Request;
use LogBrew\HttpTransport;
use LogBrew\LogBrewClient;
use LogBrew\LogBrewHttpClientTracing;
use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTraceContext;

$endpoint = (string) getenv('SMOKE_ENDPOINT');
$telemetry = LogBrewClient::create('lb_smoke_http_client', 'installed-php-http-client', '0.1.0');
$baseClient = new Client(['http_errors' => false]);
$psr18 = LogBrewHttpClientTracing::wrapPsr18($baseClient, $telemetry);
$psr18 = LogBrewHttpClientTracing::wrapPsr18($psr18, $telemetry);

$parentOne = LogBrewTraceContext::fromTraceparent(
    '00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01',
    '2222222222222222'
);
$scope = LogBrewTrace::activate($parentOne);
try {
    $sync = $psr18->sendRequest(new Request(
        'POST',
        $endpoint . '/sync/account?session=do-not-record#fragment',
        ['authorization' => 'Bearer app-private', 'baggage' => 'private=value'],
        'sync-body-private'
    ));
    if (LogBrewTrace::current() !== $parentOne) {
        throw new RuntimeException('PSR-18 parent was not restored');
    }
} finally {
    $scope->close();
}

$stack = HandlerStack::create();
$stack->push(LogBrewHttpClientTracing::guzzleMiddleware($telemetry), 'logbrew-one');
$stack->push(LogBrewHttpClientTracing::guzzleMiddleware($telemetry), 'logbrew-two');
$asyncClient = new Client(['handler' => $stack, 'http_errors' => false]);
$parentTwo = LogBrewTraceContext::fromTraceparent(
    '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00',
    '3333333333333333'
);
$scope = LogBrewTrace::activate($parentTwo);
try {
    $promise = $asyncClient->requestAsync('PUT', $endpoint . '/async/account?session=do-not-record', [
        'headers' => ['authorization' => 'Bearer app-private-async', 'tracestate' => 'private=value'],
        'body' => 'async-body-private',
    ]);
    if (LogBrewTrace::current() !== $parentTwo) {
        throw new RuntimeException('Guzzle parent was not restored');
    }
} finally {
    $scope->close();
}
$async = $promise->wait();
$delivery = $telemetry->flush(new HttpTransport($endpoint . '/v1/events'));

echo json_encode([
    'syncStatus' => $sync->getStatusCode(),
    'asyncStatus' => $async->getStatusCode(),
    'deliveryStatus' => $delivery->statusCode,
    'pending' => $telemetry->pendingEvents(),
], JSON_THROW_ON_ERROR) . PHP_EOL;
PHP

SMOKE_ENDPOINT="$endpoint" php "$app_dir/app.php" >"$tmp_dir/app.stdout" 2>"$tmp_dir/app.stderr" &
app_pid=$!
for _ in $(seq 1 300); do
  kill -0 "$app_pid" 2>/dev/null || break
  sleep 0.05
done
if kill -0 "$app_pid" 2>/dev/null; then
  printf '%s\n' "PHP HTTP tracing installed app timed out" >&2
  exit 1
fi
if ! wait "$app_pid"; then
  app_pid=""
  printf '%s\n' "PHP HTTP tracing installed app failed" >&2
  exit 1
fi
app_pid=""
if ! wait "$server_pid"; then
  server_pid=""
  printf '%s\n' "PHP HTTP tracing fake intake failed" >&2
  exit 1
fi
server_pid=""

cat >"$tmp_dir/verify.php" <<'PHP'
<?php

declare(strict_types=1);

$dir = $argv[1];
$stdout = trim((string) file_get_contents($argv[2]));
$stderr = (string) file_get_contents($argv[3]);
$result = json_decode($stdout, true, 512, JSON_THROW_ON_ERROR);
if ($result !== ['syncStatus' => 204, 'asyncStatus' => 202, 'deliveryStatus' => 202, 'pending' => 0] || $stderr !== '') {
    throw new RuntimeException('installed app result mismatch');
}

$expectedParents = ['2222222222222222', '3333333333333333'];
$outgoing = [];
for ($index = 0; $index < 2; $index++) {
    $head = (string) file_get_contents(sprintf('%s/request-%d.head', $dir, $index));
    if (preg_match('/^traceparent:\s*(00-[0-9a-f]{32}-([0-9a-f]{16})-[0-9a-f]{2})\r?$/mi', $head, $matches) !== 1) {
        throw new RuntimeException('outgoing traceparent mismatch');
    }
    $outgoing[] = $matches[2];
}

$payload = json_decode((string) file_get_contents($dir . '/request-2.body'), true, 512, JSON_THROW_ON_ERROR);
$events = $payload['events'] ?? null;
if (!is_array($events) || count($events) !== 2) {
    throw new RuntimeException('installed span count mismatch');
}
$sources = [];
$parents = [];
$spanIds = [];
foreach ($events as $event) {
    if (!is_array($event) || ($event['type'] ?? null) !== 'span') {
        throw new RuntimeException('installed event type mismatch');
    }
    $attributes = $event['attributes'] ?? null;
    $metadata = is_array($attributes) ? ($attributes['metadata'] ?? null) : null;
    if (!is_array($attributes) || !is_array($metadata)) {
        throw new RuntimeException('installed span shape mismatch');
    }
    $sources[] = $metadata['source'] ?? null;
    $parents[] = $attributes['parentSpanId'] ?? null;
    $spanIds[] = $attributes['spanId'] ?? null;
    $allowed = ['host', 'method', 'sampled', 'source', 'statusCode'];
    $keys = array_keys($metadata);
    sort($allowed);
    sort($keys);
    if ($keys !== $allowed || ($metadata['host'] ?? null) !== '127.0.0.1') {
        throw new RuntimeException('installed metadata boundary mismatch');
    }
}
sort($sources);
sort($parents);
sort($spanIds);
sort($expectedParents);
sort($outgoing);
if ($sources !== ['guzzle', 'psr18'] || $parents !== $expectedParents || $spanIds !== $outgoing) {
    throw new RuntimeException('installed correlation mismatch');
}

$serialized = json_encode($payload, JSON_THROW_ON_ERROR);
foreach (['/sync/account', '/async/account', 'session=do-not-record', 'fragment', 'Bearer app-private', 'sync-body-private', 'async-body-private', 'private=value', 'traceparent', 'tracestate', 'baggage'] as $forbidden) {
    if (str_contains($serialized, $forbidden)) {
        throw new RuntimeException('installed privacy boundary mismatch');
    }
}
PHP

php "$tmp_dir/verify.php" "$intake_dir" "$tmp_dir/app.stdout" "$tmp_dir/app.stderr"
printf 'php HTTP client tracing installed smoke ok sha256:%s\n' "$archive_digest"
