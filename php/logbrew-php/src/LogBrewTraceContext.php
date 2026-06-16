<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Request-local W3C trace identity used to correlate logs, issues, spans, and metrics.
 *
 * @phpstan-import-type Metadata from LogBrewClient
 */
final class LogBrewTraceContext
{
    private const ZERO_TRACE_ID = '00000000000000000000000000000000';
    private const ZERO_SPAN_ID = '0000000000000000';

    private function __construct(
        public readonly string $traceId,
        public readonly string $spanId,
        public readonly ?string $parentSpanId,
        public readonly string $traceFlags,
        public readonly bool $sampled
    ) {
    }

    /**
     * Create a local root trace when no valid incoming propagation exists.
     */
    public static function createRoot(string $traceFlags = '01'): self
    {
        return self::create(self::generateTraceId(), self::generateSpanId(), null, $traceFlags);
    }

    /**
     * Continue an incoming W3C traceparent with a fresh or app-provided child span id.
     */
    public static function fromTraceparent(string $traceparent, ?string $spanId = null): self
    {
        $context = Traceparent::parse($traceparent);
        return self::create(
            $context->traceId,
            $spanId ?? self::generateSpanId(),
            $context->parentSpanId,
            $context->traceFlags
        );
    }

    /**
     * Continue valid incoming propagation, otherwise start a local root non-fatally.
     */
    public static function fromIncomingTraceparentOrCreateRoot(?string $traceparent): self
    {
        if ($traceparent !== null && trim($traceparent) !== '') {
            try {
                return self::fromTraceparent($traceparent);
            } catch (SdkError) {
                // Bad upstream headers should not interrupt request handling.
            }
        }

        return self::createRoot();
    }

    /**
     * Create a local child span under an active LogBrew trace.
     */
    public static function createChild(self $parent): self
    {
        return self::create($parent->traceId, self::generateSpanId(), $parent->spanId, $parent->traceFlags);
    }

    /**
     * Return the normalized outgoing W3C traceparent value.
     */
    public function traceparent(): string
    {
        return Traceparent::create($this->traceId, $this->spanId, $this->traceFlags);
    }

    /**
     * Return explicit propagation headers for app-owned HTTP clients.
     *
     * @return array{traceparent:string}
     */
    public function headers(): array
    {
        return Traceparent::createHeaders($this->traceId, $this->spanId, $this->traceFlags);
    }

    /**
     * Return primitive correlation metadata without serializing the raw traceparent header.
     *
     * @return Metadata
     */
    public function metadata(): array
    {
        $metadata = [
            'traceId' => $this->traceId,
            'spanId' => $this->spanId,
            'traceFlags' => $this->traceFlags,
            'traceSampled' => $this->sampled,
        ];
        if ($this->parentSpanId !== null) {
            $metadata['parentSpanId'] = $this->parentSpanId;
        }

        return $metadata;
    }

    private static function create(string $traceId, string $spanId, ?string $parentSpanId, string $traceFlags): self
    {
        $normalizedTraceId = self::normalizeTraceId($traceId);
        $normalizedSpanId = self::normalizeSpanId('spanId', $spanId);
        $normalizedParentSpanId = $parentSpanId === null ? null : self::normalizeSpanId('parentSpanId', $parentSpanId);
        $normalizedTraceFlags = self::normalizeTraceFlags($traceFlags);

        return new self(
            $normalizedTraceId,
            $normalizedSpanId,
            $normalizedParentSpanId,
            $normalizedTraceFlags,
            (hexdec($normalizedTraceFlags) & 1) === 1
        );
    }

    private static function normalizeTraceId(string $traceId): string
    {
        $normalized = strtolower(trim($traceId));
        Traceparent::create($normalized, '1111111111111111');
        return $normalized;
    }

    private static function normalizeSpanId(string $label, string $spanId): string
    {
        LogBrewClient::requireNonEmpty($label, $spanId);
        $normalized = strtolower(trim($spanId));
        Traceparent::create('11111111111111111111111111111111', $normalized);
        return $normalized;
    }

    private static function normalizeTraceFlags(string $traceFlags): string
    {
        $normalized = strtolower(trim($traceFlags));
        Traceparent::create('11111111111111111111111111111111', '1111111111111111', $normalized);
        return $normalized;
    }

    private static function generateTraceId(): string
    {
        return self::generateNonZeroHex(16, self::ZERO_TRACE_ID);
    }

    private static function generateSpanId(): string
    {
        return self::generateNonZeroHex(8, self::ZERO_SPAN_ID);
    }

    private static function generateNonZeroHex(int $byteCount, string $zeroValue): string
    {
        if ($byteCount < 1) {
            throw new SdkError('validation_error', 'random byte count must be positive');
        }

        do {
            $value = bin2hex(random_bytes($byteCount));
        } while ($value === $zeroValue);

        return $value;
    }
}
