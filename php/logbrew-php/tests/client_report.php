<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use LogBrew\EncryptedFileEventStore;
use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\TransportError;

/** @return array{report_id:string, dropped_events:array<string, int>}|null */
function clientReportOf(string $body): ?array
{
    $payload = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($payload) || !array_key_exists('client_report', $payload)) {
        return null;
    }
    $report = $payload['client_report'];
    if (!is_array($report) || array_keys($report) !== ['report_id', 'dropped_events']) {
        throw new RuntimeException('client report must hold only report_id and dropped_events');
    }
    $reportId = $report['report_id'];
    $drops = $report['dropped_events'];
    if (!is_string($reportId) || preg_match('/^[A-Za-z0-9_-]{16,64}$/D', $reportId) !== 1) {
        throw new RuntimeException('report_id must match the schema');
    }
    if (!is_array($drops) || $drops === []) {
        throw new RuntimeException('dropped_events must not be empty');
    }
    $counts = [];
    foreach ($drops as $reason => $count) {
        if (!is_string($reason) || !is_int($count)) {
            throw new RuntimeException('dropped_events must map reasons to counts');
        }
        $counts[$reason] = $count;
    }
    return ['report_id' => $reportId, 'dropped_events' => $counts];
}

/** @return array{report_id:string, dropped_events:array<string, int>} */
function requireClientReport(string $body, string $message): array
{
    return clientReportOf($body) ?? throw new RuntimeException($message);
}

function clientReportLog(LogBrewClient $client, string $id, string $message = 'kept'): void
{
    $client->log($id, '2026-07-15T10:00:00Z', ['message' => $message, 'level' => 'info']);
}

// Every drop reason reaches LogBrew in the next request, and a 2xx clears it.
$client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxQueueSize: 2, maxBatchBytes: 2_000);
clientReportLog($client, 'evt_report_large', str_repeat('x', 3_000));
clientReportLog($client, 'evt_report_1');
clientReportLog($client, 'evt_report_2');
clientReportLog($client, 'evt_report_overflow');
clientReportLog($client, 'evt_report_overflow_2');
$client->issue('evt_report_crash', '2026-07-15T10:00:01Z', ['title' => 'App crashed', 'level' => 'fatal']);
$transport = RecordingTransport::alwaysAccept();
$client->flush($transport);
$report = requireClientReport($transport->sentBodies[0], 'the first request after drops must carry a client report');
assertTrue(
    $report['dropped_events'] === ['event_too_large' => 1, 'queue_overflow' => 2, 'evicted_for_fatal' => 1],
    'the client report must count every drop by reason'
);
clientReportLog($client, 'evt_report_after');
$client->flush($transport);
assertTrue(clientReportOf($transport->sentBodies[1]) === null, 'an acknowledged client report must not be sent again');

// A failed request keeps its report ID for the resend; drops recorded meanwhile wait under a new ID.
$retryClient = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxRetries: 0, maxQueueSize: 1, maxBatchEvents: 1);
clientReportLog($retryClient, 'evt_retry_kept');
clientReportLog($retryClient, 'evt_retry_dropped');
$retryTransport = new RecordingTransport([new TransportError('network_error', 'offline'), 202, 202]);
expectThrows(static fn () => $retryClient->flush($retryTransport), 'transport request failed');
$firstReport = requireClientReport($retryTransport->sentBodies[0], 'the failed request must carry the report');
assertTrue($firstReport['dropped_events'] === ['queue_overflow' => 1], 'the failed request must count its drop');
clientReportLog($retryClient, 'evt_retry_dropped_2');
$retryClient->flush($retryTransport);
assertTrue($retryTransport->sentBodies[1] === $retryTransport->sentBodies[0], 'the resend must repeat the same request body');
clientReportLog($retryClient, 'evt_retry_next');
$retryClient->flush($retryTransport);
$secondReport = requireClientReport($retryTransport->sentBodies[2], 'the next request must carry the new drop');
assertTrue($secondReport['dropped_events'] === ['queue_overflow' => 1], 'a drop during a retry must wait for the next request');
assertTrue($secondReport['report_id'] !== $firstReport['report_id'], 'new drops must use a new report ID');

// A report never pushes a request over the batch byte limit; it waits for a request with room.
$sizeClient = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxQueueSize: 1, maxBatchBytes: 400, captureRuntimeContext: false);
clientReportLog($sizeClient, 'evt_size_large', str_repeat('y', 200));
clientReportLog($sizeClient, 'evt_size_dropped');
$sizeTransport = RecordingTransport::alwaysAccept();
$sizeClient->flush($sizeTransport);
assertTrue(clientReportOf($sizeTransport->sentBodies[0]) === null, 'a report that does not fit must not ride in the request');
clientReportLog($sizeClient, 'evt_size_small');
$sizeClient->flush($sizeTransport);
$sizeReport = requireClientReport($sizeTransport->sentBodies[1], 'the waiting report must ride in the next request');
assertTrue($sizeReport['dropped_events'] === ['queue_overflow' => 1], 'the waiting report must ride in the next request with room');
foreach ($sizeTransport->sentBodies as $body) {
    assertTrue(strlen($body) <= 400, 'a request with a report must stay within the batch byte limit');
}

// A request stored by the persistent queue keeps its report ID after a restart.
$reportParent = sys_get_temp_dir() . '/logbrew-php-report-' . bin2hex(random_bytes(8));
assertTrue(mkdir($reportParent, 0700) && chmod($reportParent, 0700), 'failed to create the report test directory');
$reportDirectory = realpath($reportParent) . '/queue';
$reportKey = random_bytes(32);
$storedClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxRetries: 0,
    maxQueueSize: 1,
    eventStore: EncryptedFileEventStore::open($reportDirectory, $reportKey)
);
clientReportLog($storedClient, 'evt_stored_kept');
clientReportLog($storedClient, 'evt_stored_dropped');
$storedTransport = new RecordingTransport([new TransportError('network_error', 'offline')]);
expectThrows(static fn () => $storedClient->flush($storedTransport), 'transport request failed');
$storedReport = requireClientReport($storedTransport->sentBodies[0], 'the stored request must carry the report');
unset($storedClient);
$restartedClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: EncryptedFileEventStore::open($reportDirectory, $reportKey)
);
$restartedTransport = RecordingTransport::alwaysAccept();
$restartedClient->flush($restartedTransport);
$restartedReport = requireClientReport($restartedTransport->sentBodies[0], 'a restart must resend the stored report');
assertTrue(
    $restartedReport['report_id'] === $storedReport['report_id'],
    'a restart must resend the stored report under the same report ID'
);
$restartedClient->shutdown($restartedTransport);
unset($restartedClient);
removePersistentDeliveryDirectory($reportDirectory);

fwrite(STDOUT, 'php client report checks passed' . PHP_EOL);
