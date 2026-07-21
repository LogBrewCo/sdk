<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Public PHP client for building, validating, previewing, and flushing LogBrew event batches.
 * ReleaseAttributes describes the public payload fields for a release event.
 * EnvironmentAttributes describes the public payload fields for an environment event.
 * IssueAttributes describes the public payload fields for an issue event.
 * LogAttributes describes the public payload fields for a log event.
 * SpanAttributes describes the public payload fields for a span event.
 * MetricAttributes describes the public payload fields for an explicit metric event.
 * ActionAttributes describes the public payload fields for an action event.
 *
 * @phpstan-type MetadataValue string|int|float|bool|null
 * @phpstan-type Metadata array<string, MetadataValue>
 * @phpstan-type Severity 'info'|'warning'|'error'|'critical'
 * @phpstan-type SeverityAlias 'trace'|'debug'|'warn'|'fatal'
 * @phpstan-type ReleaseAttributes array{
 *   version: string,
 *   commit?: string,
 *   notes?: string,
 *   metadata?: Metadata
 * }
 * @phpstan-type EnvironmentAttributes array{
 *   name: string,
 *   region?: string,
 *   metadata?: Metadata
 * }
 * @phpstan-type IssueAttributes array{
 *   title: string,
 *   level: Severity|SeverityAlias,
 *   message?: string,
 *   metadata?: Metadata
 * }
 * @phpstan-type LogAttributes array{
 *   message: string,
 *   level: Severity|SeverityAlias,
 *   logger?: string,
 *   metadata?: Metadata
 * }
 * @phpstan-type SpanAttributes array{
 *   name: string,
 *   traceId: string,
 *   spanId: string,
 *   parentSpanId?: string,
 *   status: 'ok'|'error',
 *   durationMs?: int|float,
 *   metadata?: Metadata
 * }
 * @phpstan-type MetricAttributes array{
 *   name: string,
 *   kind: 'counter'|'gauge'|'histogram',
 *   value: int|float,
 *   unit: string,
 *   temporality: 'delta'|'cumulative'|'instant',
 *   metadata?: Metadata
 * }
 * @phpstan-type ActionAttributes array{
 *   name: string,
 *   status: 'queued'|'running'|'success'|'failure',
 *   metadata?: Metadata
 * }
 */
final class LogBrewClient
{
    private const DEFAULT_MAX_QUEUE_SIZE = 1_000;
    private const DEFAULT_MAX_QUEUE_BYTES = 4_194_304;
    private const DEFAULT_MAX_BATCH_EVENTS = 100;
    private const DEFAULT_MAX_BATCH_BYTES = 262_144;
    private const BATCH_SUFFIX = ']}';
    private const SEVERITY_VALUES = ['trace', 'debug', 'info', 'warn', 'warning', 'error', 'fatal', 'critical'];
    private const SPAN_STATUSES = ['ok', 'error'];
    private const ACTION_STATUSES = ['queued', 'running', 'success', 'failure'];
    private const METRIC_KINDS = ['counter', 'gauge', 'histogram'];
    private const DELTA_CUMULATIVE_TEMPORALITIES = ['delta', 'cumulative'];
    private const INSTANT_TEMPORALITY = ['instant'];
    private const NON_NEGATIVE_METRIC_KINDS = ['counter', 'histogram'];

    /** @var list<array<string, mixed>> */
    private array $events = [];

    /** @var list<string> */
    private array $serializedEvents = [];

    /** @var list<int> */
    private array $serializedEventBytes = [];

    /** @var list<int|null> */
    private array $storedEventSequences = [];

    private int $pendingEventBytes = 0;

    private ?string $retryBatchBody = null;

    private int $retryBatchEvents = 0;

    private int $droppedEvents = 0;

    private bool $closed = false;

    private bool $closing = false;

    private bool $flushing = false;

    private string $batchPrefix;

    private int $batchPrefixBytes;

    /** @param array{name:string, language:string, version:string} $sdk */
    private function __construct(
        private readonly string $apiKey,
        private readonly array $sdk,
        private readonly int $maxRetries,
        private readonly int $maxQueueSize,
        private readonly int $maxQueueBytes,
        private readonly ?\Closure $onEventDropped,
        private readonly int $maxBatchEvents,
        private readonly int $maxBatchBytes,
        private readonly ?EncryptedFileEventStore $eventStore
    ) {
        try {
            $sdkJson = json_encode($sdk, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new SdkError('validation_error', 'sdk identity must be JSON serializable');
        }
        $this->batchPrefix = '{"sdk":' . $sdkJson . ',"events":[';
        $this->batchPrefixBytes = strlen($this->batchPrefix);
        if ($this->eventStore !== null) {
            $this->recoverPersistedEvents();
        }
    }

    /**
     * Create a client from public SDK identity, retry, and API key settings.
     */
    public static function create(
        string $apiKey,
        string $sdkName,
        string $sdkVersion,
        int $maxRetries = 2,
        int $maxQueueSize = self::DEFAULT_MAX_QUEUE_SIZE,
        int $maxQueueBytes = self::DEFAULT_MAX_QUEUE_BYTES,
        ?callable $onEventDropped = null,
        int $maxBatchEvents = self::DEFAULT_MAX_BATCH_EVENTS,
        int $maxBatchBytes = self::DEFAULT_MAX_BATCH_BYTES,
        ?EncryptedFileEventStore $eventStore = null
    ): self {
        self::requireNonEmpty('api_key', $apiKey);
        self::requireNonEmpty('sdk_name', $sdkName);
        self::requireNonEmpty('sdk_version', $sdkVersion);
        if ($maxRetries < 0) {
            throw new SdkError('validation_error', 'maxRetries must be non-negative');
        }
        if ($maxQueueSize <= 0) {
            throw new SdkError('validation_error', 'maxQueueSize must be greater than zero');
        }
        if ($maxQueueBytes <= 0) {
            throw new SdkError('validation_error', 'maxQueueBytes must be greater than zero');
        }
        if ($maxBatchEvents <= 0) {
            throw new SdkError('validation_error', 'maxBatchEvents must be greater than zero');
        }
        if ($maxBatchBytes <= 0) {
            throw new SdkError('validation_error', 'maxBatchBytes must be greater than zero');
        }

        return new self($apiKey, [
            'name' => $sdkName,
            'language' => 'php',
            'version' => $sdkVersion,
        ], $maxRetries, $maxQueueSize, $maxQueueBytes, $onEventDropped === null ? null : \Closure::fromCallable($onEventDropped), $maxBatchEvents, $maxBatchBytes, $eventStore);
    }

    /**
     * Return the queued event count currently buffered in memory.
     */
    public function pendingEvents(): int
    {
        return count($this->events);
    }

    /**
     * Return the compact serialized bytes currently retained for queued events.
     */
    public function pendingEventBytes(): int
    {
        return $this->pendingEventBytes;
    }

    /**
     * Return the cumulative number of events rejected by queue pressure.
     */
    public function droppedEvents(): int
    {
        return $this->droppedEvents;
    }

    /**
     * Explicitly discard current in-memory and persisted events without sending them.
     */
    public function purgePersistedEvents(): void
    {
        if ($this->eventStore === null) {
            throw new SdkError('persistent_queue_error', 'client has no persistent event store');
        }
        if ($this->closed || $this->closing || $this->flushing) {
            throw new SdkError('shutdown_error', 'client cannot purge persistent events in its current state');
        }
        $this->eventStore->purge();
        $this->events = [];
        $this->serializedEvents = [];
        $this->serializedEventBytes = [];
        $this->storedEventSequences = [];
        $this->pendingEventBytes = 0;
        $this->retryBatchBody = null;
        $this->retryBatchEvents = 0;
    }

    /**
     * Return the queued event batch as stable, pretty-printed JSON.
     */
    public function previewJson(): string
    {
        $payload = json_encode(['sdk' => $this->sdk, 'events' => $this->events], JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR);
        return $payload;
    }

    /** @param ReleaseAttributes $attributes */
    public function release(string $id, string $timestamp, array $attributes): void
    {
        $this->pushEvent('release', $id, $timestamp, $this->validateRelease($attributes));
    }

    /** @param EnvironmentAttributes $attributes */
    public function environment(string $id, string $timestamp, array $attributes): void
    {
        $this->pushEvent('environment', $id, $timestamp, $this->validateEnvironment($attributes));
    }

    /** @param IssueAttributes $attributes */
    public function issue(string $id, string $timestamp, array $attributes): void
    {
        $this->pushEvent('issue', $id, $timestamp, $this->validateIssue($attributes));
    }

    /** @param LogAttributes $attributes */
    public function log(string $id, string $timestamp, array $attributes): void
    {
        $this->pushEvent('log', $id, $timestamp, $this->validateLog($attributes));
    }

    /** @param SpanAttributes $attributes */
    public function span(string $id, string $timestamp, array $attributes): void
    {
        $this->pushEvent('span', $id, $timestamp, $this->validateSpan($attributes));
    }

    /** @param MetricAttributes $attributes */
    public function metric(string $id, string $timestamp, array $attributes): void
    {
        $this->pushEvent('metric', $id, $timestamp, $this->validateMetric($attributes));
    }

    /** @param ActionAttributes $attributes */
    public function action(string $id, string $timestamp, array $attributes): void
    {
        $this->pushEvent('action', $id, $timestamp, $this->validateAction($attributes));
    }

    /**
     * Flush queued events through a transport while preserving retry semantics.
     */
    public function flush(Transport $transport): TransportResponse
    {
        if ($this->closed) {
            throw new SdkError('shutdown_error', 'client is already shut down');
        }
        if ($this->closing) {
            throw new SdkError('shutdown_error', 'client is shutting down');
        }
        if ($this->flushing) {
            throw new SdkError('flush_error', 'flush is already in progress');
        }

        $this->flushing = true;
        try {
            return $this->flushInternal($transport);
        } finally {
            $this->flushing = false;
        }
    }

    /**
     * Flush queued events, then mark the client closed so later writes fail.
     */
    public function shutdown(Transport $transport): TransportResponse
    {
        if ($this->closed) {
            throw new SdkError('shutdown_error', 'client is already shut down');
        }
        if ($this->closing) {
            throw new SdkError('shutdown_error', 'client is shutting down');
        }
        if ($this->flushing) {
            throw new SdkError('flush_error', 'flush is already in progress');
        }

        $this->closing = true;
        $this->flushing = true;
        try {
            $response = $this->flushInternal($transport);
            $this->eventStore?->close();
            $this->closed = true;
            return $response;
        } finally {
            $this->flushing = false;
            $this->closing = false;
        }
    }

    /** @param array<string, mixed> $attributes */
    private function pushEvent(string $type, string $id, string $timestamp, array $attributes): void
    {
        if ($this->closed) {
            throw new SdkError('shutdown_error', 'client is already shut down');
        }
        if ($this->closing) {
            throw new SdkError('shutdown_error', 'client is shutting down');
        }
        self::requireNonEmpty('event id', $id);
        self::requireTimestamp($timestamp);
        if (count($this->events) >= $this->maxQueueSize) {
            $this->recordDroppedEvent($id, $type, 'queue_overflow');
            return;
        }

        $event = [
            'type' => $type,
            'id' => $id,
            'timestamp' => $timestamp,
            'attributes' => $attributes,
        ];

        try {
            $eventJson = json_encode($event, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new SdkError('validation_error', 'event must be JSON serializable');
        }
        $eventBytes = strlen($eventJson);
        if (
            $eventBytes > $this->maxQueueBytes
            || $this->batchPrefixBytes + $eventBytes + strlen(self::BATCH_SUFFIX) > $this->maxBatchBytes
        ) {
            $this->recordDroppedEvent($id, $type, 'event_too_large');
            return;
        }
        if ($eventBytes > $this->maxQueueBytes - $this->pendingEventBytes) {
            $this->recordDroppedEvent($id, $type, 'queue_overflow');
            return;
        }

        $storedSequence = $this->eventStore?->append($eventJson);
        $this->events[] = $event;
        $this->serializedEvents[] = $eventJson;
        $this->serializedEventBytes[] = $eventBytes;
        $this->storedEventSequences[] = $storedSequence;
        $this->pendingEventBytes += $eventBytes;
    }

    private function recordDroppedEvent(string $eventId, string $eventType, string $reason): void
    {
        if ($this->droppedEvents < PHP_INT_MAX) {
            $this->droppedEvents++;
        }
        if ($this->onEventDropped === null) {
            return;
        }

        try {
            ($this->onEventDropped)(new DroppedEvent(
                $eventId,
                $eventType,
                $reason,
                $this->droppedEvents,
                count($this->events),
                $this->pendingEventBytes
            ));
        } catch (\Throwable) {
            // Application callbacks must not affect telemetry capture or app behavior.
        }
    }

    private function flushInternal(Transport $transport): TransportResponse
    {
        $this->eventStore?->assertUsableByCurrentProcess();
        if ($this->events === []) {
            return new TransportResponse(204, 0, 0);
        }

        $remainingEvents = count($this->events);
        $attempts = 0;
        $batches = 0;
        $statusCode = 204;

        $retryBatchBody = $this->retryBatchBody;
        if ($retryBatchBody !== null) {
            $this->stagePersistentBatch($this->retryBatchEvents, $retryBatchBody);
            $response = $this->sendBatch($transport, $retryBatchBody);
            $retryBatchEvents = $this->retryBatchEvents;
            $this->acknowledge($retryBatchEvents);
            $this->retryBatchBody = null;
            $this->retryBatchEvents = 0;
            $remainingEvents -= $retryBatchEvents;
            $attempts += $response->attempts;
            $batches++;
            $statusCode = $response->statusCode;
        }

        while ($remainingEvents > 0) {
            $batch = $this->nextBatch(min($remainingEvents, $this->maxBatchEvents));
            $this->stagePersistentBatch($batch['events'], $batch['body']);
            if ($this->eventStore !== null) {
                $this->retryBatchBody = $batch['body'];
                $this->retryBatchEvents = $batch['events'];
            }
            try {
                $response = $this->sendBatch($transport, $batch['body']);
            } catch (\Throwable $error) {
                $this->retryBatchBody = $batch['body'];
                $this->retryBatchEvents = $batch['events'];
                throw $error;
            }
            $this->acknowledge($batch['events']);
            $this->retryBatchBody = null;
            $this->retryBatchEvents = 0;
            $remainingEvents -= $batch['events'];
            $attempts += $response->attempts;
            $batches++;
            $statusCode = $response->statusCode;
        }

        return new TransportResponse($statusCode, $attempts, $batches);
    }

    private function stagePersistentBatch(int $events, string $body): void
    {
        if ($this->eventStore === null) {
            return;
        }
        $sequences = array_slice($this->storedEventSequences, 0, $events);
        if (in_array(null, $sequences, true)) {
            throw new SdkError('persistent_queue_error', 'persistent event sequence is unavailable');
        }
        /** @var list<int> $sequences */
        $this->eventStore->stageBatch($sequences, $body);
    }

    /** @return array{body:string, events:int} */
    private function nextBatch(int $maxEvents): array
    {
        $bodyBytes = $this->batchPrefixBytes + strlen(self::BATCH_SUFFIX);
        $events = 0;
        for ($index = 0; $index < $maxEvents; $index++) {
            $separatorBytes = $events === 0 ? 0 : 1;
            $nextBodyBytes = $bodyBytes + $separatorBytes + $this->serializedEventBytes[$index];
            if ($nextBodyBytes > $this->maxBatchBytes) {
                break;
            }
            $bodyBytes = $nextBodyBytes;
            $events++;
        }
        if ($events === 0) {
            throw new SdkError('transport_error', 'queued event cannot fit the configured batch byte limit');
        }

        return [
            'body' => $this->batchPrefix . implode(',', array_slice($this->serializedEvents, 0, $events)) . self::BATCH_SUFFIX,
            'events' => $events,
        ];
    }

    private function acknowledge(int $events): void
    {
        if ($this->eventStore !== null) {
            $sequences = array_slice($this->storedEventSequences, 0, $events);
            if (in_array(null, $sequences, true)) {
                throw new SdkError('persistent_queue_error', 'persistent event sequence is unavailable');
            }
            /** @var list<int> $sequences */
            $this->eventStore->acknowledge($sequences);
        }
        $acknowledgedBytes = array_sum(array_slice($this->serializedEventBytes, 0, $events));
        array_splice($this->events, 0, $events);
        array_splice($this->serializedEvents, 0, $events);
        array_splice($this->serializedEventBytes, 0, $events);
        array_splice($this->storedEventSequences, 0, $events);
        $this->pendingEventBytes -= $acknowledgedBytes;
    }

    private function recoverPersistedEvents(): void
    {
        if ($this->eventStore === null) {
            return;
        }
        $snapshot = $this->eventStore->recover($this->maxQueueSize, $this->maxQueueBytes);
        foreach ($snapshot['events'] as $record) {
            $event = $this->decodePersistedEvent($record['json']);
            $eventBytes = strlen($record['json']);
            $this->events[] = $event;
            $this->serializedEvents[] = $record['json'];
            $this->serializedEventBytes[] = $eventBytes;
            $this->storedEventSequences[] = $record['sequence'];
            $this->pendingEventBytes += $eventBytes;
        }
        $retry = $snapshot['retry'];
        if ($retry !== null) {
            $retryEvents = count($retry['sequences']);
            $expectedSequences = array_slice($this->storedEventSequences, 0, $retryEvents);
            if ($expectedSequences !== $retry['sequences']) {
                throw new SdkError('persistent_queue_error', 'persistent retry batch does not match the SDK queue');
            }
            $this->retryBatchBody = $retry['body'];
            $this->retryBatchEvents = $retryEvents;
        }
    }

    /** @return array<string, mixed> */
    private function decodePersistedEvent(string $eventJson): array
    {
        try {
            $decoded = json_decode($eventJson, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains invalid event JSON');
        }
        if (!is_array($decoded) || array_keys($decoded) !== ['type', 'id', 'timestamp', 'attributes']) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains invalid events');
        }

        $type = $decoded['type'] ?? null;
        $id = $decoded['id'] ?? null;
        $timestamp = $decoded['timestamp'] ?? null;
        $rawAttributes = $decoded['attributes'] ?? null;
        if (!is_string($type) || !is_string($id) || !is_string($timestamp) || !is_array($rawAttributes)) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains invalid events');
        }

        $attributes = [];
        foreach ($rawAttributes as $key => $value) {
            if (!is_string($key)) {
                throw new SdkError('persistent_queue_error', 'persistent event storage contains invalid events');
            }
            $attributes[$key] = $value;
        }
        if (!self::persistedAttributesHaveExpectedTypes($type, $attributes)) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains invalid events');
        }
        try {
            self::requireNonEmpty('event id', $id);
            self::requireTimestamp($timestamp);
            $validatedAttributes = match ($type) {
                'release' => $this->validateRelease($attributes),
                'environment' => $this->validateEnvironment($attributes),
                'issue' => $this->validateIssue($attributes),
                'log' => $this->validateLog($attributes),
                'span' => $this->validateSpan($attributes),
                'metric' => $this->validateMetric($attributes),
                'action' => $this->validateAction($attributes),
                default => throw new SdkError('validation_error', 'event type is unsupported'),
            };
        } catch (SdkError) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains invalid events');
        }
        if ($validatedAttributes !== $attributes) {
            throw new SdkError('persistent_queue_error', 'persistent event storage contains invalid events');
        }

        return [
            'type' => $type,
            'id' => $id,
            'timestamp' => $timestamp,
            'attributes' => $validatedAttributes,
        ];
    }

    /** @param array<string, mixed> $attributes */
    private static function persistedAttributesHaveExpectedTypes(string $type, array $attributes): bool
    {
        $stringFields = match ($type) {
            'release' => ['version', 'commit', 'notes'],
            'environment' => ['name', 'region'],
            'issue' => ['title', 'level', 'message'],
            'log' => ['message', 'level', 'logger'],
            'span' => ['name', 'traceId', 'spanId', 'parentSpanId', 'status'],
            'metric' => ['name', 'kind', 'unit', 'temporality'],
            'action' => ['name', 'status'],
            default => [],
        };
        if ($stringFields === []) {
            return false;
        }
        foreach ($stringFields as $field) {
            if (array_key_exists($field, $attributes) && !is_string($attributes[$field])) {
                return false;
            }
        }
        if (array_key_exists('durationMs', $attributes) && !is_int($attributes['durationMs']) && !is_float($attributes['durationMs'])) {
            return false;
        }
        if (array_key_exists('value', $attributes) && !is_int($attributes['value']) && !is_float($attributes['value'])) {
            return false;
        }
        if (!array_key_exists('metadata', $attributes)) {
            return true;
        }
        if (!is_array($attributes['metadata'])) {
            return false;
        }
        return self::metadataHasExpectedTypes($attributes['metadata']);
    }

    private function sendBatch(Transport $transport, string $body): TransportResponse
    {
        $maxAttempts = $this->maxRetries + 1;

        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            try {
                $response = $transport->send($this->apiKey, $body);
                if ($response->statusCode === 401) {
                    throw new SdkError('unauthenticated', 'transport rejected the API key');
                }
                if ($response->statusCode >= 200 && $response->statusCode < 300) {
                    return new TransportResponse($response->statusCode, $attempt);
                }
                if ($response->statusCode >= 500 && $attempt < $maxAttempts) {
                    continue;
                }
                throw new SdkError('transport_error', sprintf('unexpected transport status %d', $response->statusCode));
            } catch (TransportError $error) {
                if ($error->retryable && $attempt < $maxAttempts) {
                    continue;
                }
                if ($error->codeName === 'network_failure') {
                    throw new SdkError('network_failure', 'transport network request failed');
                }
                throw new SdkError('transport_error', 'transport request failed');
            }
        }

        throw new SdkError('transport_error', 'exhausted retries');
    }

    /**
     * @param array<string, mixed> $attributes
     * @return array<string, mixed>
     */
    private function validateRelease(array $attributes): array
    {
        $version = self::requireStringAttribute($attributes, 'version', 'release version');
        $commit = self::optionalStringAttribute($attributes, 'commit', 'release commit', true);
        $notes = self::optionalStringAttribute($attributes, 'notes', 'release notes');

        return $this->withMetadata(array_filter([
            'version' => $version,
            'commit' => $commit,
            'notes' => $notes,
        ], static fn (mixed $value): bool => $value !== null), $attributes['metadata'] ?? null);
    }

    /**
     * @param array<string, mixed> $attributes
     * @return array<string, mixed>
     */
    private function validateEnvironment(array $attributes): array
    {
        $name = self::requireStringAttribute($attributes, 'name', 'environment name');
        $region = self::optionalStringAttribute($attributes, 'region', 'environment region');
        return $this->withMetadata(array_filter([
            'name' => $name,
            'region' => $region,
        ], static fn (mixed $value): bool => $value !== null), $attributes['metadata'] ?? null);
    }

    /**
     * @param array<string, mixed> $attributes
     * @return array<string, mixed>
     */
    private function validateIssue(array $attributes): array
    {
        $title = self::requireStringAttribute($attributes, 'title', 'issue title');
        $level = self::normalizeSeverity('issue level', self::requireStringAttribute($attributes, 'level', 'issue level'));
        $message = self::optionalStringAttribute($attributes, 'message', 'issue message');
        return $this->withMetadata(array_filter([
            'title' => $title,
            'level' => $level,
            'message' => $message,
        ], static fn (mixed $value): bool => $value !== null), $attributes['metadata'] ?? null);
    }

    /**
     * @param array<string, mixed> $attributes
     * @return array<string, mixed>
     */
    private function validateLog(array $attributes): array
    {
        $message = self::requireStringAttribute($attributes, 'message', 'log message');
        $level = self::normalizeSeverity('log level', self::requireStringAttribute($attributes, 'level', 'log level'));
        $logger = self::optionalStringAttribute($attributes, 'logger', 'log logger');
        return $this->withMetadata(array_filter([
            'message' => $message,
            'level' => $level,
            'logger' => $logger,
        ], static fn (mixed $value): bool => $value !== null), $attributes['metadata'] ?? null);
    }

    /**
     * @param array<string, mixed> $attributes
     * @return array<string, mixed>
     */
    private function validateSpan(array $attributes): array
    {
        $name = self::requireStringAttribute($attributes, 'name', 'span name');
        $traceId = self::requireStringAttribute($attributes, 'traceId', 'span traceId');
        $spanId = self::requireStringAttribute($attributes, 'spanId', 'span spanId');
        $status = self::requireStringAttribute($attributes, 'status', 'span status');
        self::requireAllowedValue('span status', $status, self::SPAN_STATUSES);
        $parentSpanId = self::optionalStringAttribute($attributes, 'parentSpanId', 'span parentSpanId', true);
        $duration = null;
        if (array_key_exists('durationMs', $attributes)) {
            $duration = $attributes['durationMs'];
            if (!is_int($duration) && !is_float($duration)) {
                throw new SdkError('validation_error', 'span durationMs must be non-negative');
            }
            if ($duration < 0) {
                throw new SdkError('validation_error', 'span durationMs must be non-negative');
            }
        }
        return $this->withMetadata(array_filter([
            'name' => $name,
            'traceId' => $traceId,
            'spanId' => $spanId,
            'parentSpanId' => $parentSpanId,
            'status' => $status,
            'durationMs' => $duration,
        ], static fn (mixed $value): bool => $value !== null), $attributes['metadata'] ?? null);
    }

    /**
     * @param array<string, mixed> $attributes
     * @return array<string, mixed>
     */
    private function validateMetric(array $attributes): array
    {
        $name = self::requireStringAttribute($attributes, 'name', 'metric name');
        $kind = self::requireStringAttribute($attributes, 'kind', 'metric kind');
        self::requireAllowedValue('metric kind', $kind, self::METRIC_KINDS);
        $value = self::requireFiniteNumber('metric value', $attributes['value'] ?? null);
        $unit = self::requireStringAttribute($attributes, 'unit', 'metric unit');
        $temporality = self::requireStringAttribute($attributes, 'temporality', sprintf('metric temporality for %s', $kind));
        self::requireAllowedValue(
            sprintf('metric temporality for %s', $kind),
            $temporality,
            $kind === 'gauge' ? self::INSTANT_TEMPORALITY : self::DELTA_CUMULATIVE_TEMPORALITIES
        );
        if (in_array($kind, self::NON_NEGATIVE_METRIC_KINDS, true) && $value < 0) {
            throw new SdkError('validation_error', sprintf('metric %s value must be non-negative', $kind));
        }

        return $this->withMetadata([
            'name' => $name,
            'kind' => $kind,
            'value' => $value,
            'unit' => $unit,
            'temporality' => $temporality,
        ], $attributes['metadata'] ?? null);
    }

    /**
     * @param array<string, mixed> $attributes
     * @return array<string, mixed>
     */
    private function validateAction(array $attributes): array
    {
        $name = self::requireStringAttribute($attributes, 'name', 'action name');
        $status = self::requireStringAttribute($attributes, 'status', 'action status');
        self::requireAllowedValue('action status', $status, self::ACTION_STATUSES);
        return $this->withMetadata([
            'name' => $name,
            'status' => $status,
        ], $attributes['metadata'] ?? null);
    }

    /** @param array<string, mixed> $attributes */
    private static function requireStringAttribute(array $attributes, string $field, string $label): string
    {
        $value = $attributes[$field] ?? null;
        if (!is_string($value)) {
            throw new SdkError('validation_error', sprintf('%s must be a string', $label));
        }
        self::requireNonEmpty($label, $value);

        return $value;
    }

    /** @param array<string, mixed> $attributes */
    private static function optionalStringAttribute(
        array $attributes,
        string $field,
        string $label,
        bool $nonEmpty = false
    ): ?string {
        if (!array_key_exists($field, $attributes)) {
            return null;
        }
        $value = $attributes[$field];
        if ($value === null && !$nonEmpty) {
            return null;
        }
        if (!is_string($value)) {
            throw new SdkError('validation_error', sprintf('%s must be a string', $label));
        }
        if ($nonEmpty) {
            self::requireNonEmpty($label, $value);
        }

        return $value;
    }

    /**
     * @param array<string, mixed> $attributes
     * @return array<string, mixed>
     */
    private function withMetadata(array $attributes, mixed $metadata): array
    {
        if ($metadata === null) {
            return $attributes;
        }
        if (!is_array($metadata)) {
            throw new SdkError('validation_error', 'metadata must be an object');
        }
        if (!self::metadataHasExpectedTypes($metadata)) {
            throw new SdkError('validation_error', 'metadata must contain primitive values with string keys');
        }
        $attributes['metadata'] = $metadata;
        return $attributes;
    }

    /** @param array<mixed> $metadata */
    private static function metadataHasExpectedTypes(array $metadata): bool
    {
        foreach ($metadata as $key => $value) {
            if (!is_string($key) || !self::isMetadataValue($value)) {
                return false;
            }
        }

        return true;
    }

    public static function requireNonEmpty(string $label, string $value): void
    {
        if (trim($value) === '') {
            throw new SdkError('validation_error', sprintf('%s must be non-empty', $label));
        }
    }

    /**
     * Copy primitive metadata while omitting arrays, objects, resources, and non-finite floats.
     *
     * @param array<string, mixed> $metadata
     * @return Metadata
     */
    public static function copyPrimitiveMetadata(array $metadata): array
    {
        $copied = [];
        foreach ($metadata as $key => $value) {
            $stringKey = (string) $key;
            if (trim($stringKey) === '' || !self::isMetadataValue($value)) {
                continue;
            }
            $copied[$stringKey] = $value;
        }

        return $copied;
    }

    /** @phpstan-assert-if-true MetadataValue $value */
    public static function isMetadataValue(mixed $value): bool
    {
        if ($value === null || is_string($value) || is_int($value) || is_bool($value)) {
            return true;
        }

        return is_float($value) && is_finite($value);
    }

    /** @param list<string> $allowedValues */
    private static function requireAllowedValue(string $label, string $value, array $allowedValues): void
    {
        self::requireNonEmpty($label, $value);
        if (!in_array($value, $allowedValues, true)) {
            throw new SdkError('validation_error', sprintf('%s must be one of: %s', $label, implode(', ', $allowedValues)));
        }
    }

    private static function normalizeSeverity(string $label, string $value): string
    {
        self::requireAllowedValue($label, $value, self::SEVERITY_VALUES);
        return match ($value) {
            'trace', 'debug', 'info' => 'info',
            'warn', 'warning' => 'warning',
            'error' => 'error',
            'fatal', 'critical' => 'critical',
            default => 'info',
        };
    }

    private static function requireFiniteNumber(string $label, mixed $value): int|float
    {
        if (!is_int($value) && !is_float($value)) {
            throw new SdkError('validation_error', sprintf('%s must be a finite number', $label));
        }
        if (is_float($value) && !is_finite($value)) {
            throw new SdkError('validation_error', sprintf('%s must be a finite number', $label));
        }

        return $value;
    }

    private static function requireTimestamp(string $timestamp): void
    {
        self::requireNonEmpty('timestamp', $timestamp);
        $matches = [];
        if (
            preg_match(
                '/^(?<year>[0-9]{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12][0-9]|3[01])'
                . 'T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?'
                . '(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/D',
                $timestamp,
                $matches
            ) !== 1
            || !checkdate((int) $matches['month'], (int) $matches['day'], (int) $matches['year'])
        ) {
            throw new SdkError('validation_error', sprintf('timestamp must be a valid RFC3339 date-time: %s', $timestamp));
        }
    }
}
