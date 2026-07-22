#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
attempted_events="${LOGBREW_PHP_PERSISTENT_EVENTS:-1500}"

if [[ ! "$attempted_events" =~ ^[0-9]+$ ]] || ((attempted_events < 1001 || attempted_events > 100000)); then
  printf '%s\n' "LOGBREW_PHP_PERSISTENT_EVENTS must be an integer from 1001 through 100000" >&2
  exit 1
fi

tmp_root="$(mktemp -d)"
tmp_dir="$(cd "$tmp_root" && pwd -P)"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}

trap cleanup EXIT
chmod 700 "$tmp_dir"

export COMPOSER_HOME="$tmp_dir/composer-home"
export COMPOSER_CACHE_DIR="$tmp_dir/composer-cache"

archive_src="$tmp_dir/logbrew-php"
artifacts_dir="$tmp_dir/artifacts"
app_dir="$tmp_dir/app"
queue_dir="$tmp_dir/persistent-queue"
key_file="$tmp_dir/persistence.key"
mkdir -p "$artifacts_dir" "$app_dir" "$COMPOSER_HOME" "$COMPOSER_CACHE_DIR"
chmod 700 "$artifacts_dir" "$app_dir"
php -r "file_put_contents(\$argv[1], random_bytes(32));" "$key_file"
chmod 600 "$key_file"

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
test -f "$artifacts_dir/logbrew-sdk.zip"

cd "$app_dir"
composer init --name=smoke/php-persistent-delivery --type=project --stability=stable --license=proprietary --no-interaction --quiet
composer config version 0.1.0 --no-interaction
composer config prefer-stable true --no-interaction
composer config repositories.artifacts artifact "$artifacts_dir" --no-interaction
composer require logbrew/sdk:0.1.0 --no-interaction --quiet
composer validate --no-check-publish --no-check-version --strict >/dev/null

cat >"$tmp_dir/check-installed.php" <<'PHP'
<?php

declare(strict_types=1);

require 'vendor/autoload.php';

if (!class_exists(LogBrew\EncryptedFileEventStore::class)) {
    fwrite(STDERR, "installed encrypted event store is unavailable\n");
    exit(1);
}
$create = new ReflectionMethod(LogBrew\LogBrewClient::class, 'create');
$parameterNames = array_map(
    static fn (ReflectionParameter $parameter): string => $parameter->getName(),
    $create->getParameters()
);
if (!in_array('eventStore', $parameterNames, true)) {
    fwrite(STDERR, "installed client eventStore option is unavailable\n");
    exit(1);
}
if (!method_exists(LogBrew\LogBrewClient::class, 'purgePersistedEvents')) {
    fwrite(STDERR, "installed purge API is unavailable\n");
    exit(1);
}
PHP
php "$tmp_dir/check-installed.php"

composer remove logbrew/sdk --no-interaction --quiet
cat >"$tmp_dir/check-removed.php" <<'PHP'
<?php

declare(strict_types=1);

require 'vendor/autoload.php';
if (class_exists(LogBrew\EncryptedFileEventStore::class)) {
    fwrite(STDERR, "removed persistent store remained importable\n");
    exit(1);
}
PHP
php "$tmp_dir/check-removed.php"
composer require logbrew/sdk:0.1.0 --no-interaction --quiet

cat >"$app_dir/worker.php" <<'PHP'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\EncryptedFileEventStore;
use LogBrew\HttpTransport;
use LogBrew\LogBrewClient;
use LogBrew\SdkError;

$mode = (string) getenv('SMOKE_MODE');
$queueDirectory = (string) getenv('SMOKE_QUEUE_DIRECTORY');
$keyFile = (string) getenv('SMOKE_KEY_FILE');
$resultFile = (string) getenv('SMOKE_RESULT_FILE');
$attempted = (int) getenv('SMOKE_ATTEMPTED_EVENTS');
$endpoint = (string) getenv('SMOKE_ENDPOINT');
$key = file_get_contents($keyFile);
if (!is_string($key) || strlen($key) !== 32) {
    throw new RuntimeException('persistence key is unavailable');
}

if ($mode === 'seed') {
    $drops = 0;
    $store = EncryptedFileEventStore::open($queueDirectory, $key);
    $client = makeClient($store, 100, 0, static function () use (&$drops): void {
        $drops++;
    });
    captureRange($client, 0, $attempted);
    writeResult($resultFile, [
        'attempted' => $attempted,
        'pending' => $client->pendingEvents(),
        'pendingBytes' => $client->pendingEventBytes(),
        'dropped' => $client->droppedEvents(),
        'dropCallbacks' => $drops,
    ]);
    $store->close();
    exit(0);
}

if ($mode === 'fail') {
    $store = EncryptedFileEventStore::open($queueDirectory, $key);
    $client = makeClient($store, 100, 0);
    if ($client->pendingEvents() !== 1000) {
        throw new RuntimeException('seeded queue did not recover');
    }
    $code = null;
    try {
        $client->flush(new HttpTransport(endpoint: $endpoint, timeout: 5.0));
    } catch (SdkError $error) {
        $code = $error->codeName;
    }
    if ($code !== 'transport_error' || $client->pendingEvents() !== 900) {
        throw new RuntimeException('partial failure did not retain the expected suffix');
    }
    captureRange($client, $attempted, 100);
    writeResult($resultFile, [
        'code' => $code,
        'pending' => $client->pendingEvents(),
        'pendingBytes' => $client->pendingEventBytes(),
    ]);
    $store->close();
    exit(0);
}

if ($mode === 'recover') {
    $store = EncryptedFileEventStore::open($queueDirectory, $key);
    $client = makeClient($store, 200, 1, null, 'php-persistent-upgraded', '0.2.0');
    if ($client->pendingEvents() !== 1000) {
        throw new RuntimeException('failed suffix and later capture did not recover');
    }
    $response = $client->shutdown(new HttpTransport(endpoint: $endpoint, timeout: 5.0));
    writeResult($resultFile, [
        'status' => $response->statusCode,
        'attempts' => $response->attempts,
        'batches' => $response->batches,
        'pending' => $client->pendingEvents(),
    ]);
    exit(0);
}

if ($mode === 'verify') {
    $store = EncryptedFileEventStore::open($queueDirectory, $key);
    $client = makeClient($store, 100, 0);
    if ($client->pendingEvents() !== 0) {
        throw new RuntimeException('accepted queue replayed after clean shutdown');
    }
    $client->log('evt_purge_proof', '2026-07-14T09:00:00Z', [
        'message' => 'explicit local discard',
        'level' => 'info',
    ]);
    $client->purgePersistedEvents();
    if ($client->pendingEvents() !== 0) {
        throw new RuntimeException('explicit purge retained memory state');
    }
    $store->close();
    unset($client, $store);

    $store = EncryptedFileEventStore::open($queueDirectory, $key);
    $client = makeClient($store, 100, 0);
    if ($client->pendingEvents() !== 0) {
        throw new RuntimeException('explicit purge retained disk state');
    }
    $store->close();

    $defaultPath = dirname($queueDirectory) . '/default-must-not-exist';
    $defaultClient = LogBrewClient::create('LOGBREW_API_KEY', 'php-persistent-proof', '0.1.0');
    $defaultClient->log('evt_default_memory', '2026-07-14T09:00:01Z', [
        'message' => 'memory only',
        'level' => 'info',
    ]);
    if (file_exists($defaultPath)) {
        throw new RuntimeException('default client created persistence state');
    }
    writeResult($resultFile, ['pending' => 0, 'purged' => true, 'defaultMemoryOnly' => true]);
    exit(0);
}

throw new RuntimeException('unknown worker mode');

function makeClient(
    EncryptedFileEventStore $store,
    int $maxBatchEvents,
    int $maxRetries,
    ?callable $onEventDropped = null,
    string $sdkName = 'php-persistent-proof',
    string $sdkVersion = '0.1.0'
): LogBrewClient {
    return LogBrewClient::create(
        apiKey: 'LOGBREW_API_KEY',
        sdkName: $sdkName,
        sdkVersion: $sdkVersion,
        maxRetries: $maxRetries,
        maxQueueSize: 1000,
        maxQueueBytes: 4 * 1024 * 1024,
        onEventDropped: $onEventDropped,
        maxBatchEvents: $maxBatchEvents,
        maxBatchBytes: 256 * 1024,
        eventStore: $store
    );
}

function captureRange(LogBrewClient $client, int $start, int $count): void
{
    for ($index = $start; $index < $start + $count; $index++) {
        $client->log(sprintf('evt_php_persistent_%05d', $index), '2026-07-14T09:00:00Z', [
            'message' => 'persistent worker event',
            'level' => 'info',
            'metadata' => ['sequence' => $index],
        ]);
    }
}

/** @param array<string, mixed> $result */
function writeResult(string $path, array $result): void
{
    $encoded = json_encode($result, JSON_THROW_ON_ERROR);
    if (file_put_contents($path, $encoded) !== strlen($encoded) || !chmod($path, 0600)) {
        throw new RuntimeException('proof result could not be written');
    }
}
PHP

cat >"$tmp_dir/intake-server.php" <<'PHP'
<?php

declare(strict_types=1);

$directory = $argv[1];
$statuses = array_map('intval', explode(',', $argv[2]));
$server = stream_socket_server('tcp://127.0.0.1:0', $errorCode, $errorMessage);
if ($server === false) {
    file_put_contents($directory . '/error.txt', sprintf('%d %s', $errorCode, $errorMessage));
    exit(1);
}
$socketName = stream_socket_get_name($server, false);
if (!is_string($socketName)) {
    file_put_contents($directory . '/error.txt', 'socket name unavailable');
    exit(1);
}
file_put_contents($directory . '/endpoint.txt', 'http://' . $socketName . '/v1/events');

foreach ($statuses as $index => $status) {
    $connection = stream_socket_accept($server, 20);
    if ($connection === false) {
        file_put_contents($directory . '/error.txt', 'request timeout');
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
    file_put_contents(sprintf('%s/request-%02d.head', $directory, $index), $head);
    file_put_contents(sprintf('%s/request-%02d.body', $directory, $index), $body);
    file_put_contents(sprintf('%s/request-%02d.status', $directory, $index), (string) $status);
    $reason = $status === 202 ? 'Accepted' : 'Service Unavailable';
    fwrite($connection, "HTTP/1.1 {$status} {$reason}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    fclose($connection);
}
fclose($server);
PHP

run_worker() {
  local mode="$1"
  local result_file="$2"
  local endpoint="${3:-}"
  SMOKE_MODE="$mode" \
  SMOKE_QUEUE_DIRECTORY="$queue_dir" \
  SMOKE_KEY_FILE="$key_file" \
  SMOKE_RESULT_FILE="$result_file" \
  SMOKE_ATTEMPTED_EVENTS="$attempted_events" \
  SMOKE_ENDPOINT="$endpoint" \
    php "$app_dir/worker.php"
}

start_server() {
  local directory="$1"
  local statuses="$2"
  mkdir -p "$directory"
  chmod 700 "$directory"
  php "$tmp_dir/intake-server.php" "$directory" "$statuses" \
    >"$directory/server.stdout" 2>"$directory/server.stderr" &
  server_pid="$!"
  for _ in {1..200}; do
    [[ -s "$directory/endpoint.txt" ]] && return 0
    [[ -s "$directory/error.txt" ]] && return 1
    sleep 0.01
  done
  return 1
}

wait_server() {
  wait "$server_pid"
  server_pid=""
}

seed_result="$tmp_dir/seed-result.json"
run_worker seed "$seed_result"

cat >"$tmp_dir/verify-seed.php" <<'PHP'
<?php

declare(strict_types=1);

$queueDirectory = $argv[1];
$keyFile = $argv[2];
$result = json_decode((string) file_get_contents($argv[3]), true, 512, JSON_THROW_ON_ERROR);
$attempted = (int) $argv[4];
if (
    !is_array($result)
    || ($result['attempted'] ?? null) !== $attempted
    || ($result['pending'] ?? null) !== 1000
    || ($result['dropped'] ?? null) !== $attempted - 1000
    || ($result['dropCallbacks'] ?? null) !== $attempted - 1000
    || !is_int($result['pendingBytes'] ?? null)
    || $result['pendingBytes'] <= 0
    || $result['pendingBytes'] > 4 * 1024 * 1024
) {
    throw new RuntimeException('seed result mismatch');
}
if ((fileperms($queueDirectory) & 0777) !== 0700) {
    throw new RuntimeException('queue directory permissions changed');
}
$entries = scandir($queueDirectory);
if (!is_array($entries)) {
    throw new RuntimeException('queue directory unavailable');
}
$eventFiles = [];
foreach ($entries as $entry) {
    if (preg_match('/^[0-9]{20}\.event$/D', $entry) === 1) {
        $eventFiles[] = $entry;
    }
}
if (count($eventFiles) !== 1000 || array_diff($entries, ['.', '..', '.lock'], $eventFiles) !== []) {
    throw new RuntimeException('seeded queue entries changed');
}
$key = file_get_contents($keyFile);
if (!is_string($key) || strlen($key) !== 32) {
    throw new RuntimeException('proof key unavailable');
}
foreach ($eventFiles as $eventFile) {
    $path = $queueDirectory . '/' . $eventFile;
    if ((fileperms($path) & 0777) !== 0600) {
        throw new RuntimeException('event file permissions changed');
    }
    $bytes = file_get_contents($path);
    if (!is_string($bytes)) {
        throw new RuntimeException('event file unavailable');
    }
    foreach (['LOGBREW_API_KEY', 'evt_php_persistent_', 'persistent worker event', $key] as $forbidden) {
        if (str_contains($bytes, $forbidden)) {
            throw new RuntimeException('persistent plaintext boundary failed');
        }
    }
}
PHP
php "$tmp_dir/verify-seed.php" "$queue_dir" "$key_file" "$seed_result" "$attempted_events"

intake_fail="$tmp_dir/intake-fail"
start_server "$intake_fail" '202,503'
fail_endpoint="$(cat "$intake_fail/endpoint.txt")"
fail_result="$tmp_dir/fail-result.json"
run_worker fail "$fail_result" "$fail_endpoint"
wait_server

intake_recover="$tmp_dir/intake-recover"
start_server "$intake_recover" '503,202,202,202,202,202,202'
recover_endpoint="$(cat "$intake_recover/endpoint.txt")"
recover_result="$tmp_dir/recover-result.json"
run_worker recover "$recover_result" "$recover_endpoint"
wait_server

cmp "$intake_fail/request-01.body" "$intake_recover/request-00.body"
cmp "$intake_recover/request-00.body" "$intake_recover/request-01.body"

verify_result="$tmp_dir/verify-result.json"
run_worker verify "$verify_result"

cat >"$tmp_dir/verify-proof.php" <<'PHP'
<?php

declare(strict_types=1);

$failDirectory = $argv[1];
$recoverDirectory = $argv[2];
$fail = json_decode((string) file_get_contents($argv[3]), true, 512, JSON_THROW_ON_ERROR);
$recover = json_decode((string) file_get_contents($argv[4]), true, 512, JSON_THROW_ON_ERROR);
$verify = json_decode((string) file_get_contents($argv[5]), true, 512, JSON_THROW_ON_ERROR);
$attempted = (int) $argv[6];
if (($fail['code'] ?? null) !== 'transport_error' || ($fail['pending'] ?? null) !== 1000) {
    throw new RuntimeException('partial failure summary mismatch');
}
if (
    ($recover['status'] ?? null) !== 202
    || ($recover['attempts'] ?? null) !== 7
    || ($recover['batches'] ?? null) !== 6
    || ($recover['pending'] ?? null) !== 0
) {
    throw new RuntimeException('recovery summary mismatch');
}
if (($verify['pending'] ?? null) !== 0 || ($verify['purged'] ?? null) !== true || ($verify['defaultMemoryOnly'] ?? null) !== true) {
    throw new RuntimeException('empty/purge summary mismatch');
}

$acceptedBodies = [(string) file_get_contents($failDirectory . '/request-00.body')];
for ($index = 1; $index <= 6; $index++) {
    $acceptedBodies[] = (string) file_get_contents(sprintf('%s/request-%02d.body', $recoverDirectory, $index));
}
$ids = [];
foreach ($acceptedBodies as $body) {
    $payload = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($payload['events'] ?? null)) {
        throw new RuntimeException('accepted body lacks events');
    }
    foreach ($payload['events'] as $event) {
        if (!is_array($event) || !is_string($event['id'] ?? null)) {
            throw new RuntimeException('accepted event id unavailable');
        }
        $ids[] = $event['id'];
    }
}
if (count($ids) !== 1100 || count(array_unique($ids)) !== 1100) {
    throw new RuntimeException('accepted event set is not unique and complete');
}
for ($index = 0; $index < 1000; $index++) {
    if (!in_array(sprintf('evt_php_persistent_%05d', $index), $ids, true)) {
        throw new RuntimeException('seeded accepted event is missing');
    }
}
for ($index = $attempted; $index < $attempted + 100; $index++) {
    if (!in_array(sprintf('evt_php_persistent_%05d', $index), $ids, true)) {
        throw new RuntimeException('later accepted event is missing');
    }
}
$retryPayload = json_decode((string) file_get_contents($recoverDirectory . '/request-01.body'), true, 512, JSON_THROW_ON_ERROR);
$upgradedPayload = json_decode((string) file_get_contents($recoverDirectory . '/request-02.body'), true, 512, JSON_THROW_ON_ERROR);
if (
    !is_array($retryPayload['sdk'] ?? null)
    || ($retryPayload['sdk']['name'] ?? null) !== 'php-persistent-proof'
    || ($retryPayload['sdk']['version'] ?? null) !== '0.1.0'
    || !is_array($upgradedPayload['sdk'] ?? null)
    || ($upgradedPayload['sdk']['name'] ?? null) !== 'php-persistent-upgraded'
    || ($upgradedPayload['sdk']['version'] ?? null) !== '0.2.0'
) {
    throw new RuntimeException('restart SDK identity boundary changed');
}

foreach ([$failDirectory => 2, $recoverDirectory => 7] as $directory => $requests) {
    for ($index = 0; $index < $requests; $index++) {
        $head = (string) file_get_contents(sprintf('%s/request-%02d.head', $directory, $index));
        if (
            preg_match_all('/^authorization:\s*Bearer LOGBREW_API_KEY\r?$/mi', $head) !== 1
            || preg_match_all('/^content-type:\s*application\/json\r?$/mi', $head) !== 1
            || !str_starts_with($head, "POST /v1/events HTTP/")
        ) {
            throw new RuntimeException('installed HTTP boundary changed');
        }
    }
}
PHP
php "$tmp_dir/verify-proof.php" \
  "$intake_fail" \
  "$intake_recover" \
  "$fail_result" \
  "$recover_result" \
  "$verify_result" \
  "$attempted_events"

printf 'php installed persistent delivery proof passed: attempted=%d retained=1000 dropped=%d accepted=1100 requests=9 retries=2 encrypted=yes upgrade=yes purged=yes\n' \
  "$attempted_events" \
  "$((attempted_events - 1000))"
