<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * App-owned child span fields derived from an incoming traceparent.
 *
 * @phpstan-import-type Metadata from LogBrewClient
 */
final class TraceparentSpanInput
{
    /** @var list<string> */
    private const SPAN_STATUSES = ['ok', 'error'];

    private int|float|null $durationMs = null;

    /** @var Metadata|null */
    private ?array $metadata = null;

    /** @var 'ok'|'error' */
    private readonly string $status;

    /** @param 'ok'|'error' $status */
    private function __construct(
        public readonly string $name,
        public readonly string $spanId,
        string $status
    ) {
        $this->status = $status;
    }

    /**
     * Create a child span input that can be converted into LogBrew span attributes.
     */
    public static function create(string $name, string $spanId, string $status = 'ok'): self
    {
        LogBrewClient::requireNonEmpty('span name', $name);
        LogBrewClient::requireNonEmpty('span spanId', $spanId);

        return new self(trim($name), trim($spanId), self::normalizeStatus($status));
    }

    /**
     * Attach a finite, non-negative duration in milliseconds.
     */
    public function withDurationMs(int|float $durationMs): self
    {
        if (is_float($durationMs) && !is_finite($durationMs)) {
            throw new SdkError('validation_error', 'span durationMs must be a finite number');
        }
        if ($durationMs < 0) {
            throw new SdkError('validation_error', 'span durationMs must be non-negative');
        }

        $copy = clone $this;
        $copy->durationMs = $durationMs;
        return $copy;
    }

    /**
     * Attach primitive low-cardinality metadata to the child span.
     *
     * @param array<string, mixed> $metadata
     */
    public function withMetadata(array $metadata): self
    {
        $copy = clone $this;
        $copy->metadata = self::copyMetadata($metadata);
        return $copy;
    }

    public function durationMs(): int|float|null
    {
        return $this->durationMs;
    }

    /** @return 'ok'|'error' */
    public function status(): string
    {
        return $this->status;
    }

    /** @return Metadata|null */
    public function metadata(): ?array
    {
        return $this->metadata;
    }

    /**
     * @param array<string, mixed> $metadata
     * @return Metadata
     */
    private static function copyMetadata(array $metadata): array
    {
        $copied = [];
        foreach ($metadata as $key => $value) {
            $stringKey = (string) $key;
            LogBrewClient::requireNonEmpty('metadata key', $stringKey);
            $copied[$stringKey] = self::metadataValue($stringKey, $value);
        }

        return $copied;
    }

    /** @return 'ok'|'error' */
    private static function normalizeStatus(string $status): string
    {
        LogBrewClient::requireNonEmpty('span status', $status);
        return match ($status) {
            'ok' => 'ok',
            'error' => 'error',
            default => throw new SdkError('validation_error', 'span status must be one of: ' . implode(', ', self::SPAN_STATUSES)),
        };
    }

    private static function metadataValue(string $key, mixed $value): string|int|float|bool|null
    {
        if ($value === null || is_string($value) || is_int($value) || is_bool($value)) {
            return $value;
        }
        if (is_float($value) && is_finite($value)) {
            return $value;
        }

        throw new SdkError('validation_error', sprintf('metadata value for %s must be a string, number, boolean, or null', $key));
    }
}
