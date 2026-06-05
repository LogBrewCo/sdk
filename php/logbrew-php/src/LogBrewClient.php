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
 * ActionAttributes describes the public payload fields for an action event.
 *
 * @phpstan-type MetadataValue string|int|float|bool|null
 * @phpstan-type Metadata array<string, MetadataValue>
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
 *   level: 'info'|'warning'|'error'|'critical',
 *   message?: string,
 *   metadata?: Metadata
 * }
 * @phpstan-type LogAttributes array{
 *   message: string,
 *   level: 'debug'|'info'|'warning'|'error',
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
 * @phpstan-type ActionAttributes array{
 *   name: string,
 *   status: 'queued'|'running'|'success'|'failure',
 *   metadata?: Metadata
 * }
 */
final class LogBrewClient
{
    private const ISSUE_LEVELS = ['info', 'warning', 'error', 'critical'];
    private const LOG_LEVELS = ['debug', 'info', 'warning', 'error'];
    private const SPAN_STATUSES = ['ok', 'error'];
    private const ACTION_STATUSES = ['queued', 'running', 'success', 'failure'];

    /** @var list<array<string, mixed>> */
    private array $events = [];

    private bool $closed = false;

    /** @param array{name:string, language:string, version:string} $sdk */
    private function __construct(
        private readonly string $apiKey,
        private readonly array $sdk,
        private readonly int $maxRetries
    ) {
    }

    /**
     * Create a client from public SDK identity, retry, and API key settings.
     */
    public static function create(
        string $apiKey,
        string $sdkName,
        string $sdkVersion,
        int $maxRetries = 2
    ): self {
        self::requireNonEmpty('api_key', $apiKey);
        self::requireNonEmpty('sdk_name', $sdkName);
        self::requireNonEmpty('sdk_version', $sdkVersion);

        return new self($apiKey, [
            'name' => $sdkName,
            'language' => 'php',
            'version' => $sdkVersion,
        ], $maxRetries);
    }

    /**
     * Return the queued event count currently buffered in memory.
     */
    public function pendingEvents(): int
    {
        return count($this->events);
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

        return $this->flushInternal($transport);
    }

    /**
     * Flush queued events, then mark the client closed so later writes fail.
     */
    public function shutdown(Transport $transport): TransportResponse
    {
        if ($this->closed) {
            throw new SdkError('shutdown_error', 'client is already shut down');
        }

        $response = $this->flushInternal($transport);
        $this->closed = true;
        return $response;
    }

    /** @param array<string, mixed> $attributes */
    private function pushEvent(string $type, string $id, string $timestamp, array $attributes): void
    {
        if ($this->closed) {
            throw new SdkError('shutdown_error', 'client is already shut down');
        }
        self::requireNonEmpty('event id', $id);
        self::requireTimestamp($timestamp);

        $this->events[] = [
            'type' => $type,
            'id' => $id,
            'timestamp' => $timestamp,
            'attributes' => $attributes,
        ];
    }

    private function flushInternal(Transport $transport): TransportResponse
    {
        if ($this->events === []) {
            return new TransportResponse(204, 0);
        }

        $body = $this->previewJson();
        $maxAttempts = $this->maxRetries + 1;

        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            try {
                $response = $transport->send($this->apiKey, $body);
                if ($response->statusCode === 401) {
                    throw new SdkError('unauthenticated', 'transport rejected the API key');
                }
                if ($response->statusCode >= 200 && $response->statusCode < 300) {
                    $this->events = [];
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
                throw new SdkError($error->codeName, $error->getMessage());
            }
        }

        throw new SdkError('transport_error', 'exhausted retries');
    }

    /**
     * @param ReleaseAttributes $attributes
     * @return array<string, mixed>
     */
    private function validateRelease(array $attributes): array
    {
        self::requireNonEmpty('release version', (string) ($attributes['version'] ?? ''));
        if (array_key_exists('commit', $attributes)) {
            self::requireNonEmpty('release commit', (string) $attributes['commit']);
        }

        return $this->withMetadata(array_filter([
            'version' => $attributes['version'],
            'commit' => $attributes['commit'] ?? null,
            'notes' => $attributes['notes'] ?? null,
        ], static fn (mixed $value): bool => $value !== null), $attributes['metadata'] ?? null);
    }

    /**
     * @param EnvironmentAttributes $attributes
     * @return array<string, mixed>
     */
    private function validateEnvironment(array $attributes): array
    {
        self::requireNonEmpty('environment name', (string) ($attributes['name'] ?? ''));
        return $this->withMetadata(array_filter([
            'name' => $attributes['name'],
            'region' => $attributes['region'] ?? null,
        ], static fn (mixed $value): bool => $value !== null), $attributes['metadata'] ?? null);
    }

    /**
     * @param IssueAttributes $attributes
     * @return array<string, mixed>
     */
    private function validateIssue(array $attributes): array
    {
        self::requireNonEmpty('issue title', (string) ($attributes['title'] ?? ''));
        self::requireAllowedValue('issue level', (string) ($attributes['level'] ?? ''), self::ISSUE_LEVELS);
        return $this->withMetadata(array_filter([
            'title' => $attributes['title'],
            'level' => $attributes['level'],
            'message' => $attributes['message'] ?? null,
        ], static fn (mixed $value): bool => $value !== null), $attributes['metadata'] ?? null);
    }

    /**
     * @param LogAttributes $attributes
     * @return array<string, mixed>
     */
    private function validateLog(array $attributes): array
    {
        self::requireNonEmpty('log message', (string) ($attributes['message'] ?? ''));
        self::requireAllowedValue('log level', (string) ($attributes['level'] ?? ''), self::LOG_LEVELS);
        return $this->withMetadata(array_filter([
            'message' => $attributes['message'],
            'level' => $attributes['level'],
            'logger' => $attributes['logger'] ?? null,
        ], static fn (mixed $value): bool => $value !== null), $attributes['metadata'] ?? null);
    }

    /**
     * @param SpanAttributes $attributes
     * @return array<string, mixed>
     */
    private function validateSpan(array $attributes): array
    {
        self::requireNonEmpty('span name', (string) ($attributes['name'] ?? ''));
        self::requireNonEmpty('span traceId', (string) ($attributes['traceId'] ?? ''));
        self::requireNonEmpty('span spanId', (string) ($attributes['spanId'] ?? ''));
        self::requireAllowedValue('span status', (string) ($attributes['status'] ?? ''), self::SPAN_STATUSES);
        if (array_key_exists('parentSpanId', $attributes)) {
            self::requireNonEmpty('span parentSpanId', (string) $attributes['parentSpanId']);
        }
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
            'name' => $attributes['name'],
            'traceId' => $attributes['traceId'],
            'spanId' => $attributes['spanId'],
            'parentSpanId' => $attributes['parentSpanId'] ?? null,
            'status' => $attributes['status'],
            'durationMs' => $attributes['durationMs'] ?? null,
        ], static fn (mixed $value): bool => $value !== null), $attributes['metadata'] ?? null);
    }

    /**
     * @param ActionAttributes $attributes
     * @return array<string, mixed>
     */
    private function validateAction(array $attributes): array
    {
        self::requireNonEmpty('action name', (string) ($attributes['name'] ?? ''));
        self::requireAllowedValue('action status', (string) ($attributes['status'] ?? ''), self::ACTION_STATUSES);
        return $this->withMetadata(array_filter([
            'name' => $attributes['name'],
            'status' => $attributes['status'],
        ], static fn (mixed $value): bool => $value !== null), $attributes['metadata'] ?? null);
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
        $attributes['metadata'] = $metadata;
        return $attributes;
    }

    public static function requireNonEmpty(string $label, string $value): void
    {
        if (trim($value) === '') {
            throw new SdkError('validation_error', sprintf('%s must be non-empty', $label));
        }
    }

    /** @param list<string> $allowedValues */
    private static function requireAllowedValue(string $label, string $value, array $allowedValues): void
    {
        self::requireNonEmpty($label, $value);
        if (!in_array($value, $allowedValues, true)) {
            throw new SdkError('validation_error', sprintf('%s must be one of: %s', $label, implode(', ', $allowedValues)));
        }
    }

    private static function requireTimestamp(string $timestamp): void
    {
        self::requireNonEmpty('timestamp', $timestamp);
        if (str_ends_with($timestamp, 'Z')) {
            return;
        }
        $parts = explode('T', $timestamp, 2);
        if (count($parts) === 2) {
            $timePortion = $parts[1];
            if (str_contains($timePortion, '+')) {
                return;
            }
            $dashPosition = strrpos($timePortion, '-');
            if ($dashPosition !== false && $dashPosition > 0) {
                return;
            }
        }
        throw new SdkError('validation_error', sprintf('timestamp must include a timezone offset: %s', $timestamp));
    }
}
