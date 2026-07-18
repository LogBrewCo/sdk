#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_items="${LOGBREW_PHP_WORKER_ITEMS:-100}"
events_per_item="${LOGBREW_PHP_WORKER_EVENTS_PER_ITEM:-100}"
worker_processes="${LOGBREW_PHP_WORKER_PROCESSES:-4}"

if [[ ! "$work_items" =~ ^[1-9][0-9]*$ ]] || ((work_items < 10 || work_items > 1000)); then
  printf '%s\n' "LOGBREW_PHP_WORKER_ITEMS must be an integer from 10 through 1000" >&2
  exit 1
fi
if [[ ! "$events_per_item" =~ ^[1-9][0-9]*$ ]] || ((events_per_item < 1 || events_per_item > 100)); then
  printf '%s\n' "LOGBREW_PHP_WORKER_EVENTS_PER_ITEM must be an integer from 1 through 100" >&2
  exit 1
fi
if [[ ! "$worker_processes" =~ ^[1-9][0-9]*$ ]] || ((worker_processes < 2 || worker_processes > 8)); then
  printf '%s\n' "LOGBREW_PHP_WORKER_PROCESSES must be an integer from 2 through 8" >&2
  exit 1
fi
if ((work_items < worker_processes)); then
  printf '%s\n' "LOGBREW_PHP_WORKER_ITEMS must be at least LOGBREW_PHP_WORKER_PROCESSES" >&2
  exit 1
fi
if ((work_items % worker_processes != 0)); then
  printf '%s\n' "LOGBREW_PHP_WORKER_ITEMS must be divisible by LOGBREW_PHP_WORKER_PROCESSES" >&2
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
result_dir="$tmp_dir/results"
export COMPOSER_HOME="$tmp_dir/composer-home"
export COMPOSER_CACHE_DIR="$tmp_dir/composer-cache"
mkdir -p "$artifacts_dir" "$app_dir" "$intake_dir" "$result_dir" "$COMPOSER_HOME" "$COMPOSER_CACHE_DIR"
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

cd "$app_dir"
composer init --name=smoke/php-worker-lifecycle --type=project --stability=stable --license=proprietary --no-interaction --quiet
composer config version 0.1.0 --no-interaction
composer config prefer-stable true --no-interaction
composer config repositories.artifacts artifact "$artifacts_dir" --no-interaction
composer require logbrew/sdk:0.1.0 --no-interaction --quiet
composer validate --no-check-publish --no-check-version --strict >/dev/null

cat >"$tmp_dir/check-installed.php" <<'PHP'
<?php

declare(strict_types=1);

require "vendor/autoload.php";
foreach ([LogBrew\LogBrewWorkerLifecycle::class, LogBrew\WorkerDeliveryFailure::class] as $class) {
    if (!class_exists($class)) {
        fwrite(STDERR, "installed worker lifecycle API is unavailable\n");
        exit(1);
    }
}
PHP
php "$tmp_dir/check-installed.php"

composer remove logbrew/sdk --no-interaction --quiet
cat >"$tmp_dir/check-removed.php" <<'PHP'
<?php

declare(strict_types=1);

require "vendor/autoload.php";
if (class_exists(LogBrew\LogBrewWorkerLifecycle::class)) {
    fwrite(STDERR, "removed worker lifecycle remained importable\n");
    exit(1);
}
PHP
php "$tmp_dir/check-removed.php"
composer require logbrew/sdk:0.1.0 --no-interaction --quiet

expected_requests=$((work_items + 2))
cat >"$intake_dir/server.php" <<'PHP'
<?php

declare(strict_types=1);

$dir = $argv[1];
$expectedRequests = (int) $argv[2];
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
$retryIssued = false;

for ($index = 0; $index < $expectedRequests; $index++) {
    $connection = stream_socket_accept($server, 30);
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
    file_put_contents(sprintf('%s/request-%03d.head', $dir, $index), $head);
    file_put_contents(sprintf('%s/request-%03d.body', $dir, $index), $body);

    $status = 202;
    if (!$retryIssued && str_contains($body, '"id":"evt_load_0000_000"')) {
        $status = 503;
        $retryIssued = true;
    }
    file_put_contents(sprintf('%s/request-%03d.status', $dir, $index), (string) $status);
    $reason = $status === 503 ? 'Service Unavailable' : 'Accepted';
    fwrite($connection, "HTTP/1.1 {$status} {$reason}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    fclose($connection);
}

fclose($server);
PHP

php "$intake_dir/server.php" "$intake_dir" "$expected_requests" \
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

cat >"$app_dir/worker-proof.php" <<'PHP'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\HttpTransport;
use LogBrew\LogBrewClient;
use LogBrew\LogBrewWorkerLifecycle;
use LogBrew\SdkError;
use LogBrew\WorkerDeliveryFailure;

if (!function_exists('pcntl_fork')) {
    throw new RuntimeException('pcntl is required for the installed fork proof');
}

function waitForEvidenceFiles(string $pattern, int $expected, string $failure): void
{
    $deadline = microtime(true) + 15.0;
    while (true) {
        $files = glob($pattern);
        if (is_array($files) && count($files) === $expected) {
            return;
        }
        if (microtime(true) >= $deadline) {
            throw new RuntimeException($failure);
        }
        usleep(1_000);
    }
}

$endpoint = (string) getenv('LOGBREW_PHP_WORKER_INTAKE_ENDPOINT');
$workItems = (int) getenv('LOGBREW_PHP_WORKER_ITEMS');
$eventsPerItem = (int) getenv('LOGBREW_PHP_WORKER_EVENTS_PER_ITEM');
$workerProcesses = (int) getenv('LOGBREW_PHP_WORKER_PROCESSES');
$resultDir = (string) getenv('LOGBREW_PHP_WORKER_RESULT_DIR');
if (!is_dir($resultDir)) {
    throw new RuntimeException('worker result directory unavailable');
}
$transport = static fn (): HttpTransport => new HttpTransport(endpoint: $endpoint, timeout: 5.0);

$parentClient = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxRetries: 1);
$parentClient->log('evt_parent_before_fork', '2026-07-12T15:00:00Z', [
    'message' => 'parent retained',
    'level' => 'info',
]);
$parentLifecycle = LogBrewWorkerLifecycle::create($parentClient, $transport());
$childPids = [];
for ($worker = 0; $worker < $workerProcesses; $worker++) {
    $childPid = pcntl_fork();
    if ($childPid === -1) {
        throw new RuntimeException('child process unavailable');
    }
    if ($childPid > 0) {
        $childPids[$worker] = $childPid;
        continue;
    }

    $staleExecuted = false;
    $staleCode = null;
    try {
        $parentLifecycle->run(static function () use (&$staleExecuted): void {
            $staleExecuted = true;
        });
    } catch (SdkError $error) {
        $staleCode = $error->codeName;
    }

    $deliveryFailures = [];
    $childClient = LogBrewClient::create(
        'LOGBREW_API_KEY',
        'logbrew-php',
        '0.1.0',
        maxRetries: 1,
        maxQueueSize: $eventsPerItem,
        maxBatchEvents: $eventsPerItem,
        onEventDropped: static function (): void {
            throw new RuntimeException('child work boundary dropped telemetry');
        }
    );
    $childLifecycle = LogBrewWorkerLifecycle::create(
        $childClient,
        $transport(),
        static function (WorkerDeliveryFailure $failure) use (&$deliveryFailures): void {
            $deliveryFailures[] = $failure->codeName;
        }
    );
    file_put_contents(sprintf('%s/ready-%02d.marker', $resultDir, $worker), 'ready');
    waitForEvidenceFiles($resultDir . '/start.marker', 1, 'child start barrier timed out');
    $ownedWorkItems = 0;
    $maxPending = 0;
    for ($work = $worker; $work < $workItems; $work += $workerProcesses) {
        $workResult = $childLifecycle->run(static function () use (
            $childClient,
            $worker,
            $work,
            $eventsPerItem,
            &$maxPending
        ): int {
            for ($event = 0; $event < $eventsPerItem; $event++) {
                $childClient->log(
                    sprintf('evt_load_%04d_%03d', $work, $event),
                    '2026-07-12T15:00:01Z',
                    [
                        'message' => 'bounded worker load',
                        'level' => 'info',
                        'metadata' => ['worker' => $worker, 'work' => $work, 'event' => $event],
                    ]
                );
            }
            $maxPending = max($maxPending, $childClient->pendingEvents());
            return $work;
        });
        if ($workResult !== $work || $childClient->pendingEvents() !== 0) {
            throw new RuntimeException('child high-load work boundary failed');
        }
        $round = intdiv($work, $workerProcesses);
        file_put_contents(
            sprintf('%s/round-%04d-worker-%02d.marker', $resultDir, $round, $worker),
            'complete'
        );
        waitForEvidenceFiles(
            sprintf('%s/round-%04d-worker-*.marker', $resultDir, $round),
            $workerProcesses,
            'child round barrier timed out'
        );
        $ownedWorkItems++;
    }
    $firstShutdown = $childLifecycle->shutdown();
    $secondShutdown = $childLifecycle->shutdown();

    file_put_contents(sprintf('%s/child-%02d.json', $resultDir, $worker), json_encode([
        'worker' => $worker,
        'staleExecuted' => $staleExecuted,
        'staleCode' => $staleCode,
        'workItems' => $ownedWorkItems,
        'rounds' => $ownedWorkItems,
        'deliveredEvents' => $ownedWorkItems * $eventsPerItem,
        'maxPending' => $maxPending,
        'droppedEvents' => $childClient->droppedEvents(),
        'deliveryFailures' => count($deliveryFailures),
        'shutdownCached' => $firstShutdown === $secondShutdown,
        'pending' => $childClient->pendingEvents(),
    ], JSON_THROW_ON_ERROR));
    exit(0);
}

waitForEvidenceFiles($resultDir . '/ready-*.marker', $workerProcesses, 'parent ready barrier timed out');
file_put_contents($resultDir . '/start.marker', 'start');

$parentResult = $parentLifecycle->run(static function () use ($parentClient): string {
    $parentClient->log('evt_parent_after_fork', '2026-07-12T15:00:02Z', [
        'message' => 'parent continued',
        'level' => 'info',
    ]);
    return 'parent-result';
});
if ($parentResult !== 'parent-result' || $parentClient->pendingEvents() !== 0) {
    throw new RuntimeException('parent lifecycle contract failed');
}
$parentShutdown = $parentLifecycle->shutdown();
if ($parentLifecycle->shutdown() !== $parentShutdown) {
    throw new RuntimeException('parent shutdown was not cached');
}

$forkRejectedProcesses = 0;
$completedWorkItems = 0;
$deliveredEvents = 0;
$maxPending = 0;
$droppedEvents = 0;
$deliveryFailures = 0;
$allShutdownsCached = true;
foreach ($childPids as $worker => $childPid) {
    $childStatus = 0;
    pcntl_waitpid($childPid, $childStatus);
    if (!pcntl_wifexited($childStatus) || pcntl_wexitstatus($childStatus) !== 0) {
        throw new RuntimeException('child proof failed');
    }
    $resultPath = sprintf('%s/child-%02d.json', $resultDir, $worker);
    $childResult = json_decode((string) file_get_contents($resultPath), true, 512, JSON_THROW_ON_ERROR);
    if (
        !is_array($childResult)
        || $childResult['worker'] !== $worker
        || $childResult['staleExecuted'] !== false
        || $childResult['staleCode'] !== 'process_ownership_error'
        || $childResult['rounds'] !== intdiv($workItems, $workerProcesses)
        || $childResult['pending'] !== 0
    ) {
        throw new RuntimeException('child lifecycle contract failed');
    }
    $forkRejectedProcesses++;
    $completedWorkItems += (int) $childResult['workItems'];
    $deliveredEvents += (int) $childResult['deliveredEvents'];
    $maxPending = max($maxPending, (int) $childResult['maxPending']);
    $droppedEvents += (int) $childResult['droppedEvents'];
    $deliveryFailures += (int) $childResult['deliveryFailures'];
    $allShutdownsCached = $allShutdownsCached && $childResult['shutdownCached'] === true;
}

echo json_encode([
    'childProcesses' => $workerProcesses,
    'forkRejectedProcesses' => $forkRejectedProcesses,
    'parentEvents' => 2,
    'workItems' => $completedWorkItems,
    'rounds' => intdiv($workItems, $workerProcesses),
    'eventsPerItem' => $eventsPerItem,
    'deliveredEvents' => $deliveredEvents,
    'maxPending' => $maxPending,
    'droppedEvents' => $droppedEvents,
    'deliveryFailures' => $deliveryFailures,
    'shutdownsCached' => $allShutdownsCached && $parentLifecycle->shutdown() === $parentShutdown,
], JSON_THROW_ON_ERROR) . PHP_EOL;
PHP

proof_output="$({
  LOGBREW_PHP_WORKER_INTAKE_ENDPOINT="$(cat "$intake_dir/endpoint.txt")" \
  LOGBREW_PHP_WORKER_ITEMS="$work_items" \
  LOGBREW_PHP_WORKER_EVENTS_PER_ITEM="$events_per_item" \
  LOGBREW_PHP_WORKER_PROCESSES="$worker_processes" \
  LOGBREW_PHP_WORKER_RESULT_DIR="$result_dir" \
    php "$app_dir/worker-proof.php"
} 2>"$tmp_dir/proof.stderr")"
test ! -s "$tmp_dir/proof.stderr"

wait "$server_pid"
server_pid=""
test ! -s "$intake_dir/server.stderr"
test ! -e "$intake_dir/error.txt"

cat >"$tmp_dir/verify.php" <<'PHP'
<?php

declare(strict_types=1);

$dir = $argv[1];
$workItems = (int) $argv[2];
$eventsPerItem = (int) $argv[3];
$workerProcesses = (int) $argv[4];
$proof = json_decode($argv[5], true, 512, JSON_THROW_ON_ERROR);
$expectedRequests = $workItems + 2;
$files = glob($dir . '/request-*.body');
if ($files === false) {
    throw new RuntimeException('request files unavailable');
}
sort($files, SORT_STRING);
if (count($files) !== $expectedRequests) {
    throw new RuntimeException('unexpected request count');
}

$acceptedLoadIds = [];
$bodyStatuses = [];
$roundWorkers = [];
$lastLoadRound = -1;
$parentRequests = 0;
$loadRequests = 0;
$acceptedLoadRequests = 0;
$failedRequests = 0;
foreach ($files as $bodyFile) {
    $prefix = substr($bodyFile, 0, -strlen('.body'));
    $body = file_get_contents($bodyFile);
    $head = file_get_contents($prefix . '.head');
    $statusText = file_get_contents($prefix . '.status');
    if (!is_string($body) || !is_string($head) || !is_string($statusText)) {
        throw new RuntimeException('request evidence is incomplete');
    }
    $lines = preg_split('/\r?\n/', trim($head)) ?: [];
    $requestLine = array_shift($lines);
    if (!is_string($requestLine)) {
        throw new RuntimeException('request line is unavailable');
    }
    $requestParts = explode(' ', $requestLine, 3);
    if (($requestParts[0] ?? null) !== 'POST' || ($requestParts[1] ?? null) !== '/v1/events') {
        throw new RuntimeException('request method or target changed');
    }
    $headers = [];
    $headerCounts = [];
    foreach ($lines as $line) {
        $separator = strpos($line, ':');
        if ($separator === false) {
            continue;
        }
        $headerName = strtolower(substr($line, 0, $separator));
        $headers[$headerName] = trim(substr($line, $separator + 1));
        $headerCounts[$headerName] = ($headerCounts[$headerName] ?? 0) + 1;
    }
    if (
        ($headers['content-type'] ?? null) !== 'application/json'
        || ($headers['authorization'] ?? null) !== 'Bearer LOGBREW_API_KEY'
        || ($headers['content-length'] ?? null) !== (string) strlen($body)
        || ($headerCounts['authorization'] ?? 0) !== 1
        || substr_count($head, 'LOGBREW_API_KEY') !== 1
    ) {
        throw new RuntimeException('request headers changed');
    }
    if (strlen($body) > 262144 || str_contains($body, 'LOGBREW_API_KEY') || str_contains($body, 'private')) {
        throw new RuntimeException('request body violated size or privacy bounds');
    }
    $status = (int) trim($statusText);
    if (!in_array($status, [202, 503], true)) {
        throw new RuntimeException('request status evidence is invalid');
    }
    $bodyHash = hash('sha256', $body);
    $bodyStatuses[$bodyHash][] = $status;
    $payload = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($payload) || !is_array($payload['events'] ?? null)) {
        throw new RuntimeException('request body shape changed');
    }
    if (($payload['sdk']['language'] ?? null) !== 'php') {
        throw new RuntimeException('SDK language missing');
    }
    $eventIds = [];
    foreach ($payload['events'] as $event) {
        if (!is_array($event) || !is_string($event['id'] ?? null)) {
            throw new RuntimeException('event id shape changed');
        }
        $eventIds[] = $event['id'];
    }
    if ($eventIds === ['evt_parent_before_fork', 'evt_parent_after_fork']) {
        if ($status !== 202) {
            throw new RuntimeException('parent request was not accepted');
        }
        $parentRequests++;
        continue;
    }
    $loadRequests++;
    if (count($eventIds) !== $eventsPerItem) {
        throw new RuntimeException('work boundary event count changed');
    }
    $batchWork = null;
    $batchWorker = null;
    foreach ($payload['events'] as $eventIndex => $event) {
        $id = $eventIds[$eventIndex];
        if (!preg_match('/^evt_load_([0-9]{4})_([0-9]{3})$/', $id, $matches)) {
            throw new RuntimeException('load event id changed');
        }
        $work = (int) $matches[1];
        $eventNumber = (int) $matches[2];
        $metadata = $event['attributes']['metadata'] ?? null;
        if (
            !is_array($metadata)
            || ($metadata['worker'] ?? null) !== $work % $workerProcesses
            || ($metadata['work'] ?? null) !== $work
            || ($metadata['event'] ?? null) !== $eventNumber
            || $eventNumber !== $eventIndex
        ) {
            throw new RuntimeException('load event lost child ownership or order');
        }
        $batchWork ??= $work;
        $batchWorker ??= $metadata['worker'];
        if ($batchWork !== $work || $batchWorker !== $metadata['worker']) {
            throw new RuntimeException('work boundary mixed child ownership');
        }
        if ($status === 202) {
            if (isset($acceptedLoadIds[$id])) {
                throw new RuntimeException('accepted load event was duplicated');
            }
            $acceptedLoadIds[$id] = true;
        }
    }
    if (!is_int($batchWork) || !is_int($batchWorker)) {
        throw new RuntimeException('work boundary ownership is unavailable');
    }
    $round = intdiv($batchWork, $workerProcesses);
    if ($round < $lastLoadRound) {
        throw new RuntimeException('child round requests were not synchronized');
    }
    $lastLoadRound = $round;
    if ($status === 202) {
        $acceptedLoadRequests++;
        $roundWorkers[$round][$batchWorker] = true;
    } else {
        $failedRequests++;
    }
}
if (
    $parentRequests !== 1
    || $loadRequests !== $workItems + 1
    || $acceptedLoadRequests !== $workItems
    || $failedRequests !== 1
    || count($acceptedLoadIds) !== $workItems * $eventsPerItem
) {
    throw new RuntimeException('accepted high-load IDs were missing or duplicated');
}
$expectedRounds = intdiv($workItems, $workerProcesses);
if (count($roundWorkers) !== $expectedRounds) {
    throw new RuntimeException('child round count changed');
}
for ($round = 0; $round < $expectedRounds; $round++) {
    if (count($roundWorkers[$round] ?? []) !== $workerProcesses) {
        throw new RuntimeException('child round did not include every worker');
    }
}
$retryBodies = array_filter(
    $bodyStatuses,
    static fn (array $statuses): bool => in_array(503, $statuses, true)
);
if (count($retryBodies) !== 1 || array_values($retryBodies)[0] !== [503, 202]) {
    throw new RuntimeException('503 retry body or order changed');
}
foreach ($bodyStatuses as $statuses) {
    if ($statuses !== [202] && $statuses !== [503, 202]) {
        throw new RuntimeException('unexpected duplicate request body');
    }
}
if (
    !is_array($proof)
    || $proof['childProcesses'] !== $workerProcesses
    || $proof['forkRejectedProcesses'] !== $workerProcesses
    || $proof['parentEvents'] !== 2
    || $proof['workItems'] !== $workItems
    || $proof['rounds'] !== intdiv($workItems, $workerProcesses)
    || $proof['eventsPerItem'] !== $eventsPerItem
    || $proof['deliveredEvents'] !== $workItems * $eventsPerItem
    || $proof['maxPending'] !== $eventsPerItem
    || $proof['droppedEvents'] !== 0
    || $proof['deliveryFailures'] !== 0
    || $proof['shutdownsCached'] !== true
) {
    throw new RuntimeException('proof summary mismatch');
}
PHP

php "$tmp_dir/verify.php" "$intake_dir" "$work_items" "$events_per_item" "$worker_processes" "$proof_output"

printf 'php worker lifecycle installed proof passed: processes=%d work_items=%d events_per_item=%d delivered=%d requests=%d retries=1 forks=%d\n' \
  "$worker_processes" \
  "$work_items" \
  "$events_per_item" \
  "$((work_items * events_per_item))" \
  "$expected_requests" \
  "$worker_processes"
