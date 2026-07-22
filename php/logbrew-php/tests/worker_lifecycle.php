<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\LogBrewWorkerLifecycle;
use LogBrew\RecordingTransport;
use LogBrew\SdkError;
use LogBrew\Transport;
use LogBrew\TransportResponse;
use LogBrew\WorkerDeliveryFailure;

function assertWorkerLifecycle(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, $message . PHP_EOL);
        exit(1);
    }
}

/**
 * @return array{executed: bool, code: ?string, shutdownCode: ?string, messageSafe: bool}
 */
function decodeWorkerLifecycleChildResult(string $json): array
{
    $result = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($result)) {
        fwrite(STDERR, 'fork result must decode to an array' . PHP_EOL);
        exit(1);
    }
    $executed = $result['executed'] ?? null;
    $code = $result['code'] ?? null;
    $shutdownCode = $result['shutdownCode'] ?? null;
    $messageSafe = $result['messageSafe'] ?? null;
    if (
        !is_bool($executed)
        || ($code !== null && !is_string($code))
        || ($shutdownCode !== null && !is_string($shutdownCode))
        || !is_bool($messageSafe)
    ) {
        fwrite(STDERR, 'fork result has an invalid shape' . PHP_EOL);
        exit(1);
    }

    return [
        'executed' => $executed,
        'code' => $code,
        'shutdownCode' => $shutdownCode,
        'messageSafe' => $messageSafe,
    ];
}

/** @return array{code: ?string, result: ?string, sends: int} */
function decodeWorkerLifecycleInnerForkResult(string $json): array
{
    $result = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($result)) {
        fwrite(STDERR, 'inner fork result must decode to an array' . PHP_EOL);
        exit(1);
    }
    $code = $result['code'] ?? null;
    $workResult = $result['result'] ?? null;
    $sends = $result['sends'] ?? null;
    if (
        ($code !== null && !is_string($code))
        || ($workResult !== null && !is_string($workResult))
        || !is_int($sends)
    ) {
        fwrite(STDERR, 'inner fork result has an invalid shape' . PHP_EOL);
        exit(1);
    }

    return ['code' => $code, 'result' => $workResult, 'sends' => $sends];
}

/** @return list<string> */
function workerLifecycleEventIds(string $body): array
{
    $payload = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($payload) || !is_array($payload['events'] ?? null)) {
        fwrite(STDERR, 'worker payload must contain an event array' . PHP_EOL);
        exit(1);
    }

    $ids = [];
    foreach ($payload['events'] as $event) {
        if (!is_array($event) || !is_string($event['id'] ?? null)) {
            fwrite(STDERR, 'worker payload event must contain a string id' . PHP_EOL);
            exit(1);
        }
        $ids[] = $event['id'];
    }

    return $ids;
}

function waitForWorkerLifecycleChild(int $childPid): int
{
    $status = 0;
    $waitedPid = pcntl_waitpid($childPid, $status);
    if ($waitedPid !== $childPid || !is_int($status)) {
        fwrite(STDERR, 'fork test child status is unavailable' . PHP_EOL);
        exit(1);
    }

    return $status;
}

$client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$transport = RecordingTransport::alwaysAccept();
$lifecycle = LogBrewWorkerLifecycle::create($client, $transport);

$result = $lifecycle->run(static function () use ($client): string {
    $client->log('evt_worker_success', '2026-07-12T14:00:00Z', [
        'message' => 'work completed',
        'level' => 'info',
    ]);

    return 'app-result';
});

assertWorkerLifecycle($result === 'app-result', 'work boundary must preserve the application result');
assertWorkerLifecycle($client->pendingEvents() === 0, 'work boundary must flush queued telemetry');
assertWorkerLifecycle(count($transport->sentBodies) === 1, 'work boundary must send exactly once');

$client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$transport = RecordingTransport::alwaysAccept();
$lifecycle = LogBrewWorkerLifecycle::create($client, $transport);
$appError = new RuntimeException('private application failure');
$caughtAppError = null;

try {
    $lifecycle->run(static function () use ($client, $appError): never {
        $client->issue('evt_worker_failure', '2026-07-12T14:00:01Z', [
            'title' => 'work failed',
            'level' => 'error',
        ]);

        throw $appError;
    });
} catch (Throwable $error) {
    $caughtAppError = $error;
}

assertWorkerLifecycle($caughtAppError === $appError, 'work boundary must rethrow the original application error');
assertWorkerLifecycle($client->pendingEvents() === 0, 'failed work must still flush queued telemetry');
assertWorkerLifecycle(count($transport->sentBodies) === 1, 'failed work must flush exactly once');

$client = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxRetries: 0
);
$transport = new RecordingTransport([500]);
$deliveryFailures = [];
$lifecycle = LogBrewWorkerLifecycle::create(
    $client,
    $transport,
    static function (WorkerDeliveryFailure $failure) use (&$deliveryFailures): void {
        $deliveryFailures[] = $failure;
        throw new RuntimeException('private delivery callback failure');
    }
);

$result = $lifecycle->run(static function () use ($client): string {
    $client->log('evt_worker_retry', '2026-07-12T14:00:02Z', [
        'message' => 'retry at next boundary',
        'level' => 'warning',
    ]);

    return 'delivery-isolated';
});

assertWorkerLifecycle($result === 'delivery-isolated', 'delivery failure must not change the application result');
assertWorkerLifecycle($client->pendingEvents() === 1, 'delivery failure must retain queued telemetry');
assertWorkerLifecycle(count($deliveryFailures) === 1, 'delivery failure callback must run once');
$failure = $deliveryFailures[0];
assertWorkerLifecycle($failure->stage === 'work_boundary', 'delivery failure must identify the work boundary');
assertWorkerLifecycle($failure->codeName === 'transport_error', 'delivery failure must expose a stable code');
assertWorkerLifecycle($failure->pendingEvents === 1, 'delivery failure must expose retained count');
assertWorkerLifecycle($failure->pendingEventBytes > 0, 'delivery failure must expose retained bytes');
assertWorkerLifecycle(
    array_keys(get_object_vars($failure)) === ['stage', 'codeName', 'pendingEvents', 'pendingEventBytes'],
    'delivery failure must expose only content-free fields'
);

$retryResult = $lifecycle->run(static function () use ($client): string {
    $client->log('evt_worker_after_retry', '2026-07-12T14:00:03Z', [
        'message' => 'new boundary telemetry',
        'level' => 'info',
    ]);

    return 'retry-result';
});
assertWorkerLifecycle($retryResult === 'retry-result', 'later boundary must preserve its application result');
assertWorkerLifecycle($client->pendingEvents() === 0, 'later boundary must retry retained telemetry');
assertWorkerLifecycle(count($transport->sentBodies) === 3, 'retained telemetry must retry before the new boundary');
assertWorkerLifecycle($transport->sentBodies[0] === $transport->sentBodies[1], 'boundary retry body must be byte-identical');
assertWorkerLifecycle(
    array_map('workerLifecycleEventIds', $transport->sentBodies) === [
        ['evt_worker_retry'],
        ['evt_worker_retry'],
        ['evt_worker_after_retry'],
    ],
    'new work must not change a retained retry body'
);
assertWorkerLifecycle(count($deliveryFailures) === 1, 'successful retry must not report another failure');

$client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$client->log('evt_worker_untrusted_code', '2026-07-12T14:00:03Z', [
    'message' => 'untrusted transport',
    'level' => 'error',
]);
$unsafeTransport = new class implements Transport {
    public function send(string $apiKey, string $body): TransportResponse
    {
        throw new SdkError(
            'authorization=Bearer private-transport-value',
            'private transport message'
        );
    }
};
$unsafeFailures = [];
$lifecycle = LogBrewWorkerLifecycle::create(
    $client,
    $unsafeTransport,
    static function (WorkerDeliveryFailure $failure) use (&$unsafeFailures): void {
        $unsafeFailures[] = $failure;
    }
);
$unsafeResult = $lifecycle->run(static fn (): string => 'unsafe-code-isolated');
assertWorkerLifecycle($unsafeResult === 'unsafe-code-isolated', 'untrusted transport code must not change app results');
assertWorkerLifecycle(count($unsafeFailures) === 1, 'untrusted transport failure must report once');
assertWorkerLifecycle($unsafeFailures[0]->codeName === 'delivery_error', 'untrusted transport code must be normalized');
assertWorkerLifecycle(
    !str_contains(json_encode($unsafeFailures[0], JSON_THROW_ON_ERROR), 'private-transport-value'),
    'delivery failure must not expose an untrusted code value'
);

$client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$transport = RecordingTransport::alwaysAccept();
$lifecycle = LogBrewWorkerLifecycle::create($client, $transport);
$nestedRunExecuted = false;
$nestedRunError = null;
$nestedShutdownError = null;
$result = $lifecycle->run(static function () use (
    $client,
    $lifecycle,
    &$nestedRunExecuted,
    &$nestedRunError,
    &$nestedShutdownError
): string {
    try {
        $lifecycle->run(static function () use (&$nestedRunExecuted): void {
            $nestedRunExecuted = true;
        });
    } catch (SdkError $error) {
        $nestedRunError = $error;
    }
    try {
        $lifecycle->shutdown();
    } catch (SdkError $error) {
        $nestedShutdownError = $error;
    }
    $client->log('evt_worker_reentrant', '2026-07-12T14:00:02Z', [
        'message' => 'outer work',
        'level' => 'info',
    ]);

    return 'outer-result';
});

assertWorkerLifecycle($result === 'outer-result', 'outer work must complete normally');
assertWorkerLifecycle(!$nestedRunExecuted, 'nested work callback must not execute');
assertWorkerLifecycle($nestedRunError?->codeName === 'worker_lifecycle_error', 'nested run must use a stable code');
assertWorkerLifecycle($nestedShutdownError?->codeName === 'worker_lifecycle_error', 'shutdown during work must use a stable code');
assertWorkerLifecycle(count($transport->sentBodies) === 1, 'outer boundary must remain the only send');

$client = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxRetries: 0
);
$transport = new RecordingTransport([500, 202]);
$combinedFailures = [];
$lifecycle = LogBrewWorkerLifecycle::create(
    $client,
    $transport,
    static function (WorkerDeliveryFailure $failure) use (&$combinedFailures): void {
        $combinedFailures[] = $failure;
    }
);
$combinedAppError = new RuntimeException('private application failure with delivery failure');
$caughtCombinedError = null;
try {
    $lifecycle->run(static function () use ($client, $combinedAppError): never {
        $client->issue('evt_worker_combined_failure', '2026-07-12T14:00:03Z', [
            'title' => 'combined failure',
            'level' => 'error',
        ]);
        throw $combinedAppError;
    });
} catch (Throwable $error) {
    $caughtCombinedError = $error;
}
assertWorkerLifecycle($caughtCombinedError === $combinedAppError, 'delivery failure must never mask an application error');
assertWorkerLifecycle($client->pendingEvents() === 1, 'combined failure must retain telemetry');
assertWorkerLifecycle(count($combinedFailures) === 1, 'combined failure must report delivery once');
$lifecycle->shutdown();
assertWorkerLifecycle($client->pendingEvents() === 0, 'shutdown must retry telemetry after combined failure');

$client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$client->log('evt_worker_shutdown', '2026-07-12T14:00:03Z', [
    'message' => 'worker stopping',
    'level' => 'info',
]);
$transport = RecordingTransport::alwaysAccept();
$lifecycle = LogBrewWorkerLifecycle::create($client, $transport);
$firstShutdown = $lifecycle->shutdown();
$secondShutdown = $lifecycle->shutdown();

assertWorkerLifecycle($firstShutdown->statusCode === 202, 'shutdown must return the accepted response');
assertWorkerLifecycle($secondShutdown === $firstShutdown, 'successful shutdown must be terminal-idempotent');
assertWorkerLifecycle($client->pendingEvents() === 0, 'shutdown must drain queued telemetry');
assertWorkerLifecycle(count($transport->sentBodies) === 1, 'repeated shutdown must not send twice');
$ranAfterShutdown = false;
$postShutdownError = null;
try {
    $lifecycle->run(static function () use (&$ranAfterShutdown): void {
        $ranAfterShutdown = true;
    });
} catch (SdkError $error) {
    $postShutdownError = $error;
}
assertWorkerLifecycle($postShutdownError?->codeName === 'shutdown_error', 'work after shutdown must fail with a stable code');
assertWorkerLifecycle(!$ranAfterShutdown, 'work after shutdown must not execute the application callback');

$client = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxRetries: 0
);
$client->log('evt_worker_shutdown_retry', '2026-07-12T14:00:04Z', [
    'message' => 'retry shutdown',
    'level' => 'warning',
]);
$transport = new RecordingTransport([500, 202]);
$shutdownFailures = [];
$lifecycle = LogBrewWorkerLifecycle::create(
    $client,
    $transport,
    static function (WorkerDeliveryFailure $failure) use (&$shutdownFailures): void {
        $shutdownFailures[] = $failure;
        throw new RuntimeException('private shutdown callback failure');
    }
);
$shutdownError = null;
try {
    $lifecycle->shutdown();
} catch (SdkError $error) {
    $shutdownError = $error;
}

assertWorkerLifecycle($shutdownError?->codeName === 'transport_error', 'failed shutdown must rethrow its delivery error');
assertWorkerLifecycle($client->pendingEvents() === 1, 'failed shutdown must retain telemetry');
assertWorkerLifecycle(count($shutdownFailures) === 1, 'failed shutdown must report once');
assertWorkerLifecycle($shutdownFailures[0]->stage === 'shutdown', 'failed shutdown must identify its stage');
assertWorkerLifecycle($shutdownFailures[0]->pendingEvents === 1, 'failed shutdown must report retained count');

$retriedShutdown = $lifecycle->shutdown();
$cachedShutdown = $lifecycle->shutdown();
assertWorkerLifecycle($retriedShutdown->statusCode === 202, 'later shutdown must retry retained telemetry');
assertWorkerLifecycle($cachedShutdown === $retriedShutdown, 'retried success must become terminal-idempotent');
assertWorkerLifecycle($client->pendingEvents() === 0, 'successful retry must drain telemetry');
assertWorkerLifecycle(count($transport->sentBodies) === 2, 'failed shutdown must make only one later retry');
assertWorkerLifecycle($transport->sentBodies[0] === $transport->sentBodies[1], 'shutdown retry body must be byte-identical');

if (function_exists('pcntl_fork')) {
    $client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
    $client->log('evt_parent_before_fork', '2026-07-12T14:00:05Z', [
        'message' => 'parent retained',
        'level' => 'info',
    ]);
    $transport = RecordingTransport::alwaysAccept();
    $lifecycle = LogBrewWorkerLifecycle::create($client, $transport);
    $parentProcessId = getmypid();
    $resultFile = tempnam(sys_get_temp_dir(), 'logbrew-worker-fork-');
    assertWorkerLifecycle(is_string($resultFile), 'fork test must allocate a result file');

    $childPid = pcntl_fork();
    assertWorkerLifecycle($childPid !== -1, 'fork test must create a child process');
    if ($childPid === 0) {
        $childWorkExecuted = false;
        $childErrorCode = null;
        $childShutdownCode = null;
        $childMessageSafe = false;
        try {
            $lifecycle->run(static function () use ($client, &$childWorkExecuted): void {
                $childWorkExecuted = true;
                $client->log('evt_child_inherited', '2026-07-12T14:00:06Z', [
                    'message' => 'must not run',
                    'level' => 'error',
                ]);
            });
        } catch (SdkError $error) {
            $childErrorCode = $error->codeName;
            $message = $error->getMessage();
            $childMessageSafe = !str_contains($message, (string) $parentProcessId)
                && !str_contains($message, (string) getmypid());
        }
        try {
            $lifecycle->shutdown();
        } catch (SdkError $error) {
            $childShutdownCode = $error->codeName;
        }
        file_put_contents($resultFile, json_encode([
            'executed' => $childWorkExecuted,
            'code' => $childErrorCode,
            'shutdownCode' => $childShutdownCode,
            'messageSafe' => $childMessageSafe,
        ], JSON_THROW_ON_ERROR));
        exit(0);
    }

    $childStatus = waitForWorkerLifecycleChild($childPid);
    assertWorkerLifecycle(pcntl_wifexited($childStatus), 'fork test child must exit normally');
    assertWorkerLifecycle(pcntl_wexitstatus($childStatus) === 0, 'fork test child must report its result');
    $childResultJson = file_get_contents($resultFile);
    if (!is_string($childResultJson)) {
        fwrite(STDERR, 'fork test result must be readable' . PHP_EOL);
        exit(1);
    }
    $childResult = decodeWorkerLifecycleChildResult($childResultJson);
    unlink($resultFile);
    assertWorkerLifecycle($childResult['code'] === 'process_ownership_error', 'inherited lifecycle must reject child use');
    assertWorkerLifecycle($childResult['shutdownCode'] === 'process_ownership_error', 'inherited lifecycle must reject child shutdown');
    assertWorkerLifecycle($childResult['executed'] === false, 'inherited lifecycle must reject before application work');
    assertWorkerLifecycle($childResult['messageSafe'] === true, 'process ownership errors must not expose process IDs');

    $parentResult = $lifecycle->run(static function () use ($client): string {
        $client->log('evt_parent_after_fork', '2026-07-12T14:00:07Z', [
            'message' => 'parent work',
            'level' => 'info',
        ]);

        return 'parent-result';
    });
    assertWorkerLifecycle($parentResult === 'parent-result', 'owner process must keep using its lifecycle');
    assertWorkerLifecycle(count($transport->sentBodies) === 1, 'owner process must send one boundary');
    $parentIds = workerLifecycleEventIds($transport->sentBodies[0]);
    assertWorkerLifecycle(
        $parentIds === ['evt_parent_before_fork', 'evt_parent_after_fork'],
        'owner process must never inherit child telemetry'
    );

    $client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
    $transport = RecordingTransport::alwaysAccept();
    $lifecycle = LogBrewWorkerLifecycle::create($client, $transport);
    $innerForkResultFile = tempnam(sys_get_temp_dir(), 'logbrew-worker-inner-fork-');
    assertWorkerLifecycle(is_string($innerForkResultFile), 'inner fork test must allocate a result file');
    $forkBranch = null;
    $innerForkResult = null;
    $innerForkError = null;
    try {
        $innerForkResult = $lifecycle->run(static function () use ($client, &$forkBranch): string {
            $client->log('evt_fork_inside_work', '2026-07-12T14:00:08Z', [
                'message' => 'fork boundary',
                'level' => 'info',
            ]);
            $forkBranch = pcntl_fork();
            if ($forkBranch === -1) {
                throw new RuntimeException('inner fork failed');
            }

            return $forkBranch === 0 ? 'child-result' : 'parent-result';
        });
    } catch (SdkError $error) {
        $innerForkError = $error;
    }

    if ($forkBranch === 0) {
        file_put_contents($innerForkResultFile, json_encode([
            'code' => $innerForkError?->codeName,
            'result' => $innerForkResult,
            'sends' => count($transport->sentBodies),
        ], JSON_THROW_ON_ERROR));
        exit(0);
    }
    if (!is_int($forkBranch) || $forkBranch <= 0) {
        fwrite(STDERR, 'inner fork must return a child id to the parent' . PHP_EOL);
        exit(1);
    }
    $innerForkStatus = waitForWorkerLifecycleChild($forkBranch);
    assertWorkerLifecycle(pcntl_wifexited($innerForkStatus), 'inner fork child must exit normally');
    assertWorkerLifecycle(pcntl_wexitstatus($innerForkStatus) === 0, 'inner fork child must report its result');
    $innerForkJson = file_get_contents($innerForkResultFile);
    if (!is_string($innerForkJson)) {
        fwrite(STDERR, 'inner fork result must be readable' . PHP_EOL);
        exit(1);
    }
    $childInnerFork = decodeWorkerLifecycleInnerForkResult($innerForkJson);
    unlink($innerForkResultFile);
    assertWorkerLifecycle($childInnerFork['code'] === 'process_ownership_error', 'inner fork child must reject delivery');
    assertWorkerLifecycle($childInnerFork['result'] === null, 'inner fork child must not return a successful boundary result');
    assertWorkerLifecycle($childInnerFork['sends'] === 0, 'inner fork child must not send a copied queue');
    assertWorkerLifecycle($innerForkError === null, 'inner fork parent must not receive a lifecycle error');
    assertWorkerLifecycle($innerForkResult === 'parent-result', 'inner fork parent must preserve its work result');
    assertWorkerLifecycle(count($transport->sentBodies) === 1, 'inner fork parent must remain the only sender');
    assertWorkerLifecycle(
        workerLifecycleEventIds($transport->sentBodies[0]) === ['evt_fork_inside_work'],
        'inner fork parent must deliver its original boundary'
    );
}

fwrite(STDOUT, "php worker lifecycle checks passed\n");
