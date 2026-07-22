<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use LogBrew\EncryptedFileEventStore;
use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\SdkError;
use LogBrew\Transport;
use LogBrew\TransportResponse;

function assertPersistentDelivery(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, $message . PHP_EOL);
        exit(1);
    }
}

function persistentDeliveryDirectory(): string
{
    $parent = sys_get_temp_dir() . '/logbrew-php-persistence-' . bin2hex(random_bytes(8));
    if (!mkdir($parent, 0700) || !chmod($parent, 0700)) {
        throw new RuntimeException('failed to create test parent directory');
    }

    $resolvedParent = realpath($parent);
    if ($resolvedParent === false) {
        throw new RuntimeException('failed to resolve test parent directory');
    }

    return $resolvedParent . '/queue';
}

function removePersistentDeliveryDirectory(string $directory, bool $removeParent = true): void
{
    if (!is_dir($directory)) {
        return;
    }
    $entries = scandir($directory);
    if ($entries === false) {
        throw new RuntimeException('failed to list test directory');
    }
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        if (!unlink($directory . '/' . $entry)) {
            throw new RuntimeException('failed to remove test file');
        }
    }
    if (!rmdir($directory)) {
        throw new RuntimeException('failed to remove test directory');
    }
    if ($removeParent) {
        $parent = dirname($directory);
        if (!rmdir($parent)) {
            throw new RuntimeException('failed to remove test parent directory');
        }
    }
}

/** @return list<string> */
function persistentDeliveryEventFiles(string $directory): array
{
    $files = glob($directory . '/*.event');
    if (!is_array($files)) {
        throw new RuntimeException('failed to list persistent event files');
    }

    return $files;
}

function expectPersistentDeliveryError(callable $callback, string $codeName): SdkError
{
    try {
        $callback();
    } catch (SdkError $error) {
        assertPersistentDelivery($error->codeName === $codeName, 'persistent failure must use the expected stable code');
        return $error;
    }

    throw new RuntimeException('expected persistent delivery error was not thrown');
}

$directory = persistentDeliveryDirectory();
$key = random_bytes(32);
$store = EncryptedFileEventStore::open($directory, $key);
$client = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $store
);
$client->log('evt_persisted', '2026-07-14T08:00:00Z', [
    'message' => 'restart-safe delivery',
    'level' => 'warning',
]);

assertPersistentDelivery($client->pendingEvents() === 1, 'persistent capture must remain queued');
$storedBytes = '';
$entries = scandir($directory);
assertPersistentDelivery(is_array($entries), 'persistent directory must be readable');
foreach ($entries as $entry) {
    if ($entry === '.' || $entry === '..') {
        continue;
    }
    $contents = file_get_contents($directory . '/' . $entry);
    assertPersistentDelivery(is_string($contents), 'persistent file must be readable');
    $storedBytes .= $contents;
}
assertPersistentDelivery(!str_contains($storedBytes, 'evt_persisted'), 'event id must be encrypted at rest');
assertPersistentDelivery(!str_contains($storedBytes, 'restart-safe delivery'), 'event content must be encrypted at rest');
assertPersistentDelivery(!str_contains($storedBytes, $key), 'encryption key must not be stored in the queue');

$store->close();
unset($client, $store);

$reopenedStore = EncryptedFileEventStore::open($directory, $key);
$reopenedClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $reopenedStore
);
assertPersistentDelivery($reopenedClient->pendingEvents() === 1, 'restart must recover the persisted event');
assertPersistentDelivery(str_contains($reopenedClient->previewJson(), 'evt_persisted'), 'restart must preserve the event id');
$reopenedClient->purgePersistedEvents();
$reopenedStore->close();
removePersistentDeliveryDirectory($directory);

$retryDirectory = persistentDeliveryDirectory();
$retryKey = random_bytes(32);
$retryStore = EncryptedFileEventStore::open($retryDirectory, $retryKey);
$retryClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxRetries: 0,
    maxBatchEvents: 2,
    eventStore: $retryStore
);
foreach (['evt_retry_1', 'evt_retry_2'] as $index => $eventId) {
    $retryClient->log($eventId, sprintf('2026-07-14T08:01:0%dZ', $index), [
        'message' => 'frozen retry prefix',
        'level' => 'warning',
    ]);
}
$failedTransport = new RecordingTransport([503]);
expectPersistentDeliveryError(
    static fn () => $retryClient->flush($failedTransport),
    'transport_error'
);
assertPersistentDelivery(count($failedTransport->sentBodies) === 1, 'failed persistent flush must send once');
$failedBody = $failedTransport->sentBodies[0];
$retryClient->log('evt_after_failure', '2026-07-14T08:01:02Z', [
    'message' => 'later capture',
    'level' => 'info',
]);
$retryStore->close();
unset($retryClient, $retryStore);

$retryStore = EncryptedFileEventStore::open($retryDirectory, $retryKey);
$retryClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php-upgraded',
    '0.2.0',
    maxRetries: 0,
    maxBatchEvents: 3,
    eventStore: $retryStore
);
$recoveryTransport = RecordingTransport::alwaysAccept();
$retryResponse = $retryClient->flush($recoveryTransport);
assertPersistentDelivery($retryResponse->batches === 2, 'restart must keep the frozen retry boundary before later work');
assertPersistentDelivery(count($recoveryTransport->sentBodies) === 2, 'restart must send the retry and later capture separately');
assertPersistentDelivery($recoveryTransport->sentBodies[0] === $failedBody, 'restart retry body must be byte-identical');
assertPersistentDelivery(str_contains($recoveryTransport->sentBodies[1], 'evt_after_failure'), 'later capture must follow the retry');
assertPersistentDelivery(str_contains($recoveryTransport->sentBodies[1], 'logbrew-php-upgraded'), 'later capture must use the current SDK identity');
$retryStore->close();
unset($retryClient, $retryStore);

$retryStore = EncryptedFileEventStore::open($retryDirectory, $retryKey);
$retryClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $retryStore
);
assertPersistentDelivery($retryClient->pendingEvents() === 0, 'accepted persistent events must not replay after restart');
$retryStore->close();
unset($retryClient, $retryStore);
removePersistentDeliveryDirectory($retryDirectory);

$prefixDirectory = persistentDeliveryDirectory();
$prefixKey = random_bytes(32);
$prefixStore = EncryptedFileEventStore::open($prefixDirectory, $prefixKey);
$prefixClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxRetries: 0,
    maxBatchEvents: 2,
    eventStore: $prefixStore
);
foreach (['evt_prefix_1', 'evt_prefix_2', 'evt_prefix_3'] as $index => $eventId) {
    $prefixClient->log($eventId, sprintf('2026-07-14T08:02:0%dZ', $index), [
        'message' => 'accepted prefix',
        'level' => 'info',
    ]);
}
expectPersistentDeliveryError(
    static fn () => $prefixClient->flush(new RecordingTransport([202, 503])),
    'transport_error'
);
assertPersistentDelivery($prefixClient->pendingEvents() === 1, 'in-memory partial failure must retain only the failed suffix');
$prefixStore->close();
unset($prefixClient, $prefixStore);

$prefixStore = EncryptedFileEventStore::open($prefixDirectory, $prefixKey);
$prefixClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $prefixStore
);
assertPersistentDelivery($prefixClient->pendingEvents() === 1, 'restart must retain only the unacknowledged suffix');
assertPersistentDelivery(str_contains($prefixClient->previewJson(), 'evt_prefix_3'), 'restart must preserve the failed suffix');
assertPersistentDelivery(!str_contains($prefixClient->previewJson(), 'evt_prefix_1'), 'restart must omit the accepted prefix');
$prefixClient->purgePersistedEvents();
$prefixStore->close();
unset($prefixClient, $prefixStore);
removePersistentDeliveryDirectory($prefixDirectory);

$successDirectory = persistentDeliveryDirectory();
$successKey = random_bytes(32);
$successStore = EncryptedFileEventStore::open($successDirectory, $successKey);
$successClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxRetries: 0,
    eventStore: $successStore
);
$successClient->log('evt_first_success', '2026-07-14T08:03:00Z', [
    'message' => 'first accepted batch',
    'level' => 'info',
]);
$firstSuccessTransport = RecordingTransport::alwaysAccept();
$successClient->flush($firstSuccessTransport);
$successClient->log('evt_second_success', '2026-07-14T08:03:01Z', [
    'message' => 'second accepted batch',
    'level' => 'info',
]);
$secondSuccessTransport = RecordingTransport::alwaysAccept();
$successClient->flush($secondSuccessTransport);
assertPersistentDelivery(count($secondSuccessTransport->sentBodies) === 1, 'later flush must not replay an accepted staged batch');
assertPersistentDelivery(str_contains($secondSuccessTransport->sentBodies[0], 'evt_second_success'), 'later flush must send only new work');
assertPersistentDelivery(!str_contains($secondSuccessTransport->sentBodies[0], 'evt_first_success'), 'later flush must omit the accepted event');
$successStore->close();
unset($successClient, $successStore);
removePersistentDeliveryDirectory($successDirectory);

expectPersistentDeliveryError(
    static fn () => EncryptedFileEventStore::open('relative/queue', random_bytes(32)),
    'validation_error'
);
$invalidKeyDirectory = persistentDeliveryDirectory();
expectPersistentDeliveryError(
    static fn () => EncryptedFileEventStore::open($invalidKeyDirectory, 'too-short'),
    'validation_error'
);
assertPersistentDelivery(!file_exists($invalidKeyDirectory), 'invalid keys must not create a queue directory');
if (!rmdir(dirname($invalidKeyDirectory))) {
    throw new RuntimeException('failed to remove invalid-key test parent');
}

$exclusiveDirectory = persistentDeliveryDirectory();
$exclusiveKey = random_bytes(32);
$exclusiveStore = EncryptedFileEventStore::open($exclusiveDirectory, $exclusiveKey);
$exclusiveError = expectPersistentDeliveryError(
    static fn () => EncryptedFileEventStore::open($exclusiveDirectory, $exclusiveKey),
    'persistent_queue_error'
);
assertPersistentDelivery(!str_contains($exclusiveError->getMessage(), $exclusiveDirectory), 'lock errors must not expose local paths');
$exclusiveStore->close();
unset($exclusiveStore);
removePersistentDeliveryDirectory($exclusiveDirectory);

$lockIdentityDirectory = persistentDeliveryDirectory();
$lockIdentityKey = random_bytes(32);
$lockIdentityStore = EncryptedFileEventStore::open($lockIdentityDirectory, $lockIdentityKey);
$lockIdentityClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $lockIdentityStore
);
$lockIdentityClient->log('evt_lock_identity', '2026-07-14T08:03:00Z', [
    'message' => 'locked inode must stay pinned',
    'level' => 'warning',
]);
$lockIdentityPath = $lockIdentityDirectory . '/.lock';
assertPersistentDelivery(unlink($lockIdentityPath), 'locked path must be removed for identity test');
assertPersistentDelivery(file_put_contents($lockIdentityPath, '') === 0, 'replacement lock file must be created');
assertPersistentDelivery(chmod($lockIdentityPath, 0600), 'replacement lock file must be owner-only');
$replacementLockStore = EncryptedFileEventStore::open($lockIdentityDirectory, $lockIdentityKey);
$lockSendMarker = dirname($lockIdentityDirectory) . '/lock-send-marker';
expectPersistentDeliveryError(
    static fn () => $lockIdentityClient->flush(new class($lockSendMarker) implements Transport {
        public function __construct(private readonly string $marker)
        {
        }

        public function send(string $apiKey, string $body): TransportResponse
        {
            file_put_contents($this->marker, 'sent');
            return new TransportResponse(202, 1);
        }
    }),
    'persistent_queue_error'
);
assertPersistentDelivery(!file_exists($lockSendMarker), 'replaced lock path must fail before transport');
$replacementLockClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $replacementLockStore
);
assertPersistentDelivery($replacementLockClient->pendingEvents() === 1, 'replacement lock owner must recover the event');
$replacementLockClient->shutdown(RecordingTransport::alwaysAccept());
$lockIdentityStore->close();
unset($lockIdentityClient, $lockIdentityStore, $replacementLockClient, $replacementLockStore);
removePersistentDeliveryDirectory($lockIdentityDirectory);

$wrongKeyDirectory = persistentDeliveryDirectory();
$wrongKey = str_repeat('K', 32);
$wrongKeyStore = EncryptedFileEventStore::open($wrongKeyDirectory, $wrongKey);
$wrongKeyClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $wrongKeyStore
);
$wrongKeyClient->log('evt_wrong_key', '2026-07-14T08:04:00Z', [
    'message' => 'must remain confidential',
    'level' => 'error',
]);
$wrongKeyStore->close();
unset($wrongKeyClient, $wrongKeyStore);
$mismatchedStore = EncryptedFileEventStore::open($wrongKeyDirectory, str_repeat('Q', 32));
$wrongKeyError = expectPersistentDeliveryError(
    static fn () => LogBrewClient::create(
        'LOGBREW_API_KEY',
        'logbrew-php',
        '0.1.0',
        eventStore: $mismatchedStore
    ),
    'persistent_queue_error'
);
assertPersistentDelivery(!str_contains($wrongKeyError->getMessage(), 'evt_wrong_key'), 'wrong-key failures must not expose event IDs');
assertPersistentDelivery(!str_contains($wrongKeyError->getMessage(), $wrongKeyDirectory), 'wrong-key failures must not expose local paths');
$mismatchedStore->close();
unset($mismatchedStore);
$wrongKeyStore = EncryptedFileEventStore::open($wrongKeyDirectory, $wrongKey);
$wrongKeyClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $wrongKeyStore
);
$wrongKeyClient->purgePersistedEvents();
$wrongKeyStore->close();
unset($wrongKeyClient, $wrongKeyStore);
removePersistentDeliveryDirectory($wrongKeyDirectory);

$invalidEventCases = [
    [
        'type' => 'unknown',
        'id' => 'evt_invalid_type',
        'timestamp' => '2026-07-14T08:04:00Z',
        'attributes' => [],
    ],
    [
        'type' => 'log',
        'id' => 'evt_invalid_timestamp',
        'timestamp' => 'not-a-dateZ',
        'attributes' => ['message' => 'invalid recovered event', 'level' => 'error'],
    ],
    [
        'type' => 'metric',
        'id' => 'evt_invalid_metric',
        'timestamp' => '2026-07-14T08:04:00Z',
        'attributes' => [
            'name' => 'jobs.completed',
            'kind' => 'counter',
            'value' => -1,
            'unit' => 'job',
            'temporality' => 'delta',
        ],
    ],
];
foreach ($invalidEventCases as $invalidEvent) {
    $invalidDirectory = persistentDeliveryDirectory();
    $invalidKey = random_bytes(32);
    $invalidStore = EncryptedFileEventStore::open($invalidDirectory, $invalidKey);
    $invalidStore->append(json_encode($invalidEvent, JSON_THROW_ON_ERROR));
    $invalidStore->close();
    unset($invalidStore);

    $invalidStore = EncryptedFileEventStore::open($invalidDirectory, $invalidKey);
    $invalidError = expectPersistentDeliveryError(
        static fn () => LogBrewClient::create(
            'LOGBREW_API_KEY',
            'logbrew-php',
            '0.1.0',
            eventStore: $invalidStore
        ),
        'persistent_queue_error'
    );
    assertPersistentDelivery(
        !str_contains($invalidError->getMessage(), 'evt_invalid_')
            && !str_contains($invalidError->getMessage(), $invalidDirectory),
        'invalid recovered event failures must not expose content or local paths'
    );
    $invalidStore->purge();
    $invalidStore->close();
    unset($invalidStore);
    removePersistentDeliveryDirectory($invalidDirectory);
}

$metadataDirectory = persistentDeliveryDirectory();
$metadataStore = EncryptedFileEventStore::open($metadataDirectory, random_bytes(32));
$metadataClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $metadataStore
);
$logMethod = new ReflectionMethod(LogBrewClient::class, 'log');
foreach ([
    ['nested' => ['value']],
    [0 => 'numeric-key'],
] as $invalidMetadata) {
    expectPersistentDeliveryError(
        static fn () => $logMethod->invoke(
            $metadataClient,
            'evt_invalid_metadata',
            '2026-07-14T08:04:00Z',
            [
                'message' => 'invalid metadata must not persist',
                'level' => 'error',
                'metadata' => $invalidMetadata,
            ]
        ),
        'validation_error'
    );
}
assertPersistentDelivery($metadataClient->pendingEvents() === 0, 'invalid metadata must not enter the persistent queue');
$metadataStore->close();
unset($metadataClient, $metadataStore);
removePersistentDeliveryDirectory($metadataDirectory);

$timestampDirectory = persistentDeliveryDirectory();
$timestampStore = EncryptedFileEventStore::open($timestampDirectory, random_bytes(32));
$timestampClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $timestampStore
);
expectPersistentDeliveryError(
    static fn () => $timestampClient->log('evt_invalid_timestamp', 'not-a-dateZ', [
        'message' => 'invalid timestamp must not persist',
        'level' => 'error',
    ]),
    'validation_error'
);
assertPersistentDelivery($timestampClient->pendingEvents() === 0, 'invalid timestamps must not enter the persistent queue');
$timestampStore->close();
unset($timestampClient, $timestampStore);
removePersistentDeliveryDirectory($timestampDirectory);

$tamperDirectory = persistentDeliveryDirectory();
$tamperKey = random_bytes(32);
$tamperStore = EncryptedFileEventStore::open($tamperDirectory, $tamperKey);
$tamperClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $tamperStore
);
$tamperClient->log('evt_tampered', '2026-07-14T08:05:00Z', [
    'message' => 'authenticated ciphertext',
    'level' => 'warning',
]);
$tamperStore->close();
unset($tamperClient, $tamperStore);
$tamperFiles = persistentDeliveryEventFiles($tamperDirectory);
assertPersistentDelivery(count($tamperFiles) === 1, 'tamper test must have one encrypted record');
$tampered = file_get_contents($tamperFiles[0]);
if (!is_string($tampered) || strlen($tampered) <= 40) {
    throw new RuntimeException('tamper test record must be readable');
}
$replacement = $tampered[40] === "\0" ? "\1" : "\0";
$tampered = substr_replace($tampered, $replacement, 40, 1);
assertPersistentDelivery(file_put_contents($tamperFiles[0], $tampered) === strlen($tampered), 'tamper test must rewrite the record');
$tamperedStore = EncryptedFileEventStore::open($tamperDirectory, $tamperKey);
expectPersistentDeliveryError(
    static fn () => LogBrewClient::create(
        'LOGBREW_API_KEY',
        'logbrew-php',
        '0.1.0',
        eventStore: $tamperedStore
    ),
    'persistent_queue_error'
);
$tamperedStore->close();
unset($tamperedStore);
assertPersistentDelivery(unlink($tamperFiles[0]), 'tampered test record must be removable');
removePersistentDeliveryDirectory($tamperDirectory);

$unsafeDirectory = persistentDeliveryDirectory();
$unsafeKey = random_bytes(32);
$unsafeStore = EncryptedFileEventStore::open($unsafeDirectory, $unsafeKey);
$unsafeStore->close();
unset($unsafeStore);
$outsideAck = dirname($unsafeDirectory) . '/outside-ack';
assertPersistentDelivery(file_put_contents($outsideAck, 'unsafe') === 6, 'unsafe metadata target must be created');
assertPersistentDelivery(symlink($outsideAck, $unsafeDirectory . '/.ack'), 'unsafe metadata symlink must be created');
expectPersistentDeliveryError(
    static fn () => EncryptedFileEventStore::open($unsafeDirectory, $unsafeKey),
    'persistent_queue_error'
);
assertPersistentDelivery(unlink($unsafeDirectory . '/.ack'), 'unsafe metadata symlink must be removed');
assertPersistentDelivery(unlink($outsideAck), 'unsafe metadata target must be removed');
removePersistentDeliveryDirectory($unsafeDirectory);

$brokenMetadataDirectory = persistentDeliveryDirectory();
$brokenMetadataKey = random_bytes(32);
$brokenMetadataStore = EncryptedFileEventStore::open($brokenMetadataDirectory, $brokenMetadataKey);
$brokenMetadataStore->close();
unset($brokenMetadataStore);
assertPersistentDelivery(
    symlink(dirname($brokenMetadataDirectory) . '/missing-retry-target', $brokenMetadataDirectory . '/.retry'),
    'broken retry symlink must be created'
);
expectPersistentDeliveryError(
    static fn () => EncryptedFileEventStore::open($brokenMetadataDirectory, $brokenMetadataKey),
    'persistent_queue_error'
);
assertPersistentDelivery(unlink($brokenMetadataDirectory . '/.retry'), 'broken retry symlink must be removed');
removePersistentDeliveryDirectory($brokenMetadataDirectory);

$replaceDirectory = persistentDeliveryDirectory();
$replaceKey = random_bytes(32);
$replaceStore = EncryptedFileEventStore::open($replaceDirectory, $replaceKey);
$replaceClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $replaceStore
);
$movedDirectory = $replaceDirectory . '-moved';
assertPersistentDelivery(rename($replaceDirectory, $movedDirectory), 'queue directory must move for identity test');
assertPersistentDelivery(mkdir($replaceDirectory, 0700) && chmod($replaceDirectory, 0700), 'replacement queue directory must be created');
expectPersistentDeliveryError(
    static fn () => $replaceClient->log('evt_replaced', '2026-07-14T08:06:00Z', [
        'message' => 'directory identity changed',
        'level' => 'error',
    ]),
    'persistent_queue_error'
);
$replaceStore->close();
unset($replaceClient, $replaceStore);
removePersistentDeliveryDirectory($replaceDirectory, false);
removePersistentDeliveryDirectory($movedDirectory);

if (function_exists('pcntl_fork')) {
    $forkDirectory = persistentDeliveryDirectory();
    $forkKey = random_bytes(32);
    $forkStore = EncryptedFileEventStore::open($forkDirectory, $forkKey);
    $forkClient = LogBrewClient::create(
        'LOGBREW_API_KEY',
        'logbrew-php',
        '0.1.0',
        maxRetries: 0,
        eventStore: $forkStore
    );
    $forkResult = dirname($forkDirectory) . '/fork-result';
    $forkSendMarker = dirname($forkDirectory) . '/fork-send-marker';
    $forkClient->log('evt_parent_retry', '2026-07-14T08:07:00Z', [
        'message' => 'parent-owned retry',
        'level' => 'warning',
    ]);
    expectPersistentDeliveryError(
        static fn () => $forkClient->flush(new RecordingTransport([503])),
        'transport_error'
    );
    $childPid = pcntl_fork();
    assertPersistentDelivery($childPid >= 0, 'fork test must create a child');
    if ($childPid === 0) {
        $captureCode = null;
        $flushCode = null;
        try {
            $forkClient->log('evt_child_copy', '2026-07-14T08:07:00Z', [
                'message' => 'must not persist from copied state',
                'level' => 'error',
            ]);
        } catch (SdkError $error) {
            $captureCode = $error->codeName;
        }
        try {
            $forkClient->flush(new class($forkSendMarker) implements Transport {
                public function __construct(private readonly string $marker)
                {
                }

                public function send(string $apiKey, string $body): TransportResponse
                {
                    file_put_contents($this->marker, 'sent');
                    return new TransportResponse(202, 1);
                }
            });
        } catch (SdkError $error) {
            $flushCode = $error->codeName;
        }
        file_put_contents($forkResult, json_encode([
            'capture' => $captureCode,
            'flush' => $flushCode,
        ], JSON_THROW_ON_ERROR));
        exit(0);
    }
    $forkStatus = 0;
    assertPersistentDelivery(pcntl_waitpid($childPid, $forkStatus) === $childPid, 'fork test child must finish');
    if (!is_int($forkStatus)) {
        throw new RuntimeException('fork test child status must be an integer');
    }
    assertPersistentDelivery(pcntl_wifexited($forkStatus) && pcntl_wexitstatus($forkStatus) === 0, 'fork test child must exit cleanly');
    $forkCodes = json_decode((string) file_get_contents($forkResult), true, 512, JSON_THROW_ON_ERROR);
    assertPersistentDelivery(
        is_array($forkCodes)
            && ($forkCodes['capture'] ?? null) === 'process_ownership_error'
            && ($forkCodes['flush'] ?? null) === 'process_ownership_error',
        'copied child store must reject capture and flush'
    );
    assertPersistentDelivery(!file_exists($forkSendMarker), 'copied child store must reject before transport');
    $forkClient->flush(RecordingTransport::alwaysAccept());
    assertPersistentDelivery(count(persistentDeliveryEventFiles($forkDirectory)) === 0, 'parent retry must drain its persisted event');
    assertPersistentDelivery(unlink($forkResult), 'fork result must be removed');
    $forkStore->close();
    unset($forkClient, $forkStore);
    removePersistentDeliveryDirectory($forkDirectory);
}

$shutdownDirectory = persistentDeliveryDirectory();
$shutdownKey = random_bytes(32);
$shutdownStore = EncryptedFileEventStore::open($shutdownDirectory, $shutdownKey);
$shutdownClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $shutdownStore
);
$shutdownClient->log('evt_clean_shutdown', '2026-07-14T08:08:00Z', [
    'message' => 'clean worker stop',
    'level' => 'info',
]);
$shutdownResponse = $shutdownClient->shutdown(RecordingTransport::alwaysAccept());
assertPersistentDelivery($shutdownResponse->statusCode === 202, 'persistent shutdown must deliver queued work');
$afterShutdownStore = EncryptedFileEventStore::open($shutdownDirectory, $shutdownKey);
$afterShutdownClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $afterShutdownStore
);
assertPersistentDelivery($afterShutdownClient->pendingEvents() === 0, 'clean shutdown must leave no restart work');
$afterShutdownStore->close();
unset($shutdownClient, $shutdownStore, $afterShutdownClient, $afterShutdownStore);
removePersistentDeliveryDirectory($shutdownDirectory);

$defaultDirectory = persistentDeliveryDirectory();
$defaultClient = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$defaultClient->log('evt_memory_only', '2026-07-14T08:09:00Z', [
    'message' => 'default remains in memory',
    'level' => 'info',
]);
assertPersistentDelivery(!file_exists($defaultDirectory), 'default client must not create persistence state');
if (!rmdir(dirname($defaultDirectory))) {
    throw new RuntimeException('failed to remove default-mode test parent');
}

$permissionDirectory = persistentDeliveryDirectory();
assertPersistentDelivery(mkdir($permissionDirectory, 0755) && chmod($permissionDirectory, 0755), 'permission test directory must be created');
expectPersistentDeliveryError(
    static fn () => EncryptedFileEventStore::open($permissionDirectory, random_bytes(32)),
    'persistent_queue_error'
);
assertPersistentDelivery(rmdir($permissionDirectory), 'permission test directory must be removed');
assertPersistentDelivery(rmdir(dirname($permissionDirectory)), 'permission test parent must be removed');

$temporaryDirectory = persistentDeliveryDirectory();
$temporaryKey = random_bytes(32);
$temporaryStore = EncryptedFileEventStore::open($temporaryDirectory, $temporaryKey);
$temporaryStore->close();
unset($temporaryStore);
$temporaryPath = $temporaryDirectory . '/.tmp-' . str_repeat('a', 32);
assertPersistentDelivery(file_put_contents($temporaryPath, 'interrupted') === 11, 'interrupted temporary file must be created');
assertPersistentDelivery(chmod($temporaryPath, 0644), 'interrupted temporary file must model a pre-chmod process exit');
$temporaryStore = EncryptedFileEventStore::open($temporaryDirectory, $temporaryKey);
assertPersistentDelivery(!file_exists($temporaryPath), 'restart must remove a validated interrupted temporary file');
$temporaryStore->close();
unset($temporaryStore);
removePersistentDeliveryDirectory($temporaryDirectory);

$lockRecoveryDirectory = persistentDeliveryDirectory();
assertPersistentDelivery(mkdir($lockRecoveryDirectory, 0700) && chmod($lockRecoveryDirectory, 0700), 'lock recovery directory must be owner-only');
$lockRecoveryPath = $lockRecoveryDirectory . '/.lock';
assertPersistentDelivery(file_put_contents($lockRecoveryPath, '') === 0, 'interrupted lock file must be created');
assertPersistentDelivery(chmod($lockRecoveryPath, 0644), 'interrupted lock file must model a pre-chmod process exit');
$lockRecoveryStore = EncryptedFileEventStore::open($lockRecoveryDirectory, random_bytes(32));
clearstatcache(true, $lockRecoveryPath);
assertPersistentDelivery((fileperms($lockRecoveryPath) & 0777) === 0600, 'reopened lock file must be owner-only');
$lockRecoveryStore->close();
unset($lockRecoveryStore);
removePersistentDeliveryDirectory($lockRecoveryDirectory);

$hardLinkDirectory = persistentDeliveryDirectory();
$hardLinkKey = random_bytes(32);
$hardLinkStore = EncryptedFileEventStore::open($hardLinkDirectory, $hardLinkKey);
$hardLinkClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $hardLinkStore
);
$hardLinkClient->log('evt_hard_link', '2026-07-14T08:10:00Z', [
    'message' => 'unsafe shared inode',
    'level' => 'error',
]);
$hardLinkStore->close();
unset($hardLinkClient, $hardLinkStore);
$hardLinkFiles = persistentDeliveryEventFiles($hardLinkDirectory);
assertPersistentDelivery(count($hardLinkFiles) === 1, 'hard-link test must have one record');
$outsideHardLink = dirname($hardLinkDirectory) . '/outside-event-link';
assertPersistentDelivery(link($hardLinkFiles[0], $outsideHardLink), 'hard-link test must create a second link');
expectPersistentDeliveryError(
    static fn () => EncryptedFileEventStore::open($hardLinkDirectory, $hardLinkKey),
    'persistent_queue_error'
);
assertPersistentDelivery(unlink($outsideHardLink), 'outside hard link must be removed');
assertPersistentDelivery(unlink($hardLinkFiles[0]), 'hard-linked record must be removed');
removePersistentDeliveryDirectory($hardLinkDirectory);

$boundDirectory = persistentDeliveryDirectory();
$boundKey = random_bytes(32);
$boundStore = EncryptedFileEventStore::open($boundDirectory, $boundKey);
$boundClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueSize: 2,
    eventStore: $boundStore
);
foreach (['evt_bound_1', 'evt_bound_2', 'evt_bound_dropped'] as $index => $eventId) {
    $boundClient->log($eventId, sprintf('2026-07-14T08:11:0%dZ', $index), [
        'message' => 'bounded persistence',
        'level' => 'info',
    ]);
}
assertPersistentDelivery($boundClient->pendingEvents() === 2, 'persistent queue must keep its exact event bound');
assertPersistentDelivery($boundClient->droppedEvents() === 1, 'persistent queue must report admission loss');
assertPersistentDelivery(count(glob($boundDirectory . '/*.event') ?: []) === 2, 'dropped events must not reach disk');
$boundStore->close();
unset($boundClient, $boundStore);
$tooSmallStore = EncryptedFileEventStore::open($boundDirectory, $boundKey);
expectPersistentDeliveryError(
    static fn () => LogBrewClient::create(
        'LOGBREW_API_KEY',
        'logbrew-php',
        '0.1.0',
        maxQueueSize: 1,
        eventStore: $tooSmallStore
    ),
    'persistent_queue_error'
);
$tooSmallStore->close();
unset($tooSmallStore);
$boundStore = EncryptedFileEventStore::open($boundDirectory, $boundKey);
$boundClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueSize: 2,
    eventStore: $boundStore
);
$boundClient->purgePersistedEvents();
$boundStore->close();
unset($boundClient, $boundStore);
removePersistentDeliveryDirectory($boundDirectory);

$failedShutdownDirectory = persistentDeliveryDirectory();
$failedShutdownKey = random_bytes(32);
$failedShutdownStore = EncryptedFileEventStore::open($failedShutdownDirectory, $failedShutdownKey);
$failedShutdownClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxRetries: 0,
    eventStore: $failedShutdownStore
);
$failedShutdownClient->log('evt_failed_shutdown', '2026-07-14T08:12:00Z', [
    'message' => 'retry after failed stop',
    'level' => 'warning',
]);
expectPersistentDeliveryError(
    static fn () => $failedShutdownClient->shutdown(new RecordingTransport([503])),
    'transport_error'
);
assertPersistentDelivery($failedShutdownClient->pendingEvents() === 1, 'failed persistent shutdown must retain queued work');
$recoveredShutdown = $failedShutdownClient->shutdown(RecordingTransport::alwaysAccept());
assertPersistentDelivery($recoveredShutdown->statusCode === 202, 'failed persistent shutdown must remain retryable');
$postFailureQueue = EncryptedFileEventStore::open($failedShutdownDirectory, $failedShutdownKey);
$postFailureClient = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    eventStore: $postFailureQueue
);
assertPersistentDelivery($postFailureClient->pendingEvents() === 0, 'recovered persistent shutdown must not replay');
$postFailureQueue->close();
unset($failedShutdownClient, $failedShutdownStore, $postFailureClient, $postFailureQueue);
removePersistentDeliveryDirectory($failedShutdownDirectory);

fwrite(STDOUT, "php persistent delivery checks passed\n");
