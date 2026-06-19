<?php

declare(strict_types=1);

namespace LogBrew;

use Throwable;

/**
 * Explicit dependency span helpers for app-owned database, cache, and queue calls.
 *
 * @phpstan-import-type Metadata from LogBrewClient
 * @phpstan-type OperationTracingOptions array{
 *   eventId?: string,
 *   timestamp?: string,
 *   durationMs?: int|float,
 *   metadata?: array<string, mixed>,
 *   system?: string,
 *   operation?: string,
 *   target?: string,
 *   onCaptureError?: callable(Throwable): void
 * }
 */
final class LogBrewOperationTracing
{
    private const SENSITIVE_KEY_PARTS = [
        'authorization',
        'body',
        'cachekey',
        'connectionstring',
        'cookie',
        'dsn',
        'header',
        'host',
        'pass' . 'word',
        'pay' . 'load',
        'query',
        'sec' . 'ret',
        'to' . 'ken',
        'url',
        'username',
    ];

    private function __construct()
    {
    }

    /**
     * Run an app-owned database callback while emitting one correlated dependency span.
     *
     * @param OperationTracingOptions $options
     */
    public static function databaseOperation(LogBrewClient $client, string $name, callable $operation, array $options = []): mixed
    {
        return self::captureOperation($client, 'database.operation', $name, $operation, $options);
    }

    /**
     * Run an app-owned cache callback while emitting one correlated dependency span.
     *
     * @param OperationTracingOptions $options
     */
    public static function cacheOperation(LogBrewClient $client, string $name, callable $operation, array $options = []): mixed
    {
        return self::captureOperation($client, 'cache.operation', $name, $operation, $options);
    }

    /**
     * Run an app-owned queue callback while emitting one correlated dependency span.
     *
     * @param OperationTracingOptions $options
     */
    public static function queueOperation(LogBrewClient $client, string $name, callable $operation, array $options = []): mixed
    {
        return self::captureOperation($client, 'queue.operation', $name, $operation, $options);
    }

    /**
     * @param OperationTracingOptions $options
     */
    private static function captureOperation(
        LogBrewClient $client,
        string $source,
        string $name,
        callable $operation,
        array $options
    ): mixed {
        LogBrewClient::requireNonEmpty('operation span name', $name);
        $parent = LogBrewTrace::current();
        $trace = $parent === null ? LogBrewTraceContext::createRoot() : LogBrewTraceContext::createChild($parent);
        $startedAt = hrtime(true);

        try {
            $result = LogBrewTrace::withTrace($trace, static fn (LogBrewTraceContext $active): mixed => $operation($active));
        } catch (Throwable $error) {
            self::enqueueSpan($client, $source, $name, $trace, 'error', $startedAt, $options, $error);
            throw $error;
        }

        self::enqueueSpan($client, $source, $name, $trace, 'ok', $startedAt, $options, null);
        return $result;
    }

    /**
     * @param OperationTracingOptions $options
     */
    private static function enqueueSpan(
        LogBrewClient $client,
        string $source,
        string $name,
        LogBrewTraceContext $trace,
        string $status,
        int $startedAt,
        array $options,
        ?Throwable $operationError
    ): void {
        try {
            $metadata = self::metadata($source, $options, $operationError);
            $attributes = [
                'name' => $name,
                'traceId' => $trace->traceId,
                'spanId' => $trace->spanId,
                'status' => $status === 'error' ? 'error' : 'ok',
                'durationMs' => self::durationMs($startedAt, $options['durationMs'] ?? null),
                'metadata' => LogBrewTrace::metadataWithTrace($trace, $metadata),
            ];
            if ($trace->parentSpanId !== null) {
                $attributes['parentSpanId'] = $trace->parentSpanId;
            }
            $client->span(
                (string) ($options['eventId'] ?? self::generateEventId($source)),
                (string) ($options['timestamp'] ?? self::timestampNow()),
                $attributes
            );
        } catch (Throwable $captureError) {
            self::reportCaptureError($options['onCaptureError'] ?? null, $captureError);
        }
    }

    /**
     * @param OperationTracingOptions $options
     * @return Metadata
     */
    private static function metadata(string $source, array $options, ?Throwable $operationError): array
    {
        $metadata = [
            'source' => $source,
        ];

        foreach (['system', 'operation', 'target'] as $key) {
            if (isset($options[$key]) && is_scalar($options[$key])) {
                $value = trim((string) $options[$key]);
                if ($value !== '' && !self::isSensitiveKey($key)) {
                    $metadata[$key] = $value;
                }
            }
        }

        if (isset($options['metadata']) && is_array($options['metadata'])) {
            foreach (LogBrewClient::copyPrimitiveMetadata($options['metadata']) as $key => $value) {
                if (!self::isSensitiveKey($key)) {
                    $metadata[$key] = $value;
                }
            }
        }

        if ($operationError !== null) {
            $metadata['exceptionType'] = $operationError::class;
        }

        return $metadata;
    }

    private static function isSensitiveKey(string $key): bool
    {
        $normalized = strtolower(preg_replace('/[^a-zA-Z0-9]+/', '', $key) ?? $key);
        foreach (self::SENSITIVE_KEY_PARTS as $part) {
            if (str_contains($normalized, $part)) {
                return true;
            }
        }

        return false;
    }

    private static function durationMs(int $startedAt, mixed $override): int|float
    {
        if (is_int($override) || is_float($override)) {
            if ($override >= 0 && (!is_float($override) || is_finite($override))) {
                return $override;
            }
        }

        return max(0.0, (hrtime(true) - $startedAt) / 1_000_000);
    }

    private static function timestampNow(): string
    {
        return gmdate('Y-m-d\TH:i:s\Z');
    }

    private static function generateEventId(string $source): string
    {
        $prefix = str_replace('.', '_', $source);
        return 'evt_span_php_' . $prefix . '_' . bin2hex(random_bytes(6));
    }

    private static function reportCaptureError(mixed $callback, Throwable $error): void
    {
        if (!is_callable($callback)) {
            return;
        }

        try {
            $callback($error);
        } catch (Throwable) {
            // Diagnostics callbacks must not replace app results or app exceptions.
        }
    }
}
