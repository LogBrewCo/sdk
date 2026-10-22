<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use LogBrew\DroppedEvent;
use LogBrew\EncryptedFileEventStore;
use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\TransportError;

/** @return list<string> */
function persistentEvictionQueuedIds(LogBrewClient $client): array
{
    $payload = json_decode($client->previewJson(), true, 512, JSON_THROW_ON_ERROR);
    $events = is_array($payload) ? ($payload['events'] ?? null) : null;
    if (!is_array($events)) {
        throw new RuntimeException('preview payload must list events');
    }
    $ids = [];
    foreach ($events as $event) {
        $id = is_array($event) ? ($event['id'] ?? null) : null;
        if (!is_string($id)) {
            throw new RuntimeException('preview events must have IDs');
        }
        $ids[] = $id;
    }
    return $ids;
}

function persistentEvictionLog(LogBrewClient $client, string $id, string $message = 'queued'): void
{
    $client->log($id, '2026-07-16T10:00:00Z', ['message' => $message, 'level' => 'info']);
}

/**
 * @param list<DroppedEvent> $notices
 * @param array<string, mixed> $options
 */
function persistentEvictionClient(EncryptedFileEventStore $store, array &$notices, array $options = []): LogBrewClient
{
    $maxQueueSize = $options['maxQueueSize'] ?? 3;
    $maxQueueBytes = $options['maxQueueBytes'] ?? 4_194_304;
    $maxBatchEvents = $options['maxBatchEvents'] ?? 100;
    if (!is_int($maxQueueSize) || !is_int($maxQueueBytes) || !is_int($maxBatchEvents)) {
        throw new RuntimeException('client options must be integers');
    }
    return LogBrewClient::create(
        'LOGBREW_API_KEY',
        'logbrew-php',
        '0.1.0',
        maxRetries: 0,
        maxQueueSize: $maxQueueSize,
        maxQueueBytes: $maxQueueBytes,
        onEventDropped: static function (DroppedEvent $event) use (&$notices): void {
            $notices[] = $event;
        },
        maxBatchEvents: $maxBatchEvents,
        eventStore: $store,
        captureRuntimeContext: false
    );
}

// A crash report at a full persistent queue replaces the oldest event and survives a restart.
$evictDirectory = persistentDeliveryDirectory();
$evictKey = random_bytes(32);
$evictStore = EncryptedFileEventStore::open($evictDirectory, $evictKey);
$evictNotices = [];
$evictClient = persistentEvictionClient($evictStore, $evictNotices);
persistentEvictionLog($evictClient, 'evt_stored_1');
persistentEvictionLog($evictClient, 'evt_stored_2');
persistentEvictionLog($evictClient, 'evt_stored_3');
$evictClient->issue('evt_stored_crash', '2026-07-16T10:00:01Z', ['title' => 'App crashed', 'level' => 'fatal']);
assertTrue(
    persistentEvictionQueuedIds($evictClient) === ['evt_stored_crash', 'evt_stored_2', 'evt_stored_3'],
    'a crash report at a full persistent queue must take the place of the oldest event'
);
assertTrue(count($evictNotices) === 1 && $evictNotices[0]->eventId === 'evt_stored_1', 'eviction must report the removed event');
assertTrue($evictNotices[0]->reason === 'evicted_for_fatal', 'persistent eviction must use the stable reason');
assertTrue(count(persistentDeliveryEventFiles($evictDirectory)) === 3, 'the stored queue must stay within its bound');
persistentEvictionLog($evictClient, 'evt_stored_4');
assertTrue($evictNotices[1]->reason === 'queue_overflow', 'other events must still be dropped at a full persistent queue');
$evictStore->close();
unset($evictClient, $evictStore);

$reopenedNotices = [];
$reopenedStore = EncryptedFileEventStore::open($evictDirectory, $evictKey);
$reopenedClient = persistentEvictionClient($reopenedStore, $reopenedNotices);
assertTrue(
    persistentEvictionQueuedIds($reopenedClient) === ['evt_stored_crash', 'evt_stored_2', 'evt_stored_3'],
    'a restart must recover the crash report without the evicted event'
);
$reopenedTransport = RecordingTransport::alwaysAccept();
$reopenedClient->shutdown($reopenedTransport);
assertTrue(
    str_contains($reopenedTransport->sentBodies[0], 'evt_stored_crash') && !str_contains($reopenedTransport->sentBodies[0], 'evt_stored_1'),
    'the recovered crash report must be delivered without the evicted event'
);
assertTrue(persistentDeliveryEventFiles($evictDirectory) === [], 'delivery must remove the stored events');
unset($reopenedClient, $reopenedStore);
removePersistentDeliveryDirectory($evictDirectory);

// The stored request being retried and other crash reports are never evicted.
$retryDirectory = persistentDeliveryDirectory();
$retryKey = random_bytes(32);
$retryStore = EncryptedFileEventStore::open($retryDirectory, $retryKey);
$retryNotices = [];
$retryClient = persistentEvictionClient($retryStore, $retryNotices, ['maxQueueSize' => 4, 'maxBatchEvents' => 2]);
persistentEvictionLog($retryClient, 'evt_retry_1');
persistentEvictionLog($retryClient, 'evt_retry_2');
$retryClient->issue('evt_retry_crash_1', '2026-07-16T10:01:00Z', ['title' => 'First crash', 'level' => 'critical']);
persistentEvictionLog($retryClient, 'evt_retry_3');
$failedTransport = new RecordingTransport([new TransportError('network_error', 'offline')]);
expectThrows(static fn () => $retryClient->flush($failedTransport), 'transport request failed');
$retryClient->issue('evt_retry_crash_2', '2026-07-16T10:01:01Z', ['title' => 'Second crash', 'level' => 'fatal']);
$retryClient->issue('evt_retry_crash_3', '2026-07-16T10:01:02Z', ['title' => 'Third crash', 'level' => 'fatal']);
assertTrue(
    persistentEvictionQueuedIds($retryClient) === ['evt_retry_1', 'evt_retry_2', 'evt_retry_crash_1', 'evt_retry_crash_2'],
    'a crash report must not evict the stored retry request or another crash report'
);
assertTrue(
    array_map(static fn (DroppedEvent $event): string => $event->eventId . ':' . $event->reason, $retryNotices)
        === ['evt_retry_3:evicted_for_fatal', 'evt_retry_crash_3:queue_overflow'],
    'a crash report without room must be dropped'
);
$retryStore->close();
unset($retryClient, $retryStore);

$retryReopenedNotices = [];
$retryReopenedStore = EncryptedFileEventStore::open($retryDirectory, $retryKey);
$retryReopenedClient = persistentEvictionClient($retryReopenedStore, $retryReopenedNotices, ['maxQueueSize' => 4, 'maxBatchEvents' => 2]);
$retryTransport = RecordingTransport::alwaysAccept();
$retryReopenedClient->shutdown($retryTransport);
assertTrue($retryTransport->sentBodies[0] === $failedTransport->sentBodies[0], 'a restart must resend the stored request unchanged');
assertTrue(
    str_contains($retryTransport->sentBodies[1], 'evt_retry_crash_2') && !str_contains($retryTransport->sentBodies[1], 'evt_retry_3'),
    'the recovered queue must hold the new crash report instead of the evicted event'
);
unset($retryReopenedClient, $retryReopenedStore);
removePersistentDeliveryDirectory($retryDirectory);

// Byte pressure can evict several events; the stored queue stays within its byte bound after a restart.
$bytesDirectory = persistentDeliveryDirectory();
$bytesKey = random_bytes(32);
$bytesStore = EncryptedFileEventStore::open($bytesDirectory, $bytesKey);
$bytesNotices = [];
$bytesClient = persistentEvictionClient($bytesStore, $bytesNotices, ['maxQueueSize' => 10, 'maxQueueBytes' => 700]);
persistentEvictionLog($bytesClient, 'evt_bytes_1', str_repeat('a', 100));
persistentEvictionLog($bytesClient, 'evt_bytes_2', str_repeat('b', 100));
persistentEvictionLog($bytesClient, 'evt_bytes_3', str_repeat('c', 100));
$bytesClient->issue('evt_bytes_crash', '2026-07-16T10:02:00Z', ['title' => str_repeat('x', 300), 'level' => 'fatal']);
assertTrue(
    persistentEvictionQueuedIds($bytesClient) === ['evt_bytes_crash', 'evt_bytes_3'],
    'byte pressure must evict the oldest events for a crash report'
);
assertTrue(
    array_map(static fn (DroppedEvent $event): string => $event->eventId, $bytesNotices) === ['evt_bytes_1', 'evt_bytes_2'],
    'byte pressure eviction must report each removed event oldest first'
);
assertTrue($bytesClient->pendingEventBytes() <= 700, 'eviction must keep queued bytes within the limit');
$bytesStore->close();
unset($bytesClient, $bytesStore);

$bytesReopenedNotices = [];
$bytesReopenedStore = EncryptedFileEventStore::open($bytesDirectory, $bytesKey);
$bytesReopenedClient = persistentEvictionClient($bytesReopenedStore, $bytesReopenedNotices, ['maxQueueSize' => 10, 'maxQueueBytes' => 700]);
assertTrue(
    persistentEvictionQueuedIds($bytesReopenedClient) === ['evt_bytes_crash', 'evt_bytes_3'],
    'a restart must recover the byte pressure eviction'
);
$bytesReopenedClient->shutdown(RecordingTransport::alwaysAccept());
unset($bytesReopenedClient, $bytesReopenedStore);
removePersistentDeliveryDirectory($bytesDirectory);

// LogBrew counts each eviction from the persistent queue in the next request.
$reportDirectory = persistentDeliveryDirectory();
$reportStore = EncryptedFileEventStore::open($reportDirectory, random_bytes(32));
$reportNotices = [];
$reportClient = persistentEvictionClient($reportStore, $reportNotices, ['maxQueueSize' => 1]);
persistentEvictionLog($reportClient, 'evt_report_1');
$reportClient->issue('evt_report_crash', '2026-07-16T10:03:00Z', ['title' => 'App crashed', 'level' => 'fatal']);
$reportTransport = RecordingTransport::alwaysAccept();
$reportClient->shutdown($reportTransport);
assertTrue(
    requireClientReport($reportTransport->sentBodies[0], 'the next request must carry a client report')['dropped_events']
        === ['evicted_for_fatal' => 1],
    'the client report must count the persistent eviction'
);
unset($reportClient, $reportStore);
removePersistentDeliveryDirectory($reportDirectory);

fwrite(STDOUT, 'php persistent fatal eviction checks passed' . PHP_EOL);
