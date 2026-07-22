<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use LogBrew\DroppedEvent;
use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\SdkError;
use LogBrew\Transport;
use LogBrew\TransportResponse;

function assertBoundedBatching(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, $message . PHP_EOL);
        exit(1);
    }
}

function expectBoundedBatchingError(callable $callback, string $code, string $message): void
{
    try {
        $callback();
    } catch (SdkError $error) {
        assertBoundedBatching($error->codeName === $code, "expected {$code}, received {$error->codeName}");
        assertBoundedBatching(str_contains($error->getMessage(), $message), "expected error containing: {$message}");
        return;
    }

    fwrite(STDERR, "expected {$code} error" . PHP_EOL);
    exit(1);
}

/** @return list<string> */
function boundedBatchingEventIds(string $body): array
{
    $payload = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($payload)) {
        fwrite(STDERR, 'batch payload must decode to an array' . PHP_EOL);
        exit(1);
    }
    $events = $payload['events'] ?? null;
    if (!is_array($events)) {
        fwrite(STDERR, 'batch events must decode to an array' . PHP_EOL);
        exit(1);
    }

    $ids = [];
    foreach ($events as $event) {
        if (!is_array($event) || !is_string($event['id'] ?? null)) {
            fwrite(STDERR, 'every batched event must have a string id' . PHP_EOL);
            exit(1);
        }
        $ids[] = $event['id'];
    }
    return $ids;
}

expectBoundedBatchingError(
    fn (): LogBrewClient => LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxRetries: -1),
    'validation_error',
    'maxRetries must be non-negative'
);
expectBoundedBatchingError(
    fn (): LogBrewClient => LogBrewClient::create('LOGBREW_API_KEY', "logbrew-\xB1\x31", '0.1.0'),
    'validation_error',
    'sdk identity must be JSON serializable'
);
expectBoundedBatchingError(
    fn (): LogBrewClient => LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxBatchEvents: 0),
    'validation_error',
    'maxBatchEvents must be greater than zero'
);
expectBoundedBatchingError(
    fn (): LogBrewClient => LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxBatchBytes: 0),
    'validation_error',
    'maxBatchBytes must be greater than zero'
);
$singleTransportResponse = RecordingTransport::alwaysAccept()->send('LOGBREW_API_KEY', '{}');
assertBoundedBatching($singleTransportResponse->batches === 1, 'a direct transport response must represent one request batch');

$countClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxRetries: 1,
    maxBatchEvents: 2,
    maxBatchBytes: 1_048_576
);
for ($index = 0; $index < 5; $index++) {
    $countClient->log(
        sprintf('evt_count_%d', $index),
        '2026-07-12T10:00:00Z',
        ['message' => 'count split', 'level' => 'info']
    );
}
$countTransport = new RecordingTransport([503, 202, 202, 202]);
$countResponse = $countClient->flush($countTransport);
assertBoundedBatching($countResponse->statusCode === 202, 'count split must return the final accepted status');
assertBoundedBatching($countResponse->attempts === 4, 'count split must aggregate all transport attempts');
assertBoundedBatching($countResponse->batches === 3, 'count split must report three accepted batches');
assertBoundedBatching(count($countTransport->sentBodies) === 4, 'count split must retry once and send three batches');
assertBoundedBatching($countTransport->sentBodies[0] === $countTransport->sentBodies[1], 'retry body must be byte-identical');
assertBoundedBatching(!str_contains($countTransport->sentBodies[0], "\n"), 'transport batches must use compact JSON');
assertBoundedBatching(
    array_map('boundedBatchingEventIds', $countTransport->sentBodies) === [
        ['evt_count_0', 'evt_count_1'],
        ['evt_count_0', 'evt_count_1'],
        ['evt_count_2', 'evt_count_3'],
        ['evt_count_4'],
    ],
    'count split must preserve ordered immutable batch prefixes'
);
assertBoundedBatching($countClient->pendingEvents() === 0, 'count split must acknowledge every accepted event');

$byteProbe = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$byteProbe->log('evt_utf8_a', '2026-07-12T10:00:01Z', ['message' => 'espresso-☕', 'level' => 'info']);
$singleEventBody = json_encode(
    json_decode($byteProbe->previewJson(), true, 512, JSON_THROW_ON_ERROR),
    JSON_THROW_ON_ERROR
);
$singleEventBodyBytes = strlen($singleEventBody);

$byteClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxBatchEvents: 10,
    maxBatchBytes: $singleEventBodyBytes
);
$byteClient->log('evt_utf8_a', '2026-07-12T10:00:01Z', ['message' => 'espresso-☕', 'level' => 'info']);
$byteClient->log('evt_utf8_b', '2026-07-12T10:00:01Z', ['message' => 'espresso-☕', 'level' => 'info']);
$byteTransport = RecordingTransport::alwaysAccept();
$byteResponse = $byteClient->flush($byteTransport);
assertBoundedBatching($byteResponse->batches === 2, 'exact byte limit must split two events into two batches');
assertBoundedBatching(count($byteTransport->sentBodies) === 2, 'exact byte limit must send twice');
assertBoundedBatching(
    array_map('strlen', $byteTransport->sentBodies) === [$singleEventBodyBytes, $singleEventBodyBytes],
    'each UTF-8 batch must match the exact configured byte limit'
);

$batchDropReason = null;
$batchDropClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueBytes: 1_048_576,
    maxBatchBytes: 256,
    onEventDropped: static function (DroppedEvent $event) use (&$batchDropReason): void {
        $batchDropReason = $event->reason;
    }
);
$batchDropClient->log('evt_batch_oversized', '2026-07-12T10:00:02Z', [
    'message' => str_repeat('private-batch-content-', 100),
    'level' => 'error',
]);
assertBoundedBatching($batchDropClient->pendingEvents() === 0, 'an event larger than one batch must not enter the queue');
assertBoundedBatching($batchDropReason === 'event_too_large', 'batch-oversized events must use the stable reason');

$partialClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxRetries: 0,
    maxBatchEvents: 2
);
for ($index = 0; $index < 5; $index++) {
    $partialClient->log(
        sprintf('evt_partial_%d', $index),
        '2026-07-12T10:00:03Z',
        ['message' => 'partial delivery', 'level' => 'warning']
    );
}
expectBoundedBatchingError(
    fn (): TransportResponse => $partialClient->flush(new RecordingTransport([202, 500])),
    'transport_error',
    'unexpected transport status 500'
);
assertBoundedBatching($partialClient->pendingEvents() === 3, 'partial success must remove only the accepted prefix');
assertBoundedBatching(
    boundedBatchingEventIds($partialClient->previewJson()) === ['evt_partial_2', 'evt_partial_3', 'evt_partial_4'],
    'partial failure must retain the failed and later events in order'
);
$partialRetry = RecordingTransport::alwaysAccept();
$partialResponse = $partialClient->flush($partialRetry);
assertBoundedBatching($partialResponse->batches === 2, 'retained partial queue must drain in two batches');
assertBoundedBatching(
    array_map('boundedBatchingEventIds', $partialRetry->sentBodies) === [
        ['evt_partial_2', 'evt_partial_3'],
        ['evt_partial_4'],
    ],
    'partial retry must resume at the first unacknowledged event'
);

$reentrantClient = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$reentrantClient->log('evt_before_flush', '2026-07-12T10:00:04Z', ['message' => 'before', 'level' => 'info']);
$reentrantTransport = new class($reentrantClient) implements Transport {
    public ?SdkError $flushError = null;

    public function __construct(private readonly LogBrewClient $client)
    {
    }

    public function send(string $apiKey, string $body): TransportResponse
    {
        $this->client->log('evt_during_flush', '2026-07-12T10:00:05Z', ['message' => 'during', 'level' => 'info']);
        try {
            $this->client->flush(RecordingTransport::alwaysAccept());
        } catch (SdkError $error) {
            $this->flushError = $error;
        }
        return new TransportResponse(202, 1);
    }
};
$reentrantResponse = $reentrantClient->flush($reentrantTransport);
assertBoundedBatching($reentrantResponse->batches === 1, 'outer flush must accept its original snapshot');
assertBoundedBatching($reentrantClient->pendingEvents() === 1, 'capture during transport I/O must remain queued');
assertBoundedBatching($reentrantTransport->flushError?->codeName === 'flush_error', 'reentrant flush must fail with a stable code');
assertBoundedBatching(
    boundedBatchingEventIds($reentrantClient->previewJson()) === ['evt_during_flush'],
    'only in-flight capture must remain'
);
$reentrantClient->flush(RecordingTransport::alwaysAccept());

$shutdownClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxRetries: 0
);
$shutdownClient->log('evt_shutdown_original', '2026-07-12T10:00:06Z', ['message' => 'original', 'level' => 'info']);
$shutdownTransport = new class($shutdownClient) implements Transport {
    public ?SdkError $captureError = null;

    public function __construct(private readonly LogBrewClient $client)
    {
    }

    public function send(string $apiKey, string $body): TransportResponse
    {
        try {
            $this->client->log('evt_shutdown_reentrant', '2026-07-12T10:00:07Z', ['message' => 'blocked', 'level' => 'info']);
        } catch (SdkError $error) {
            $this->captureError = $error;
        }
        return new TransportResponse(500, 1);
    }
};
expectBoundedBatchingError(
    fn (): TransportResponse => $shutdownClient->shutdown($shutdownTransport),
    'transport_error',
    'unexpected transport status 500'
);
assertBoundedBatching($shutdownTransport->captureError?->codeName === 'shutdown_error', 'shutdown must reject transport-time capture');
assertBoundedBatching($shutdownClient->pendingEvents() === 1, 'failed shutdown must retain the original event');
$shutdownClient->log('evt_after_failed_shutdown', '2026-07-12T10:00:08Z', ['message' => 'reopened', 'level' => 'info']);
assertBoundedBatching($shutdownClient->pendingEvents() === 2, 'failed shutdown must reopen capture');
$shutdownRecoveryTransport = RecordingTransport::alwaysAccept();
$shutdownResponse = $shutdownClient->shutdown($shutdownRecoveryTransport);
assertBoundedBatching($shutdownResponse->batches === 2, 'recovered shutdown must preserve the failed batch boundary');
assertBoundedBatching(
    array_map('boundedBatchingEventIds', $shutdownRecoveryTransport->sentBodies) === [
        ['evt_shutdown_original'],
        ['evt_after_failed_shutdown'],
    ],
    'recovered shutdown must retry the original body before later capture'
);
expectBoundedBatchingError(
    fn () => $shutdownClient->log('evt_after_shutdown', '2026-07-12T10:00:09Z', ['message' => 'closed', 'level' => 'info']),
    'shutdown_error',
    'client is already shut down'
);

fwrite(STDOUT, "php bounded batching checks passed\n");
