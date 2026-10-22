<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use LogBrew\DroppedEvent;
use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\TransportError;

/** @return list<string> */
function fatalEvictionQueuedIds(LogBrewClient $client): array
{
    $payload = json_decode($client->previewJson(), true, 512, JSON_THROW_ON_ERROR);
    $events = is_array($payload) ? ($payload['events'] ?? null) : null;
    if (!is_array($events)) {
        fwrite(STDERR, 'preview payload must list events' . PHP_EOL);
        exit(1);
    }
    /** @var list<array{id:string}> $events */
    return array_column($events, 'id');
}

/** @var list<DroppedEvent> $evictionNotices */
$evictionNotices = [];
$evictionClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueSize: 3,
    onEventDropped: static function (DroppedEvent $event) use (&$evictionNotices): void {
        $evictionNotices[] = $event;
    }
);
$evictionClient->log('evt_log_1', '2026-07-12T10:00:00Z', ['message' => 'first', 'level' => 'info']);
$evictionClient->log('evt_log_2', '2026-07-12T10:00:01Z', ['message' => 'second', 'level' => 'info']);
$evictionClient->log('evt_log_3', '2026-07-12T10:00:02Z', ['message' => 'third', 'level' => 'info']);
$evictionClient->issue('evt_crash_1', '2026-07-12T10:00:03Z', ['title' => 'App crashed', 'level' => 'fatal']);

assertTrue(
    fatalEvictionQueuedIds($evictionClient) === ['evt_log_2', 'evt_log_3', 'evt_crash_1'],
    'a crash report at a full queue must replace the oldest queued event'
);
assertTrue(count($evictionNotices) === 1, 'eviction must publish one drop notice');
assertTrue($evictionNotices[0]->eventId === 'evt_log_1', 'eviction notice must identify the removed event');
assertTrue($evictionNotices[0]->reason === 'evicted_for_fatal', 'eviction must use a stable reason');
assertTrue($evictionNotices[0]->pendingEvents === 3, 'eviction notice must report the queue after admission');
assertTrue($evictionClient->droppedEvents() === 1, 'eviction must count as a drop');

$evictionClient->log('evt_log_4', '2026-07-12T10:00:04Z', ['message' => 'fourth', 'level' => 'error']);
assertTrue($evictionNotices[1]->reason === 'queue_overflow', 'other events must still be dropped at a full queue');
assertTrue(
    fatalEvictionQueuedIds($evictionClient) === ['evt_log_2', 'evt_log_3', 'evt_crash_1'],
    'a dropped event must leave the queue unchanged'
);

/** @var list<DroppedEvent> $retryNotices */
$retryNotices = [];
$retryClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueSize: 3,
    maxBatchEvents: 2,
    onEventDropped: static function (DroppedEvent $event) use (&$retryNotices): void {
        $retryNotices[] = $event;
    }
);
$retryClient->log('evt_retry_1', '2026-07-12T10:01:00Z', ['message' => 'first', 'level' => 'info']);
$retryClient->log('evt_retry_2', '2026-07-12T10:01:01Z', ['message' => 'second', 'level' => 'info']);
$retryClient->issue('evt_retry_crash_1', '2026-07-12T10:01:02Z', ['title' => 'First crash', 'level' => 'critical']);
expectThrows(
    static fn () => $retryClient->flush(new RecordingTransport([new TransportError('network_error', 'offline')])),
    'transport request failed'
);
$retryClient->issue('evt_retry_crash_2', '2026-07-12T10:01:03Z', ['title' => 'Second crash', 'level' => 'fatal']);

assertTrue(
    fatalEvictionQueuedIds($retryClient) === ['evt_retry_1', 'evt_retry_2', 'evt_retry_crash_1'],
    'a crash report must not evict the batch being retried or another crash report'
);
assertTrue(count($retryNotices) === 1, 'a crash report without room must publish one drop notice');
assertTrue($retryNotices[0]->eventId === 'evt_retry_crash_2', 'the new crash report must be the dropped event');
assertTrue($retryNotices[0]->reason === 'queue_overflow', 'a crash report without room must use the overflow reason');

$retryTransport = RecordingTransport::alwaysAccept();
$retryClient->flush($retryTransport);
assertTrue(
    str_contains($retryTransport->sentBodies[0], 'evt_retry_1') && str_contains($retryTransport->sentBodies[0], 'evt_retry_2'),
    'the retried batch must be sent unchanged'
);

/** @var list<DroppedEvent> $bytesNotices */
$bytesNotices = [];
$bytesClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueSize: 10,
    maxQueueBytes: 900,
    onEventDropped: static function (DroppedEvent $event) use (&$bytesNotices): void {
        $bytesNotices[] = $event;
    }
);
$bytesClient->log('evt_bytes_1', '2026-07-12T10:02:00Z', ['message' => str_repeat('a', 150), 'level' => 'info']);
$bytesClient->log('evt_bytes_2', '2026-07-12T10:02:01Z', ['message' => str_repeat('b', 150), 'level' => 'info']);
$bytesClient->issue('evt_bytes_crash', '2026-07-12T10:02:02Z', ['title' => str_repeat('x', 150), 'level' => 'fatal']);

assertTrue(
    fatalEvictionQueuedIds($bytesClient) === ['evt_bytes_2', 'evt_bytes_crash'],
    'a crash report at full queue bytes must replace the oldest queued event'
);
assertTrue($bytesClient->pendingEventBytes() <= 900, 'eviction must keep queued bytes within the limit');
assertTrue(count($bytesNotices) === 1, 'byte pressure eviction must publish one drop notice');
assertTrue($bytesNotices[0]->eventId === 'evt_bytes_1', 'byte pressure eviction must identify the removed event');
assertTrue($bytesNotices[0]->reason === 'evicted_for_fatal', 'byte pressure eviction must use a stable reason');

fwrite(STDOUT, 'php fatal eviction checks passed' . PHP_EOL);
