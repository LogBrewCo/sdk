<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Opt-in encrypted event persistence for one serialized POSIX worker process.
 */
final class EncryptedFileEventStore
{
    private const MAGIC = "LBQ1";
    private const NONCE_BYTES = 12;
    private const TAG_BYTES = 16;
    private const MAX_FILE_BYTES = 8_388_608;
    private const LOCK_FILE = '.lock';
    private const ACK_FILE = '.ack';
    private const RETRY_FILE = '.retry';
    private const EVENT_FILE_PATTERN = '/^(?<sequence>[0-9]{20})\.event$/D';
    private const TEMP_FILE_PATTERN = '/^\.tmp-[a-f0-9]{32}$/D';

    /** @var resource */
    private $lockHandle;

    private bool $closed = false;

    private int $nextSequence = 1;

    private int $acknowledgedSequence = 0;

    /** @param resource $lockHandle */
    private function __construct(
        private readonly string $directory,
        private string $key,
        private readonly int $ownerProcessId,
        private readonly int $directoryDevice,
        private readonly int $directoryInode,
        $lockHandle
    ) {
        $this->lockHandle = $lockHandle;
    }

    /**
     * Open and exclusively lock an owner-only persistent queue directory.
     */
    public static function open(string $directory, string $key): self
    {
        if (DIRECTORY_SEPARATOR !== '/') {
            throw new SdkError('validation_error', 'persistent event storage requires POSIX');
        }
        if (strlen($key) !== 32) {
            throw new SdkError('validation_error', 'persistent event storage requires a 32-byte key');
        }
        if (
            !function_exists('openssl_encrypt')
            || !function_exists('openssl_decrypt')
            || !in_array('aes-256-gcm', openssl_get_cipher_methods(true), true)
        ) {
            throw new SdkError('validation_error', 'persistent event storage requires AES-256-GCM support');
        }
        self::validateAbsolutePath($directory);

        if (!file_exists($directory)) {
            if (!@mkdir($directory, 0700) || !@chmod($directory, 0700)) {
                throw new SdkError('persistent_queue_error', 'persistent event storage could not be opened');
            }
        }

        $directoryStat = @lstat($directory);
        $resolvedDirectory = @realpath($directory);
        if (
            !is_array($directoryStat)
            || $resolvedDirectory !== $directory
            || ($directoryStat['mode'] & 0170000) !== 0040000
            || ($directoryStat['mode'] & 0777) !== 0700
        ) {
            throw new SdkError('persistent_queue_error', 'persistent event storage requires an owner-only directory');
        }
        if (function_exists('posix_geteuid') && $directoryStat['uid'] !== posix_geteuid()) {
            throw new SdkError('persistent_queue_error', 'persistent event storage requires an owner-only directory');
        }

        $lockPath = $directory . '/' . self::LOCK_FILE;
        $lockHandle = self::openLockFile($lockPath);
        if (!@flock($lockHandle, LOCK_EX | LOCK_NB)) {
            @fclose($lockHandle);
            throw new SdkError('persistent_queue_error', 'persistent event storage is already in use');
        }

        $processId = getmypid();
        if ($processId === false) {
            @flock($lockHandle, LOCK_UN);
            @fclose($lockHandle);
            throw new SdkError('process_ownership_error', 'persistent event storage process identity is unavailable');
        }

        $store = new self(
            $directory,
            $key,
            $processId,
            (int) $directoryStat['dev'],
            (int) $directoryStat['ino'],
            $lockHandle
        );
        $store->removeInterruptedTemporaryFiles();
        $store->acknowledgedSequence = $store->readAcknowledgedSequence();
        $store->scanEventFiles();

        return $store;
    }

    /**
     * Recover compact event JSON in oldest-first sequence order.
     *
     * @return array{
     *   events:list<array{sequence:int,json:string}>,
     *   retry:array{sequences:list<int>,body:string}|null
     * }
     */
    public function recover(int $maxEvents, int $maxBytes): array
    {
        $this->assertUsable();
        if ($maxEvents <= 0 || $maxBytes <= 0) {
            throw new SdkError('validation_error', 'persistent event recovery bounds must be positive');
        }

        $files = $this->scanEventFiles();
        if (count($files) > $maxEvents) {
            throw new SdkError('persistent_queue_error', 'persistent event storage exceeds configured bounds');
        }

        $records = [];
        $bytes = 0;
        foreach ($files as $sequence => $fileName) {
            $eventJson = $this->readEncryptedFile($fileName, 'event:' . $fileName);
            $eventBytes = strlen($eventJson);
            if ($eventBytes > $maxBytes - $bytes) {
                throw new SdkError('persistent_queue_error', 'persistent event storage exceeds configured bounds');
            }
            $bytes += $eventBytes;
            $records[] = ['sequence' => $sequence, 'json' => $eventJson];
        }

        return [
            'events' => $records,
            'retry' => $this->readRetryBatch($records),
        ];
    }

    /**
     * Durably append one already-validated compact event and return its sequence.
     */
    public function append(string $eventJson): int
    {
        $this->assertUsable();
        if ($eventJson === '') {
            throw new SdkError('validation_error', 'persistent event must be non-empty');
        }
        $sequence = $this->nextSequence;
        if ($sequence === PHP_INT_MAX) {
            throw new SdkError('persistent_queue_error', 'persistent event sequence is exhausted');
        }
        $fileName = sprintf('%020d.event', $sequence);
        $this->writeEncryptedFile($fileName, $eventJson, 'event:' . $fileName, false);
        $this->nextSequence++;

        return $sequence;
    }

    /**
     * Persist the exact next request body before any transport attempt.
     *
     * @param list<int> $sequences
     */
    public function stageBatch(array $sequences, string $body): void
    {
        $this->assertUsable();
        if ($sequences === [] || $body === '') {
            throw new SdkError('validation_error', 'persistent retry batch must be non-empty');
        }
        $availableSequences = array_keys($this->scanEventFiles());
        if (array_slice($availableSequences, 0, count($sequences)) !== $sequences) {
            throw new SdkError('persistent_queue_error', 'persistent retry batch is not the queued prefix');
        }
        try {
            $payload = json_encode([
                'sequences' => $sequences,
                'body' => $body,
            ], JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new SdkError('persistent_queue_error', 'persistent retry batch could not be encoded');
        }
        $this->writeEncryptedFile(self::RETRY_FILE, $payload, 'retry', true);
    }

    /**
     * Commit an accepted queue prefix before best-effort file compaction.
     *
     * @param list<int> $sequences
     */
    public function acknowledge(array $sequences): void
    {
        $this->assertUsable();
        if ($sequences === []) {
            throw new SdkError('validation_error', 'persistent acknowledgement must be non-empty');
        }
        $availableSequences = array_keys($this->scanEventFiles());
        if (array_slice($availableSequences, 0, count($sequences)) !== $sequences) {
            throw new SdkError('persistent_queue_error', 'persistent acknowledgement is not the queued prefix');
        }
        $acceptedSequence = $sequences[count($sequences) - 1];
        $this->writeEncryptedFile(self::ACK_FILE, (string) $acceptedSequence, 'ack', true);
        $this->acknowledgedSequence = $acceptedSequence;

        foreach ($sequences as $sequence) {
            @unlink($this->directory . '/' . sprintf('%020d.event', $sequence));
        }
        @unlink($this->directory . '/' . self::RETRY_FILE);
        $this->assertUsable();
    }

    /**
     * Delete every persisted event after explicit application intent.
     */
    public function purge(): void
    {
        $this->assertUsable();
        $files = $this->scanEventFiles();
        if ($files !== []) {
            $lastSequence = array_key_last($files);
            if (!is_int($lastSequence)) {
                throw new SdkError('persistent_queue_error', 'persistent event storage could not be purged');
            }
            $this->writeEncryptedFile(self::ACK_FILE, (string) $lastSequence, 'ack', true);
            $this->acknowledgedSequence = $lastSequence;
        }
        foreach ($files as $fileName) {
            @unlink($this->directory . '/' . $fileName);
        }
        @unlink($this->directory . '/' . self::RETRY_FILE);
        $this->nextSequence = max($this->nextSequence, $this->acknowledgedSequence + 1);
        $this->assertUsable();
    }

    /**
     * Release this process's exclusive store lock. This method never sends telemetry.
     */
    public function close(): void
    {
        if ($this->closed) {
            return;
        }
        $this->assertProcessOwnership();
        @flock($this->lockHandle, LOCK_UN);
        @fclose($this->lockHandle);
        if (function_exists('sodium_memzero')) {
            $key = $this->key;
            sodium_memzero($key);
            $this->key = '';
        } else {
            $this->key = str_repeat("\0", strlen($this->key));
        }
        $this->closed = true;
    }

    private static function validateAbsolutePath(string $directory): void
    {
        if (
            $directory === ''
            || !str_starts_with($directory, '/')
            || str_contains($directory, "\0")
            || str_contains($directory, '//')
            || str_ends_with($directory, '/')
            || preg_match('#(?:^|/)\.\.?($|/)#D', $directory) === 1
        ) {
            throw new SdkError('validation_error', 'persistent event directory must be a normalized absolute path');
        }
        $parent = dirname($directory);
        $resolvedParent = @realpath($parent);
        if ($resolvedParent === false || $directory !== $resolvedParent . '/' . basename($directory)) {
            throw new SdkError('validation_error', 'persistent event directory must be a normalized absolute path');
        }
    }

    /** @return resource */
    private static function openLockFile(string $path)
    {
        $handle = @fopen($path, 'x+b');
        if (!is_resource($handle)) {
            $handle = @fopen($path, 'r+b');
            if (!is_resource($handle)) {
                throw new SdkError('persistent_queue_error', 'persistent event storage could not be opened');
            }
        }

        $stat = @fstat($handle);
        $pathStat = @lstat($path);
        if (
            !is_array($stat)
            || !is_array($pathStat)
            || ($stat['mode'] & 0170000) !== 0100000
            || ($pathStat['mode'] & 0170000) !== 0100000
            || (int) $stat['nlink'] !== 1
            || (int) $pathStat['nlink'] !== 1
            || (int) $stat['dev'] !== (int) $pathStat['dev']
            || (int) $stat['ino'] !== (int) $pathStat['ino']
            || (function_exists('posix_geteuid') && (int) $pathStat['uid'] !== posix_geteuid())
        ) {
            @fclose($handle);
            throw new SdkError('persistent_queue_error', 'persistent event storage contains unsafe files');
        }
        if (!@chmod($path, 0600)) {
            @fclose($handle);
            throw new SdkError('persistent_queue_error', 'persistent event storage could not be opened');
        }
        clearstatcache(true, $path);
        $stat = @fstat($handle);
        $pathStat = @lstat($path);
        if (
            !is_array($stat)
            || !is_array($pathStat)
            || ($stat['mode'] & 0777) !== 0600
            || ($pathStat['mode'] & 0777) !== 0600
            || (int) $stat['dev'] !== (int) $pathStat['dev']
            || (int) $stat['ino'] !== (int) $pathStat['ino']
        ) {
            @fclose($handle);
            throw new SdkError('persistent_queue_error', 'persistent event storage contains unsafe files');
        }

        return $handle;
    }

    private static function assertSafeRegularFile(string $path): void
    {
        $stat = @lstat($path);
        if (
            !is_array($stat)
            || ($stat['mode'] & 0170000) !== 0100000
            || ($stat['mode'] & 0777) !== 0600
            || (int) $stat['nlink'] !== 1
        ) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains unsafe files');
        }
    }

    private static function assertRecoverableTemporaryFile(string $path): void
    {
        $stat = @lstat($path);
        if (
            !is_array($stat)
            || ($stat['mode'] & 0170000) !== 0100000
            || (int) $stat['nlink'] !== 1
            || (function_exists('posix_geteuid') && (int) $stat['uid'] !== posix_geteuid())
        ) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains unsafe files');
        }
    }

    private function assertUsable(): void
    {
        if ($this->closed) {
            throw new SdkError('persistent_queue_error', 'persistent event storage is closed');
        }
        $this->assertProcessOwnership();
        $stat = @lstat($this->directory);
        if (
            !is_array($stat)
            || ($stat['mode'] & 0170000) !== 0040000
            || ($stat['mode'] & 0777) !== 0700
            || (int) $stat['dev'] !== $this->directoryDevice
            || (int) $stat['ino'] !== $this->directoryInode
            || (function_exists('posix_geteuid') && (int) $stat['uid'] !== posix_geteuid())
            || @realpath($this->directory) !== $this->directory
        ) {
            throw new SdkError('persistent_queue_error', 'persistent event storage directory changed while in use');
        }
        $lockStat = @fstat($this->lockHandle);
        $lockPathStat = @lstat($this->directory . '/' . self::LOCK_FILE);
        if (
            !is_array($lockStat)
            || !is_array($lockPathStat)
            || ($lockStat['mode'] & 0170000) !== 0100000
            || ($lockPathStat['mode'] & 0170000) !== 0100000
            || ($lockStat['mode'] & 0777) !== 0600
            || ($lockPathStat['mode'] & 0777) !== 0600
            || (int) $lockStat['nlink'] !== 1
            || (int) $lockPathStat['nlink'] !== 1
            || (int) $lockStat['dev'] !== (int) $lockPathStat['dev']
            || (int) $lockStat['ino'] !== (int) $lockPathStat['ino']
        ) {
            throw new SdkError('persistent_queue_error', 'persistent event storage lock changed while in use');
        }
    }

    private function assertProcessOwnership(): void
    {
        $processId = getmypid();
        if ($processId === false || $processId !== $this->ownerProcessId) {
            throw new SdkError('process_ownership_error', 'persistent event storage must be opened in the current process');
        }
    }

    private function removeInterruptedTemporaryFiles(): void
    {
        $entries = @scandir($this->directory);
        if (!is_array($entries)) {
            throw new SdkError('persistent_queue_error', 'persistent event storage could not be read');
        }
        foreach ($entries as $entry) {
            if (preg_match(self::TEMP_FILE_PATTERN, $entry) !== 1) {
                continue;
            }
            self::assertRecoverableTemporaryFile($this->directory . '/' . $entry);
            if (!@unlink($this->directory . '/' . $entry)) {
                throw new SdkError('persistent_queue_error', 'persistent event storage could not recover');
            }
        }
    }

    /** @return array<int, string> */
    private function scanEventFiles(): array
    {
        $this->assertUsable();
        $entries = @scandir($this->directory);
        if (!is_array($entries)) {
            throw new SdkError('persistent_queue_error', 'persistent event storage could not be read');
        }

        $files = [];
        $highestSequence = 0;
        foreach ($entries as $entry) {
            if (
                $entry === '.'
                || $entry === '..'
                || $entry === self::LOCK_FILE
            ) {
                continue;
            }
            if ($entry === self::ACK_FILE || $entry === self::RETRY_FILE) {
                self::assertSafeRegularFile($this->directory . '/' . $entry);
                continue;
            }
            $matches = [];
            if (preg_match(self::EVENT_FILE_PATTERN, $entry, $matches) !== 1) {
                throw new SdkError('persistent_queue_error', 'persistent event storage contains unexpected entries');
            }
            self::assertSafeRegularFile($this->directory . '/' . $entry);
            $sequence = (int) $matches['sequence'];
            if ($sequence <= 0 || isset($files[$sequence])) {
                throw new SdkError('persistent_queue_error', 'persistent event storage contains invalid records');
            }
            if ($sequence <= $this->acknowledgedSequence) {
                @unlink($this->directory . '/' . $entry);
                continue;
            }
            $files[$sequence] = $entry;
            $highestSequence = max($highestSequence, $sequence);
        }
        ksort($files, SORT_NUMERIC);
        $this->nextSequence = max(
            $this->nextSequence,
            $this->acknowledgedSequence + 1,
            $highestSequence + 1
        );

        return $files;
    }

    private function readAcknowledgedSequence(): int
    {
        $path = $this->directory . '/' . self::ACK_FILE;
        if (!is_array(@lstat($path))) {
            return 0;
        }
        $value = $this->readEncryptedFile(self::ACK_FILE, 'ack');
        if ($value === '' || preg_match('/^[1-9][0-9]*$/D', $value) !== 1) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains an invalid acknowledgement');
        }
        $sequence = (int) $value;
        if ($sequence <= 0) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains an invalid acknowledgement');
        }

        return $sequence;
    }

    /**
     * @param list<array{sequence:int,json:string}> $records
     * @return array{sequences:list<int>,body:string}|null
     */
    private function readRetryBatch(array $records): ?array
    {
        $path = $this->directory . '/' . self::RETRY_FILE;
        if (!is_array(@lstat($path))) {
            return null;
        }
        $payload = $this->readEncryptedFile(self::RETRY_FILE, 'retry');
        try {
            $retry = json_decode($payload, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains an invalid retry batch');
        }
        if (!is_array($retry) || !is_array($retry['sequences'] ?? null) || !is_string($retry['body'] ?? null)) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains an invalid retry batch');
        }
        $sequences = [];
        foreach ($retry['sequences'] as $sequence) {
            if (!is_int($sequence) || $sequence <= 0) {
                throw new SdkError('persistent_queue_error', 'persistent event storage contains an invalid retry batch');
            }
            $sequences[] = $sequence;
        }
        if ($sequences === [] || $retry['body'] === '') {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains an invalid retry batch');
        }
        $availableSequences = array_map(
            static fn (array $record): int => $record['sequence'],
            $records
        );
        if (array_slice($availableSequences, 0, count($sequences)) !== $sequences) {
            if ($sequences[count($sequences) - 1] <= $this->acknowledgedSequence) {
                @unlink($path);
                return null;
            }
            throw new SdkError('persistent_queue_error', 'persistent retry batch does not match queued events');
        }
        $this->validateRetryBody($retry['body'], array_slice($records, 0, count($sequences)));

        return ['sequences' => $sequences, 'body' => $retry['body']];
    }

    /** @param list<array{sequence:int,json:string}> $records */
    private function validateRetryBody(string $body, array $records): void
    {
        try {
            $batch = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains an invalid retry batch');
        }
        if (!is_array($batch) || array_keys($batch) !== ['sdk', 'events']) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains an invalid retry batch');
        }
        $sdk = $batch['sdk'];
        $events = $batch['events'];
        if (
            !is_array($sdk)
            || array_keys($sdk) !== ['name', 'language', 'version']
            || !is_string($sdk['name'])
            || trim($sdk['name']) === ''
            || $sdk['language'] !== 'php'
            || !is_string($sdk['version'])
            || trim($sdk['version']) === ''
            || !is_array($events)
            || !array_is_list($events)
            || count($events) !== count($records)
        ) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains an invalid retry batch');
        }
        try {
            $sdkJson = json_encode($sdk, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains an invalid retry batch');
        }
        $expectedBody = '{"sdk":' . $sdkJson . ',"events":['
            . implode(',', array_map(static fn (array $record): string => $record['json'], $records))
            . ']}';
        if ($body !== $expectedBody) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains an invalid retry batch');
        }
    }

    private function readEncryptedFile(string $fileName, string $associatedData): string
    {
        $path = $this->directory . '/' . $fileName;
        self::assertSafeRegularFile($path);
        $size = @filesize($path);
        if (!is_int($size) || $size < strlen(self::MAGIC) + self::NONCE_BYTES + self::TAG_BYTES || $size > self::MAX_FILE_BYTES) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains unreadable records');
        }
        $payload = @file_get_contents($path);
        if (!is_string($payload) || strlen($payload) !== $size || !str_starts_with($payload, self::MAGIC)) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains unreadable records');
        }

        $offset = strlen(self::MAGIC);
        $nonce = substr($payload, $offset, self::NONCE_BYTES);
        $offset += self::NONCE_BYTES;
        $tag = substr($payload, $offset, self::TAG_BYTES);
        $ciphertext = substr($payload, $offset + self::TAG_BYTES);
        $plaintext = @openssl_decrypt(
            $ciphertext,
            'aes-256-gcm',
            $this->key,
            OPENSSL_RAW_DATA,
            $nonce,
            $tag,
            $associatedData
        );
        if (!is_string($plaintext)) {
            throw new SdkError('persistent_queue_error', 'persistent event storage authentication failed');
        }

        return $plaintext;
    }

    private function writeEncryptedFile(
        string $fileName,
        string $plaintext,
        string $associatedData,
        bool $replace
    ): void {
        $this->assertUsable();
        $nonce = random_bytes(self::NONCE_BYTES);
        $tag = '';
        $ciphertext = @openssl_encrypt(
            $plaintext,
            'aes-256-gcm',
            $this->key,
            OPENSSL_RAW_DATA,
            $nonce,
            $tag,
            $associatedData,
            self::TAG_BYTES
        );
        if (!is_string($ciphertext) || strlen($tag) !== self::TAG_BYTES) {
            throw new SdkError('persistence_commit_error', 'persistent event encryption failed');
        }
        $payload = self::MAGIC . $nonce . $tag . $ciphertext;
        if (strlen($payload) > self::MAX_FILE_BYTES) {
            throw new SdkError('persistent_queue_error', 'persistent event storage record is too large');
        }

        $temporaryName = '.tmp-' . bin2hex(random_bytes(16));
        $temporaryPath = $this->directory . '/' . $temporaryName;
        $handle = @fopen($temporaryPath, 'x+b');
        if (!is_resource($handle) || !@chmod($temporaryPath, 0600)) {
            if (is_resource($handle)) {
                @fclose($handle);
            }
            @unlink($temporaryPath);
            throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
        }

        try {
            $offset = 0;
            while ($offset < strlen($payload)) {
                $written = @fwrite($handle, substr($payload, $offset));
                if (!is_int($written) || $written <= 0) {
                    throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
                }
                $offset += $written;
            }
            if (!@fflush($handle) || !@fsync($handle)) {
                throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
            }
        } finally {
            @fclose($handle);
        }

        $targetPath = $this->directory . '/' . $fileName;
        if (!$replace && file_exists($targetPath)) {
            @unlink($temporaryPath);
            throw new SdkError('persistent_queue_error', 'persistent event sequence already exists');
        }
        if (!@rename($temporaryPath, $targetPath)) {
            @unlink($temporaryPath);
            throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
        }
        $this->assertUsable();
        self::assertSafeRegularFile($targetPath);
    }
}
