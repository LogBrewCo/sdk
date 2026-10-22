<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use LogBrew\EncryptedFileEventStore;
use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;

function persistentReportClient(string $directory, string $key, int $maxQueueSize = 1): LogBrewClient
{
    return LogBrewClient::create(
        'LOGBREW_API_KEY',
        'logbrew-php',
        '0.1.0',
        maxRetries: 0,
        maxQueueSize: $maxQueueSize,
        eventStore: EncryptedFileEventStore::open($directory, $key),
        captureRuntimeContext: false
    );
}

function persistentReportLog(LogBrewClient $client, string $id): void
{
    $client->log($id, '2026-07-15T10:00:00Z', ['message' => 'queued', 'level' => 'info']);
}

/** @return array<mixed> */
function persistentReportState(string $directory, string $key): array
{
    $store = EncryptedFileEventStore::open($directory, $key);
    $saved = $store->loadClientReport();
    $store->close();
    $state = $saved === null ? [] : json_decode($saved, true, 8, JSON_THROW_ON_ERROR);
    if (!is_array($state)) {
        throw new RuntimeException('saved drop counts must be an object');
    }
    return $state;
}

/** Read the saved unreported queue_overflow count through an open store, which holds the directory lock. */
function persistentReportSavedOverflow(EncryptedFileEventStore $store): int
{
    $saved = $store->loadClientReport();
    $state = $saved === null ? [] : json_decode($saved, true, 8, JSON_THROW_ON_ERROR);
    $unreported = is_array($state) ? ($state['unreported'] ?? []) : [];
    return is_array($unreported) && is_int($unreported['queue_overflow'] ?? null) ? $unreported['queue_overflow'] : 0;
}

function persistentReportStore(LogBrewClient $client): EncryptedFileEventStore
{
    $store = (new ReflectionProperty($client, 'eventStore'))->getValue($client);
    if (!$store instanceof EncryptedFileEventStore) {
        throw new RuntimeException('client must hold an event store');
    }
    return $store;
}

/** Release the store without shutdown, like a process that stops abruptly. */
function persistentReportCrash(LogBrewClient $client): void
{
    persistentReportStore($client)->close();
}

// Unreported drop counts survive an app restart in another process.
$childDirectory = persistentDeliveryDirectory();
$childKey = random_bytes(32);
runCommand(__DIR__, [PHP_BINARY, __DIR__ . '/persistent_client_report_child.php', $childDirectory, bin2hex($childKey)]);
$childClient = persistentReportClient($childDirectory, $childKey);
$childTransport = RecordingTransport::alwaysAccept();
$childClient->flush($childTransport);
$childReport = requireClientReport($childTransport->sentBodies[0], 'a restart in another process must keep the drop count');
assertTrue($childReport['dropped_events'] === ['queue_overflow' => 1], 'the restart must keep the exact drop count');
persistentReportLog($childClient, 'evt_after_restart');
$childClient->shutdown($childTransport);
assertTrue(clientReportOf($childTransport->sentBodies[1]) === null, 'an acknowledged report must not be sent again');
assertTrue(persistentReportState($childDirectory, $childKey) === [], 'a drained store must not keep drop counts');
assertTrue(!file_exists($childDirectory . '/.report'), 'a drained store must return to its earlier shape');
removePersistentDeliveryDirectory($childDirectory);

// A report that was already sent keeps its ID, and later drops wait under a new one.
$idDirectory = persistentDeliveryDirectory();
$idKey = random_bytes(32);
$idClient = persistentReportClient($idDirectory, $idKey);
persistentReportLog($idClient, 'evt_id_1');
persistentReportLog($idClient, 'evt_id_2');
$failedTransport = new RecordingTransport([503]);
expectSdkError(static fn () => $idClient->flush($failedTransport), 'transport_error');
persistentReportLog($idClient, 'evt_id_3');
$sentBeforeCrash = requireClientReport($failedTransport->sentBodies[0], 'the failed request must carry the report');
persistentReportCrash($idClient);
unset($idClient);

$idRestarted = persistentReportClient($idDirectory, $idKey);
$idTransport = RecordingTransport::alwaysAccept();
$idRestarted->flush($idTransport);
persistentReportLog($idRestarted, 'evt_id_4');
$idRestarted->flush($idTransport);
$resent = requireClientReport($idTransport->sentBodies[0], 'the restart must resend the report');
assertTrue($resent === $sentBeforeCrash, 'a restart must resend the report under its first ID');
$carriedLater = requireClientReport($idTransport->sentBodies[1], 'the later drop must reach LogBrew');
assertTrue($carriedLater['dropped_events'] === ['queue_overflow' => 1], 'the later drop must be counted once');
assertTrue($carriedLater['report_id'] !== $resent['report_id'], 'the later drop must use a new report ID');
$idRestarted->shutdown($idTransport);
removePersistentDeliveryDirectory($idDirectory);

// A drop burst saves at most once a second, and shutdown saves the rest.
$burstDirectory = persistentDeliveryDirectory();
$burstKey = random_bytes(32);
$burstClient = persistentReportClient($burstDirectory, $burstKey);
$burstStore = persistentReportStore($burstClient);
$setBurstInterval = static function (int $nanoseconds) use ($burstClient): void {
    (new ReflectionProperty($burstClient, 'reportSaveInterval'))->setValue($burstClient, $nanoseconds);
};
$setBurstInterval(PHP_INT_MAX);
$savedOverflow = static fn (): int => persistentReportSavedOverflow($burstStore);
persistentReportLog($burstClient, 'evt_burst_1');
persistentReportLog($burstClient, 'evt_burst_2');
assertTrue($savedOverflow() === 1, 'a new drop reason must save at once');
persistentReportLog($burstClient, 'evt_burst_3');
persistentReportLog($burstClient, 'evt_burst_4');
assertTrue($savedOverflow() === 1, 'a drop burst must save at most once a second');
$setBurstInterval(0);
persistentReportLog($burstClient, 'evt_burst_5');
assertTrue($savedOverflow() === 4, 'a later drop must save the whole burst');
$setBurstInterval(PHP_INT_MAX);
persistentReportLog($burstClient, 'evt_burst_6');
assertTrue($savedOverflow() === 4, 'drops inside the interval must wait');
expectSdkError(static fn () => $burstClient->shutdown(new RecordingTransport([400])), 'transport_error');
persistentReportCrash($burstClient);
unset($burstClient);
$burstState = persistentReportState($burstDirectory, $burstKey);
$burstPending = $burstState['pending'] ?? null;
assertTrue(
    is_array($burstPending) && ($burstPending['dropped_events'] ?? null) === ['queue_overflow' => 5],
    'shutdown must save the drops that waited for the next save'
);
removePersistentDeliveryDirectory($burstDirectory);

// Unreadable saved counts are ignored and never block opening the store.
$badStates = [
    'invalid entries' => json_encode([
        'pending' => ['report_id' => 'short', 'dropped_events' => ['queue_overflow' => 2]],
        'unreported' => ['Not-A-Reason' => 1, 'queue_overflow' => '3', 'event_too_large' => 0, 'evicted_for_fatal' => 2],
    ], JSON_THROW_ON_ERROR),
    'not an object' => '[1,2]',
    'not json' => 'not json',
];
foreach ($badStates as $label => $saved) {
    $badDirectory = persistentDeliveryDirectory();
    $badKey = random_bytes(32);
    $badStore = EncryptedFileEventStore::open($badDirectory, $badKey);
    $badStore->saveClientReport($saved);
    $badStore->close();
    unset($badStore);
    $badClient = persistentReportClient($badDirectory, $badKey);
    persistentReportLog($badClient, 'evt_bad_1');
    $badTransport = RecordingTransport::alwaysAccept();
    $badClient->shutdown($badTransport);
    $badReport = clientReportOf($badTransport->sentBodies[0]);
    $expected = $label === 'invalid entries' ? ['evicted_for_fatal' => 2] : null;
    assertTrue(($badReport['dropped_events'] ?? null) === $expected, "unreadable saved counts must be ignored ({$label})");
    removePersistentDeliveryDirectory($badDirectory);
}
$tamperDirectory = persistentDeliveryDirectory();
$tamperKey = random_bytes(32);
$tamperStore = EncryptedFileEventStore::open($tamperDirectory, $tamperKey);
$tamperStore->saveClientReport('{"unreported":{"queue_overflow":2}}');
$tamperStore->close();
unset($tamperStore);
file_put_contents($tamperDirectory . '/.report', str_repeat('x', 64));
chmod($tamperDirectory . '/.report', 0600);
$tamperClient = persistentReportClient($tamperDirectory, $tamperKey);
persistentReportLog($tamperClient, 'evt_tamper_1');
$tamperTransport = RecordingTransport::alwaysAccept();
$tamperClient->shutdown($tamperTransport);
assertTrue(clientReportOf($tamperTransport->sentBodies[0]) === null, 'a tampered drop count file must be ignored');
removePersistentDeliveryDirectory($tamperDirectory);

// A failed save never blocks capture.
$failDirectory = persistentDeliveryDirectory();
$failKey = random_bytes(32);
$failClient = persistentReportClient($failDirectory, $failKey);
persistentReportLog($failClient, 'evt_fail_1');
chmod($failDirectory, 0500);
persistentReportLog($failClient, 'evt_fail_2');
chmod($failDirectory, 0700);
assertTrue($failClient->droppedEvents() === 1, 'a drop must be counted when its save fails');
$failTransport = RecordingTransport::alwaysAccept();
$failClient->shutdown($failTransport);
$failReport = requireClientReport($failTransport->sentBodies[0], 'the drop must still reach LogBrew');
assertTrue($failReport['dropped_events'] === ['queue_overflow' => 1], 'the drop count must stay in memory');
removePersistentDeliveryDirectory($failDirectory);
fwrite(STDOUT, "php persistent client report checks passed
");
