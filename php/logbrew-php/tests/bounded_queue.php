<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use LogBrew\DroppedEvent;
use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\SdkError;

function assertBoundedQueue(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, $message . PHP_EOL);
        exit(1);
    }
}

function expectBoundedQueueError(callable $callback, string $code, string $message): void
{
    try {
        $callback();
    } catch (SdkError $error) {
        assertBoundedQueue($error->codeName === $code, "expected {$code}, received {$error->codeName}");
        assertBoundedQueue(str_contains($error->getMessage(), $message), "expected error containing: {$message}");
        return;
    }

    fwrite(STDERR, "expected {$code} error" . PHP_EOL);
    exit(1);
}

expectBoundedQueueError(
    fn (): LogBrewClient => LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxQueueSize: 0),
    'validation_error',
    'maxQueueSize must be greater than zero'
);
expectBoundedQueueError(
    fn (): LogBrewClient => LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxQueueBytes: 0),
    'validation_error',
    'maxQueueBytes must be greater than zero'
);
$invalidJsonClient = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
expectBoundedQueueError(
    fn () => $invalidJsonClient->log('evt_invalid_json', '2026-07-12T10:00:00Z', ['message' => "\xB1\x31", 'level' => 'info']),
    'validation_error',
    'event must be JSON serializable'
);

/** @var list<DroppedEvent> $dropNotices */
$dropNotices = [];
$contextClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueSize: 2,
    maxQueueBytes: 1_048_576,
    onEventDropped: static function (DroppedEvent $event) use (&$dropNotices): void {
        $dropNotices[] = $event;
    }
);
$contextClient->release('evt_release_context', '2026-07-12T10:00:00Z', ['version' => '2.0.0']);
$contextClient->environment('evt_environment_context', '2026-07-12T10:00:01Z', ['name' => 'production']);
$contextClient->log('evt_log_dropped', '2026-07-12T10:00:02Z', ['message' => 'queue pressure', 'level' => 'warning']);

assertBoundedQueue($contextClient->pendingEvents() === 2, 'count pressure must preserve the existing queue');
assertBoundedQueue($contextClient->pendingEventBytes() > 0, 'queued event bytes must be observable');
assertBoundedQueue($contextClient->pendingEventBytes() <= 1_048_576, 'queued event bytes must stay bounded');
assertBoundedQueue($contextClient->droppedEvents() === 1, 'count pressure must increment the drop total');
assertBoundedQueue(count($dropNotices) === 1, 'count pressure must publish one local drop notice');

$notice = $dropNotices[0];
assertBoundedQueue($notice->eventId === 'evt_log_dropped', 'drop notice must identify the rejected event');
assertBoundedQueue($notice->eventType === 'log', 'drop notice must identify the rejected event type');
assertBoundedQueue($notice->reason === 'queue_overflow', 'count pressure must use a stable reason');
assertBoundedQueue($notice->droppedEvents === 1, 'drop notice must include the cumulative drop total');
assertBoundedQueue($notice->pendingEvents === 2, 'drop notice must include the retained event count');
assertBoundedQueue($notice->pendingEventBytes === $contextClient->pendingEventBytes(), 'drop notice must include retained event bytes');
assertBoundedQueue(
    array_keys(get_object_vars($notice)) === [
        'eventId',
        'eventType',
        'reason',
        'droppedEvents',
        'pendingEvents',
        'pendingEventBytes',
    ],
    'drop notice must not expose event attributes or payload content'
);

$contextPayload = json_decode($contextClient->previewJson(), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($contextPayload)) {
    fwrite(STDERR, 'preview payload must decode to an array' . PHP_EOL);
    exit(1);
}
$contextEvents = $contextPayload['events'] ?? null;
if (!is_array($contextEvents)) {
    fwrite(STDERR, 'preview payload events must decode to an array' . PHP_EOL);
    exit(1);
}
assertBoundedQueue(
    array_column($contextEvents, 'type') === ['release', 'environment'],
    'drop-new behavior must retain earlier release and environment context'
);
assertBoundedQueue(!str_contains($contextClient->previewJson(), 'queue pressure'), 'rejected content must stay out of the queued payload');

$oversizedNotices = [];
$oversizedClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueSize: 10,
    maxQueueBytes: 256,
    onEventDropped: static function (DroppedEvent $event) use (&$oversizedNotices): void {
        $oversizedNotices[] = $event;
    }
);
$oversizedClient->log('evt_log_oversized', '2026-07-12T10:00:03Z', [
    'message' => str_repeat('private-content-', 100),
    'level' => 'error',
]);
assertBoundedQueue($oversizedClient->pendingEvents() === 0, 'an oversized event must not enter the queue');
assertBoundedQueue($oversizedClient->pendingEventBytes() === 0, 'an oversized event must not consume queue bytes');
assertBoundedQueue($oversizedClient->droppedEvents() === 1, 'an oversized event must increment the drop total');
assertBoundedQueue(count($oversizedNotices) === 1, 'an oversized event must publish one local notice');
assertBoundedQueue($oversizedNotices[0]->reason === 'event_too_large', 'an oversized event must use a stable reason');
assertBoundedQueue(
    !str_contains(json_encode(get_object_vars($oversizedNotices[0]), JSON_THROW_ON_ERROR), 'private-content'),
    'drop notices must exclude rejected event content'
);

$byteProbe = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$byteProbe->log('evt_byte_a', '2026-07-12T10:00:04Z', ['message' => 'same size', 'level' => 'info']);
$singleEventBytes = $byteProbe->pendingEventBytes();
$aggregateByteReason = null;
$aggregateByteClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueSize: 10,
    maxQueueBytes: $singleEventBytes + 1,
    onEventDropped: static function (DroppedEvent $event) use (&$aggregateByteReason): void {
        $aggregateByteReason = $event->reason;
    }
);
$aggregateByteClient->log('evt_byte_a', '2026-07-12T10:00:04Z', ['message' => 'same size', 'level' => 'info']);
$aggregateByteClient->log('evt_byte_b', '2026-07-12T10:00:04Z', ['message' => 'same size', 'level' => 'info']);
assertBoundedQueue($aggregateByteClient->pendingEvents() === 1, 'aggregate byte pressure must retain the first event');
assertBoundedQueue($aggregateByteClient->pendingEventBytes() === $singleEventBytes, 'aggregate byte pressure must retain exact byte accounting');
assertBoundedQueue($aggregateByteClient->droppedEvents() === 1, 'aggregate byte pressure must increment the drop total');
assertBoundedQueue($aggregateByteReason === 'queue_overflow', 'aggregate byte pressure must use the queue overflow reason');

$fullQueueReason = null;
$fullQueueClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueSize: 1,
    onEventDropped: static function (DroppedEvent $event) use (&$fullQueueReason): void {
        $fullQueueReason = $event->reason;
    }
);
$fullQueueClient->log('evt_log_full_queue', '2026-07-12T10:00:04Z', ['message' => 'retained', 'level' => 'info']);
$fullQueueClient->log('evt_log_no_serialization', '2026-07-12T10:00:05Z', ['message' => "\xB1\x31", 'level' => 'info']);
assertBoundedQueue($fullQueueClient->pendingEvents() === 1, 'a full queue must retain its existing event');
assertBoundedQueue($fullQueueClient->droppedEvents() === 1, 'a full queue must reject without serializing new content');
assertBoundedQueue($fullQueueReason === 'queue_overflow', 'a full queue must report count pressure first');

$callbackFailureClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueSize: 1,
    onEventDropped: static function (): void {
        throw new RuntimeException('app callback failed');
    }
);
$callbackFailureClient->log('evt_log_retained', '2026-07-12T10:00:06Z', ['message' => 'retained', 'level' => 'info']);
$callbackFailureClient->log('evt_log_callback_failure', '2026-07-12T10:00:07Z', ['message' => 'dropped', 'level' => 'info']);
assertBoundedQueue($callbackFailureClient->pendingEvents() === 1, 'drop callback failures must not change queue state');
assertBoundedQueue($callbackFailureClient->droppedEvents() === 1, 'drop callback failures must not hide local loss');

$failedFlushClient = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxQueueSize: 2);
$failedFlushClient->log('evt_log_failed_flush', '2026-07-12T10:00:08Z', ['message' => 'preserve me', 'level' => 'error']);
$failedFlushBytes = $failedFlushClient->pendingEventBytes();
expectBoundedQueueError(
    fn () => $failedFlushClient->flush(new RecordingTransport([400])),
    'transport_error',
    'unexpected transport status 400'
);
assertBoundedQueue($failedFlushClient->pendingEvents() === 1, 'failed flush must preserve queued events');
assertBoundedQueue($failedFlushClient->pendingEventBytes() === $failedFlushBytes, 'failed flush must preserve queued byte accounting');

$retryClient = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxQueueSize: 2);
$retryClient->release('evt_release_retry', '2026-07-12T10:00:09Z', ['version' => '2.0.0']);
$retryClient->log('evt_log_retry', '2026-07-12T10:00:10Z', ['message' => 'retry me', 'level' => 'warning']);
$retryTransport = new RecordingTransport([503, 202]);
$retryResponse = $retryClient->shutdown($retryTransport);
assertBoundedQueue($retryResponse->statusCode === 202, 'shutdown retry must eventually accept the batch');
assertBoundedQueue($retryResponse->attempts === 2, 'shutdown retry must report both attempts');
assertBoundedQueue(count($retryTransport->sentBodies) === 2, 'shutdown retry must send twice');
assertBoundedQueue($retryTransport->sentBodies[0] === $retryTransport->sentBodies[1], 'shutdown retry body must be byte-identical');
assertBoundedQueue($retryClient->pendingEvents() === 0, 'successful shutdown must clear queued events');
assertBoundedQueue($retryClient->pendingEventBytes() === 0, 'successful shutdown must clear queued byte accounting');
expectBoundedQueueError(
    fn () => $retryClient->log('evt_log_after_shutdown', '2026-07-12T10:00:11Z', ['message' => 'closed', 'level' => 'info']),
    'shutdown_error',
    'client is already shut down'
);

$defaultDropCount = 0;
$highLoadClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    onEventDropped: static function (DroppedEvent $event) use (&$defaultDropCount): void {
        $defaultDropCount = $event->droppedEvents;
    }
);
for ($index = 0; $index < 1_500; $index++) {
    $highLoadClient->log(
        sprintf('evt_high_load_%04d', $index),
        '2026-07-12T10:00:12Z',
        ['message' => 'bounded load', 'level' => 'info']
    );
}
assertBoundedQueue($highLoadClient->pendingEvents() === 1_000, 'default queue must retain exactly 1,000 events');
assertBoundedQueue($highLoadClient->droppedEvents() === 500, 'default queue must report exactly 500 dropped events');
assertBoundedQueue($defaultDropCount === 500, 'default queue callback must expose the final drop total');
assertBoundedQueue($highLoadClient->pendingEventBytes() > 0, 'default queue must expose retained event bytes');

fwrite(STDOUT, "php bounded queue checks passed\n");
