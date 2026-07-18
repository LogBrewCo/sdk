#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
load_events="${LOGBREW_PHP_LOAD_EVENTS:-1500}"

if [[ ! "$load_events" =~ ^[0-9]+$ ]] || ((load_events < 1001 || load_events > 100000)); then
  printf '%s\n' "LOGBREW_PHP_LOAD_EVENTS must be an integer from 1001 through 100000" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

archive_src="$tmp_dir/logbrew-php"
artifacts_dir="$tmp_dir/artifacts"
app_dir="$tmp_dir/app"
intake_dir="$tmp_dir/intake"
export COMPOSER_HOME="$tmp_dir/composer-home"
export COMPOSER_CACHE_DIR="$tmp_dir/composer-cache"
mkdir -p "$artifacts_dir" "$app_dir" "$intake_dir" "$COMPOSER_HOME" "$COMPOSER_CACHE_DIR"
cp -R "$repo_root/php/logbrew-php" "$archive_src"
rm -rf "$archive_src/vendor" "$archive_src/composer.lock"

cat > "$tmp_dir/version-archive.php" <<'PHP'
<?php

declare(strict_types=1);

$path = $argv[1];
$data = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
$data["version"] = "0.1.0";
file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL);
PHP
php "$tmp_dir/version-archive.php" "$archive_src/composer.json"

(
  cd "$archive_src"
  composer archive --format=zip --dir "$artifacts_dir" --file logbrew-sdk --quiet
)

archive_path="$artifacts_dir/logbrew-sdk.zip"
test -f "$archive_path"

cd "$app_dir"
composer init --name=smoke/php-backpressure --type=project --stability=stable --license=proprietary --no-interaction --quiet
composer config version 0.1.0 --no-interaction
composer config prefer-stable true --no-interaction
composer config repositories.artifacts artifact "$artifacts_dir" --no-interaction
composer require logbrew/sdk:0.1.0 --no-interaction --quiet
composer validate --no-check-publish --no-check-version --strict >/dev/null

php -r '
require "vendor/autoload.php";
if (!class_exists(LogBrew\LogBrewClient::class) || !class_exists(LogBrew\DroppedEvent::class)) {
    fwrite(STDERR, "installed queue API is unavailable\n");
    exit(1);
}
'

composer remove logbrew/sdk --no-interaction --quiet
php -r '
require "vendor/autoload.php";
if (class_exists(LogBrew\LogBrewClient::class)) {
    fwrite(STDERR, "removed package remained importable\n");
    exit(1);
}
'
composer require logbrew/sdk:0.1.0 --no-interaction --quiet

cat > "$intake_dir/server.php" <<'PHP'
<?php

declare(strict_types=1);

$dir = $argv[1];
$statuses = array_map('intval', explode(',', $argv[2]));
$server = stream_socket_server('tcp://127.0.0.1:0', $errorCode, $errorMessage);
if ($server === false) {
    file_put_contents($dir . '/error.txt', sprintf('%d %s', $errorCode, $errorMessage));
    exit(1);
}
$socketName = stream_socket_get_name($server, false);
if (!is_string($socketName)) {
    file_put_contents($dir . '/error.txt', 'socket name unavailable');
    exit(1);
}
file_put_contents($dir . '/endpoint.txt', 'http://' . $socketName . '/v1/events');

foreach ($statuses as $index => $status) {
    $connection = stream_socket_accept($server, 20);
    if ($connection === false) {
        file_put_contents($dir . '/error.txt', 'request timeout');
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

    $reason = $status === 503 ? 'Service Unavailable' : 'Accepted';
    fwrite($connection, "HTTP/1.1 {$status} {$reason}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    fclose($connection);
}

fclose($server);
PHP

php "$intake_dir/server.php" "$intake_dir" "503,202,202,202,202,202,202,202,202,202,202" \
  >"$intake_dir/server.stdout" 2>"$intake_dir/server.stderr" &
server_pid="$!"

for _ in {1..200}; do
  if [[ -s "$intake_dir/endpoint.txt" ]]; then
    break
  fi
  if [[ -s "$intake_dir/error.txt" ]]; then
    printf '%s\n' "local intake failed to start" >&2
    exit 1
  fi
  sleep 0.05
done
test -s "$intake_dir/endpoint.txt"

cat > "$app_dir/high-load.php" <<'PHP'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\DroppedEvent;
use LogBrew\HttpTransport;
use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\SdkError;
use LogBrew\Transport;
use LogBrew\TransportResponse;

$attempted = (int) getenv('LOGBREW_PHP_LOAD_EVENTS');
$endpoint = (string) getenv('LOGBREW_PHP_INTAKE_ENDPOINT');
$callbackCalls = 0;
$lastDrop = null;
$client = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxRetries: 1,
    onEventDropped: static function (DroppedEvent $drop) use (&$callbackCalls, &$lastDrop): void {
        $callbackCalls++;
        $lastDrop = $drop;
        if ($callbackCalls === 1) {
            throw new RuntimeException('local callback failure');
        }
    }
);
$client->release('evt_load_release', '2026-07-12T10:00:00Z', ['version' => '2.0.0']);
$client->environment('evt_load_environment', '2026-07-12T10:00:01Z', ['name' => 'production']);

for ($index = 0; $index < $attempted - 2; $index++) {
    $message = $index === 998 ? 'private-dropped-content' : 'bounded load';
    $client->log(
        sprintf('evt_load_%05d', $index),
        '2026-07-12T10:00:02Z',
        ['message' => $message, 'level' => 'info', 'metadata' => ['worker' => $index % 8]]
    );
}

$expectedDropped = $attempted - 1_000;
if ($client->pendingEvents() !== 1_000 || $client->droppedEvents() !== $expectedDropped) {
    throw new RuntimeException('unexpected retained or dropped event count');
}
if ($callbackCalls !== $expectedDropped || !$lastDrop instanceof DroppedEvent) {
    throw new RuntimeException('unexpected drop callback accounting');
}
if ($lastDrop->pendingEvents !== 1_000 || $lastDrop->reason !== 'queue_overflow') {
    throw new RuntimeException('unexpected final drop notice');
}
$pendingBytes = $client->pendingEventBytes();
if ($pendingBytes <= 0 || $pendingBytes > 4_194_304) {
    throw new RuntimeException('unexpected pending byte count');
}
$preview = $client->previewJson();
if (str_contains($preview, 'LOGBREW_API_KEY') || str_contains($preview, 'private-dropped-content')) {
    throw new RuntimeException('queued payload contains excluded data');
}

$response = $client->shutdown(new HttpTransport(endpoint: $endpoint, timeout: 2.0));
if ($response->statusCode !== 202 || $response->attempts !== 11 || $response->batches !== 10) {
    throw new RuntimeException('unexpected retry result');
}
if ($client->pendingEvents() !== 0 || $client->pendingEventBytes() !== 0) {
    throw new RuntimeException('shutdown did not clear retained queue state');
}
try {
    $client->log('evt_after_shutdown', '2026-07-12T10:00:03Z', ['message' => 'closed', 'level' => 'info']);
    throw new RuntimeException('closed client accepted an event');
} catch (SdkError $error) {
    if ($error->codeName !== 'shutdown_error') {
        throw $error;
    }
}

$oversizedReason = null;
$oversized = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueBytes: 256,
    onEventDropped: static function (DroppedEvent $drop) use (&$oversizedReason): void {
        $oversizedReason = $drop->reason;
    }
);
$oversized->log('evt_oversized', '2026-07-12T10:00:04Z', [
    'message' => str_repeat('private-oversized-content-', 100),
    'level' => 'error',
]);
if ($oversized->pendingEvents() !== 0 || $oversized->droppedEvents() !== 1 || $oversizedReason !== 'event_too_large') {
    throw new RuntimeException('oversized event contract failed');
}

$byteProbe = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$byteProbe->log('evt_byte_a', '2026-07-12T10:00:05Z', ['message' => 'espresso-☕', 'level' => 'info']);
$singleEventBody = json_encode(
    json_decode($byteProbe->previewJson(), true, 512, JSON_THROW_ON_ERROR),
    JSON_THROW_ON_ERROR
);
$byteSplit = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxBatchEvents: 10,
    maxBatchBytes: strlen($singleEventBody)
);
$byteSplit->log('evt_byte_a', '2026-07-12T10:00:05Z', ['message' => 'espresso-☕', 'level' => 'info']);
$byteSplit->log('evt_byte_b', '2026-07-12T10:00:05Z', ['message' => 'espresso-☕', 'level' => 'info']);
$byteTransport = RecordingTransport::alwaysAccept();
$byteResponse = $byteSplit->flush($byteTransport);
if ($byteResponse->batches !== 2
    || count($byteTransport->sentBodies) !== 2
    || array_map('strlen', $byteTransport->sentBodies) !== [strlen($singleEventBody), strlen($singleEventBody)]) {
    throw new RuntimeException('installed exact-byte split contract failed');
}

$inflight = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$inflight->log('evt_inflight_original', '2026-07-12T10:00:06Z', ['message' => 'original', 'level' => 'info']);
$inflightTransport = new class($inflight) implements Transport {
    public ?string $reentrantFlushCode = null;

    public function __construct(private readonly LogBrewClient $client)
    {
    }

    public function send(string $apiKey, string $body): TransportResponse
    {
        $this->client->log('evt_inflight_later', '2026-07-12T10:00:07Z', ['message' => 'later', 'level' => 'info']);
        try {
            $this->client->flush(RecordingTransport::alwaysAccept());
        } catch (SdkError $error) {
            $this->reentrantFlushCode = $error->codeName;
        }
        return new TransportResponse(202, 1);
    }
};
$inflightResponse = $inflight->flush($inflightTransport);
if ($inflightResponse->batches !== 1
    || $inflight->pendingEvents() !== 1
    || $inflightTransport->reentrantFlushCode !== 'flush_error') {
    throw new RuntimeException('transport-time capture contract failed');
}
$inflight->flush(RecordingTransport::alwaysAccept());

$shutdown = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxRetries: 0);
$shutdown->log('evt_shutdown_original', '2026-07-12T10:00:08Z', ['message' => 'original', 'level' => 'info']);
$shutdownTransport = new class($shutdown) implements Transport {
    public ?string $captureCode = null;

    public function __construct(private readonly LogBrewClient $client)
    {
    }

    public function send(string $apiKey, string $body): TransportResponse
    {
        try {
            $this->client->log('evt_shutdown_blocked', '2026-07-12T10:00:09Z', ['message' => 'blocked', 'level' => 'info']);
        } catch (SdkError $error) {
            $this->captureCode = $error->codeName;
        }
        return new TransportResponse(500, 1);
    }
};
try {
    $shutdown->shutdown($shutdownTransport);
    throw new RuntimeException('failed shutdown unexpectedly succeeded');
} catch (SdkError $error) {
    if ($error->codeName !== 'transport_error') {
        throw $error;
    }
}
$shutdown->log('evt_shutdown_reopened', '2026-07-12T10:00:10Z', ['message' => 'reopened', 'level' => 'info']);
$shutdownRecoveryTransport = RecordingTransport::alwaysAccept();
$recoveredShutdown = $shutdown->shutdown($shutdownRecoveryTransport);
$shutdownRecoveryIds = array_map(
    static fn (string $body): array => array_column(
        json_decode($body, true, 512, JSON_THROW_ON_ERROR)['events'],
        'id'
    ),
    $shutdownRecoveryTransport->sentBodies
);
if ($shutdownTransport->captureCode !== 'shutdown_error'
    || $recoveredShutdown->batches !== 2
    || $shutdownRecoveryIds !== [['evt_shutdown_original'], ['evt_shutdown_reopened']]
    || $shutdown->pendingEvents() !== 0) {
    throw new RuntimeException('failed shutdown recovery contract failed');
}

fwrite(STDOUT, json_encode([
    'ok' => true,
    'attempted' => $attempted,
    'queued' => 1_000,
    'dropped' => $expectedDropped,
    'attempts' => $response->attempts,
    'batches' => $response->batches,
    'pendingBytesBeforeFlush' => $pendingBytes,
    'oversizedDropped' => 1,
    'byteSplitBatches' => $byteResponse->batches,
    'inflightRetained' => 1,
    'shutdownRecovered' => true,
], JSON_THROW_ON_ERROR) . PHP_EOL);
PHP

LOGBREW_PHP_LOAD_EVENTS="$load_events" \
LOGBREW_PHP_INTAKE_ENDPOINT="$(cat "$intake_dir/endpoint.txt")" \
php "$app_dir/high-load.php" >"$tmp_dir/result.json"

wait "$server_pid"
server_pid=""

cat > "$tmp_dir/verify-intake.php" <<'PHP'
<?php

declare(strict_types=1);

$dir = $argv[1];
$result = json_decode(file_get_contents($argv[2]), true, 512, JSON_THROW_ON_ERROR);
$attempted = (int) $argv[3];
if (($result["ok"] ?? null) !== true
    || ($result["attempted"] ?? null) !== $attempted
    || ($result["queued"] ?? null) !== 1000
    || ($result["dropped"] ?? null) !== $attempted - 1000
    || ($result["attempts"] ?? null) !== 11
    || ($result["batches"] ?? null) !== 10
    || ($result["oversizedDropped"] ?? null) !== 1
    || ($result["byteSplitBatches"] ?? null) !== 2
    || ($result["inflightRetained"] ?? null) !== 1
    || ($result["shutdownRecovered"] ?? null) !== true) {
    fwrite(STDERR, "unexpected installed high-load result\n");
    exit(1);
}
$failed = file_get_contents($dir . "/request-0.body");
$retried = file_get_contents($dir . "/request-1.body");
if (!is_string($failed) || !is_string($retried) || $failed === "" || $failed !== $retried) {
    fwrite(STDERR, "retry bodies differ\n");
    exit(1);
}
$acceptedEvents = [];
for ($index = 0; $index < 11; $index++) {
    $body = file_get_contents(sprintf("%s/request-%d.body", $dir, $index));
    if (!is_string($body)
        || $body === ""
        || strlen($body) > 262144
        || str_contains($body, "LOGBREW_API_KEY")
        || str_contains($body, "private-dropped-content")
        || str_contains($body, "private-oversized-content")) {
        fwrite(STDERR, "installed payload violated byte or privacy bounds\n");
        exit(1);
    }
    $payload = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    $sdk = $payload["sdk"] ?? null;
    $events = $payload["events"] ?? null;
    if (!is_array($sdk)
        || ($sdk["name"] ?? null) !== "logbrew-php"
        || ($sdk["language"] ?? null) !== "php"
        || ($sdk["version"] ?? null) !== "0.1.0"
        || !is_array($events)
        || count($events) < 1
        || count($events) > 100) {
        fwrite(STDERR, "unexpected installed SDK identity or batch event count\n");
        exit(1);
    }
    if ($index > 0) {
        array_push($acceptedEvents, ...$events);
    }
    $head = file_get_contents(sprintf("%s/request-%d.head", $dir, $index));
    if (!is_string($head)
        || stripos($head, "authorization: Bearer LOGBREW_API_KEY") === false
        || stripos($head, "content-type: application/json") === false) {
        fwrite(STDERR, "installed request headers are incomplete\n");
        exit(1);
    }
}
if (count($acceptedEvents) !== 1000
    || ($acceptedEvents[0]["type"] ?? null) !== "release"
    || ($acceptedEvents[0]["attributes"]["version"] ?? null) !== "2.0.0"
    || ($acceptedEvents[1]["type"] ?? null) !== "environment"
    || ($acceptedEvents[1]["attributes"]["name"] ?? null) !== "production"
    || ($acceptedEvents[2]["type"] ?? null) !== "log"
    || ($acceptedEvents[2]["attributes"]["message"] ?? null) !== "bounded load"
    || ($acceptedEvents[2]["attributes"]["metadata"]["worker"] ?? null) !== 0) {
    fwrite(STDERR, "installed batches lost event count, context, or representative attributes\n");
    exit(1);
}
$expectedIds = ["evt_load_release", "evt_load_environment"];
for ($index = 0; $index < 998; $index++) {
    $expectedIds[] = sprintf("evt_load_%05d", $index);
}
if (array_column($acceptedEvents, "id") !== $expectedIds) {
    fwrite(STDERR, "installed batches changed event order\n");
    exit(1);
}
PHP
php "$tmp_dir/verify-intake.php" "$intake_dir" "$tmp_dir/result.json" "$load_events"

composer show logbrew/sdk --format=json >"$tmp_dir/composer-show.json"
cat > "$tmp_dir/verify-package.php" <<'PHP'
<?php

declare(strict_types=1);

$package = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($package["name"] ?? null) !== "logbrew/sdk" || ($package["versions"][0] ?? null) !== "0.1.0") {
    fwrite(STDERR, "unexpected installed package metadata\n");
    exit(1);
}
PHP
php "$tmp_dir/verify-package.php" "$tmp_dir/composer-show.json"

printf 'php installed batched high-load smoke passed (%d attempted, 1000 queued, %d dropped, 10 batches, 11 attempts)\n' \
  "$load_events" "$((load_events - 1000))"
