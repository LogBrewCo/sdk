<?php

declare(strict_types=1);

namespace LogBrew {
    final class PersistenceDurabilityProbe
    {
        public static int $directorySyncFailures = 0;

        public static int $directorySyncCalls = 0;

        public static int $fileSyncFailures = 0;

        public static bool $introduceTargetBeforeLink = false;
    }

    /** @param resource $stream */
    function fsync($stream): bool
    {
        $stat = fstat($stream);
        if (is_array($stat) && ($stat['mode'] & 0170000) === 0040000) {
            PersistenceDurabilityProbe::$directorySyncCalls++;
            if (PersistenceDurabilityProbe::$directorySyncFailures > 0) {
                PersistenceDurabilityProbe::$directorySyncFailures--;
                return false;
            }
        } elseif (PersistenceDurabilityProbe::$fileSyncFailures > 0) {
            PersistenceDurabilityProbe::$fileSyncFailures--;
            return false;
        }

        return \fsync($stream);
    }

    function link(string $from, string $to): bool
    {
        if (PersistenceDurabilityProbe::$introduceTargetBeforeLink) {
            PersistenceDurabilityProbe::$introduceTargetBeforeLink = false;
            \symlink(dirname($to) . '/missing-race-target', $to);
        }

        return \link($from, $to);
    }
}

namespace {
    use LogBrew\EncryptedFileEventStore;
    use LogBrew\HttpTransport;
    use LogBrew\LogBrewClient;
    use LogBrew\PersistenceDurabilityProbe;
    use LogBrew\RecordingTransport;
    use LogBrew\SdkError;
    use LogBrew\Transport;
    use LogBrew\TransportError;
    use LogBrew\TransportResponse;

    require_once __DIR__ . '/../vendor/autoload.php';

    /** @phpstan-assert true $condition */
    function persistentContractAssert(bool $condition, string $message): void
    {
        if (!$condition) {
            throw new RuntimeException($message);
        }
    }

    function persistentContractProbeInt(string $property): int
    {
        $value = (new ReflectionClass(PersistenceDurabilityProbe::class))->getStaticPropertyValue($property);
        if (!is_int($value)) {
            throw new RuntimeException('persistence durability probe must contain an integer');
        }

        return $value;
    }

    function persistentContractDirectory(): string
    {
        $parent = sys_get_temp_dir() . '/logbrew-php-contract-' . bin2hex(random_bytes(8));
        if (!mkdir($parent, 0700) || !chmod($parent, 0700)) {
            throw new RuntimeException('failed to create persistence contract directory');
        }
        $resolved = realpath($parent);
        if (!is_string($resolved)) {
            throw new RuntimeException('failed to resolve persistence contract directory');
        }

        return $resolved . '/queue';
    }

    function removePersistentContractDirectory(string $directory): void
    {
        $parent = dirname($directory);
        if (is_dir($directory)) {
            $entries = scandir($directory);
            if (!is_array($entries)) {
                throw new RuntimeException('failed to read persistence contract directory');
            }
            foreach ($entries as $entry) {
                if ($entry !== '.' && $entry !== '..') {
                    @unlink($directory . '/' . $entry);
                }
            }
            @rmdir($directory);
        }
        $entries = scandir($parent);
        if (is_array($entries)) {
            foreach ($entries as $entry) {
                if ($entry !== '.' && $entry !== '..') {
                    @unlink($parent . '/' . $entry);
                }
            }
        }
        @rmdir($parent);
    }

    /** @return list<string> */
    function persistentContractEventFiles(string $directory): array
    {
        $files = glob($directory . '/*.event');
        return is_array($files) ? $files : [];
    }

    /** @return SdkError|null */
    function captureSdkError(callable $callback): ?SdkError
    {
        try {
            $callback();
        } catch (SdkError $error) {
            return $error;
        }

        return null;
    }

    $tests = [];

    $tests['durable admission rolls back after directory sync failure'] = static function (): void {
        $directory = persistentContractDirectory();
        $store = EncryptedFileEventStore::open($directory, random_bytes(32));
        $client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', eventStore: $store);
        PersistenceDurabilityProbe::$directorySyncCalls = 0;
        PersistenceDurabilityProbe::$directorySyncFailures = 1;
        try {
            $error = captureSdkError(static fn () => $client->log(
                'evt_directory_sync',
                '2026-07-21T08:00:00Z',
                ['message' => 'durable admission', 'level' => 'info']
            ));
            persistentContractAssert($error?->codeName === 'persistence_commit_error', 'directory sync failure must reject admission');
            persistentContractAssert($client->pendingEvents() === 0, 'rejected admission must not enter memory');
            persistentContractAssert(persistentContractEventFiles($directory) === [], 'rejected admission must durably remove its record');
            persistentContractAssert(persistentContractProbeInt('directorySyncCalls') === 2, 'admission rejection must sync commit and rollback directory states');
        } finally {
            PersistenceDurabilityProbe::$directorySyncFailures = 0;
            if ($client->pendingEvents() > 0 || persistentContractEventFiles($directory) !== []) {
                $client->purgePersistedEvents();
            }
            $store->close();
            removePersistentContractDirectory($directory);
        }
    };

    $tests['rejected file sync cleans temporary state and preserves admission'] = static function (): void {
        $directory = persistentContractDirectory();
        $store = EncryptedFileEventStore::open($directory, random_bytes(32));
        $client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', eventStore: $store);
        PersistenceDurabilityProbe::$fileSyncFailures = 1;
        try {
            $error = captureSdkError(static fn () => $client->log(
                'evt_file_sync',
                '2026-07-21T08:00:00Z',
                ['message' => 'reject incomplete file', 'level' => 'info']
            ));
            PersistenceDurabilityProbe::$fileSyncFailures = 0;
            persistentContractAssert($error?->codeName === 'persistence_commit_error', 'file sync failure must reject admission');
            persistentContractAssert(glob($directory . '/.tmp-*') === [], 'file sync failure must remove its temporary record');

            $client->log(
                'evt_after_file_sync',
                '2026-07-21T08:00:01Z',
                ['message' => 'queue remains usable', 'level' => 'info']
            );
            persistentContractAssert($client->pendingEvents() === 1, 'same client must admit after a rejected file sync');
        } finally {
            PersistenceDurabilityProbe::$fileSyncFailures = 0;
            foreach (glob($directory . '/.tmp-*') ?: [] as $temporaryPath) {
                @unlink($temporaryPath);
            }
            if ($client->pendingEvents() > 0 || persistentContractEventFiles($directory) !== []) {
                $client->purgePersistedEvents();
            }
            $store->close();
            removePersistentContractDirectory($directory);
        }
    };

    $tests['broken event symlink fails closed during admission'] = static function (): void {
        $directory = persistentContractDirectory();
        $store = EncryptedFileEventStore::open($directory, random_bytes(32));
        $client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', eventStore: $store);
        $eventPath = $directory . '/00000000000000000001.event';
        persistentContractAssert(symlink(dirname($directory) . '/missing-target', $eventPath), 'broken event symlink must be created');
        try {
            $error = captureSdkError(static fn () => $client->log(
                'evt_broken_symlink',
                '2026-07-21T08:00:01Z',
                ['message' => 'must fail closed', 'level' => 'warning']
            ));
            persistentContractAssert($error?->codeName === 'persistent_queue_error', 'broken event symlink must reject admission');
            persistentContractAssert(is_link($eventPath), 'failed admission must not replace the broken symlink');
            persistentContractAssert($client->pendingEvents() === 0, 'broken event symlink must not enter memory');
        } finally {
            if ($client->pendingEvents() > 0) {
                $client->purgePersistedEvents();
            }
            $store->close();
            removePersistentContractDirectory($directory);
        }
    };

    $tests['event publication never replaces a raced target'] = static function (): void {
        $directory = persistentContractDirectory();
        $store = EncryptedFileEventStore::open($directory, random_bytes(32));
        $client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', eventStore: $store);
        $eventPath = $directory . '/00000000000000000001.event';
        PersistenceDurabilityProbe::$introduceTargetBeforeLink = true;
        try {
            $error = captureSdkError(static fn () => $client->log(
                'evt_raced_symlink',
                '2026-07-21T08:00:02Z',
                ['message' => 'must not clobber', 'level' => 'warning']
            ));
            persistentContractAssert($error?->codeName === 'persistent_queue_error', 'raced target must reject admission');
            persistentContractAssert(is_link($eventPath), 'atomic publication must not replace the raced symlink');
            persistentContractAssert($client->pendingEvents() === 0, 'raced target must not enter memory');
            persistentContractAssert(glob($directory . '/.tmp-*') === [], 'raced publication must clean its temporary record');
        } finally {
            PersistenceDurabilityProbe::$introduceTargetBeforeLink = false;
            foreach (glob($directory . '/.tmp-*') ?: [] as $temporaryPath) {
                @unlink($temporaryPath);
            }
            if ($client->pendingEvents() > 0) {
                $client->purgePersistedEvents();
            }
            $store->close();
            removePersistentContractDirectory($directory);
        }
    };

    $tests['oversized sequence name uses a stable queue error'] = static function (): void {
        $directory = persistentContractDirectory();
        $key = random_bytes(32);
        $store = EncryptedFileEventStore::open($directory, $key);
        $store->close();
        unset($store);
        $record = $directory . '/99999999999999999999.event';
        persistentContractAssert(file_put_contents($record, 'invalid') === 7, 'oversized sequence fixture must be created');
        persistentContractAssert(chmod($record, 0600), 'oversized sequence fixture must be owner-only');
        try {
            $error = null;
            try {
                $store = EncryptedFileEventStore::open($directory, $key);
            } catch (Throwable $caught) {
                $error = $caught;
            }
            persistentContractAssert($error instanceof SdkError, 'oversized sequence must not escape as a runtime type error');
            persistentContractAssert($error->codeName === 'persistent_queue_error', 'oversized sequence must use the stable queue code');
        } finally {
            if (isset($store)) {
                $store->close();
            }
            removePersistentContractDirectory($directory);
        }
    };

    $tests['client hides raw transport failure details'] = static function (): void {
        $sensitiveMarker = 'opaque-sensitive-detail-' . bin2hex(random_bytes(8));
        $client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', maxRetries: 0);
        $client->log('evt_private_transport', '2026-07-21T08:00:02Z', [
            'message' => 'retained',
            'level' => 'error',
        ]);
        $error = captureSdkError(static fn () => $client->flush(new class($sensitiveMarker) implements Transport {
            public function __construct(private readonly string $sensitiveMarker)
            {
            }

            public function send(string $apiKey, string $body): TransportResponse
            {
                throw TransportError::network($this->sensitiveMarker);
            }
        }));
        persistentContractAssert($error?->codeName === 'network_failure', 'network failure must preserve its stable code');
        persistentContractAssert($error->getMessage() === 'transport network request failed', 'network failure must expose only a generic message');
        persistentContractAssert(!str_contains($error->getMessage(), $sensitiveMarker), 'network failure must not expose raw transport details');
    };

    $tests['HTTP transport hides raw requester failures'] = static function (): void {
        $sensitiveMarker = 'opaque-sensitive-detail-' . bin2hex(random_bytes(8));
        $transport = new HttpTransport(requester: static function () use ($sensitiveMarker): never {
            throw new RuntimeException($sensitiveMarker);
        });
        $error = null;
        try {
            $transport->send('LOGBREW_API_KEY', '{}');
        } catch (TransportError $caught) {
            $error = $caught;
        }
        persistentContractAssert($error?->codeName === 'network_failure', 'HTTP requester failure must use the network code');
        persistentContractAssert($error->getMessage() === 'http transport failed', 'HTTP requester failure must expose only a generic message');
        persistentContractAssert(!str_contains($error->getMessage(), $sensitiveMarker), 'HTTP requester failure must not expose raw details');
    };

    $tests['HTTP transport normalizes requester SDK failures'] = static function (): void {
        $sensitiveMarker = 'opaque-sensitive-detail-' . bin2hex(random_bytes(8));
        $failures = [
            TransportError::network($sensitiveMarker),
            new SdkError('unsafe_callback_code', $sensitiveMarker),
        ];
        foreach ($failures as $failure) {
            $transport = new HttpTransport(requester: static function () use ($failure): never {
                throw $failure;
            });
            $error = null;
            try {
                $transport->send('LOGBREW_API_KEY', '{}');
            } catch (TransportError $caught) {
                $error = $caught;
            }
            persistentContractAssert($error?->codeName === 'network_failure', 'requester SDK failure must use the network code');
            persistentContractAssert($error->getMessage() === 'http transport failed', 'requester SDK failure must expose only a generic message');
            persistentContractAssert(!str_contains($error->getMessage(), $sensitiveMarker), 'requester SDK failure must not expose callback details');
        }
    };

    $tests['inherited empty persistent client rejects flush'] = static function (): void {
        if (!function_exists('pcntl_fork')) {
            return;
        }
        $directory = persistentContractDirectory();
        $store = EncryptedFileEventStore::open($directory, random_bytes(32));
        $client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', eventStore: $store);
        $resultFile = dirname($directory) . '/child-result';
        try {
            $child = pcntl_fork();
            persistentContractAssert($child >= 0, 'empty-flush ownership child must start');
            if ($child === 0) {
                $code = null;
                $message = null;
                try {
                    $client->flush(RecordingTransport::alwaysAccept());
                } catch (SdkError $error) {
                    $code = $error->codeName;
                    $message = $error->getMessage();
                }
                file_put_contents($resultFile, json_encode(['code' => $code, 'message' => $message], JSON_THROW_ON_ERROR));
                exit(0);
            }
            $status = 0;
            persistentContractAssert(pcntl_waitpid($child, $status) === $child, 'empty-flush ownership child must finish');
            persistentContractAssert(is_int($status), 'empty-flush ownership child status must be available');
            persistentContractAssert(pcntl_wifexited($status) && pcntl_wexitstatus($status) === 0, 'empty-flush ownership child must exit cleanly');
            $result = json_decode((string) file_get_contents($resultFile), true, 512, JSON_THROW_ON_ERROR);
            persistentContractAssert(is_array($result), 'empty-flush ownership child result must be an object');
            $code = $result['code'] ?? null;
            $message = $result['message'] ?? null;
            persistentContractAssert($code === 'process_ownership_error', 'inherited empty flush must reject copied queue ownership');
            persistentContractAssert(is_string($message), 'ownership failure must have a stable message');
            persistentContractAssert(!str_contains($message, (string) $child), 'ownership failure must not expose child process IDs');
        } finally {
            $store->close();
            removePersistentContractDirectory($directory);
        }
    };

    $tests['FPM and cross-worker ownership remain explicit'] = static function (): void {
        $readme = file_get_contents(__DIR__ . '/../README.md');
        persistentContractAssert(is_string($readme), 'PHP README must be readable');
        persistentContractAssert(str_contains($readme, 'PHP-FPM'), 'PHP README must state the FPM persistence boundary');
        persistentContractAssert(
            str_contains($readme, "cannot flush, purge, close, or otherwise manage another worker's queue"),
            'PHP README must reject cross-worker queue ownership claims'
        );
    };

    $failures = [];
    foreach ($tests as $name => $test) {
        try {
            $test();
        } catch (Throwable $error) {
            $failures[] = $name . ': ' . $error->getMessage();
        }
    }

    if ($failures !== []) {
        foreach ($failures as $failure) {
            fwrite(STDERR, $failure . PHP_EOL);
        }
        exit(1);
    }

    fwrite(STDOUT, sprintf("php persistent delivery contract checks passed (%d)\n", count($tests)));
}
