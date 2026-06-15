<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Dependency-free W3C traceparent helpers for explicit app-owned propagation.
 *
 * @phpstan-import-type SpanAttributes from LogBrewClient
 */
final class Traceparent
{
    private const VERSION = '00';

    private function __construct()
    {
    }

    /**
     * Parse and validate one W3C traceparent header.
     */
    public static function parse(string $traceparent): TraceparentContext
    {
        LogBrewClient::requireNonEmpty('traceparent', $traceparent);
        $normalized = strtolower(trim($traceparent));
        $parts = explode('-', $normalized);
        if (count($parts) !== 4) {
            throw new SdkError('validation_error', 'traceparent must have four fields');
        }

        [$version, $traceId, $parentSpanId, $traceFlags] = $parts;
        self::requireVersion($version);
        self::requireTraceId($traceId);
        self::requireSpanId('traceparent parent span id', $parentSpanId);
        $flags = self::normalizeTraceFlags($traceFlags);

        return new TraceparentContext(
            $version,
            $traceId,
            $parentSpanId,
            $flags,
            (hexdec($flags) & 1) === 1
        );
    }

    /**
     * Create one normalized W3C traceparent header value from explicit IDs.
     */
    public static function create(string $traceId, string $spanId, string $traceFlags = '01'): string
    {
        $normalizedTraceId = self::normalizeTraceId($traceId);
        $normalizedSpanId = self::normalizeSpanId('traceparent span id', $spanId);
        $flags = self::normalizeTraceFlags($traceFlags);

        return sprintf('%s-%s-%s-%s', self::VERSION, $normalizedTraceId, $normalizedSpanId, $flags);
    }

    /**
     * Create outgoing propagation headers from explicit trace and span IDs.
     *
     * @return array{traceparent:string}
     */
    public static function createHeaders(string $traceId, string $spanId, string $traceFlags = '01'): array
    {
        return ['traceparent' => self::create($traceId, $spanId, $traceFlags)];
    }

    /**
     * Build LogBrew span attributes for a fresh child span linked to an incoming traceparent.
     *
     * @return SpanAttributes
     */
    public static function spanAttributesFromTraceparent(string|TraceparentContext $traceparent, TraceparentSpanInput $input): array
    {
        $context = is_string($traceparent) ? self::parse($traceparent) : $traceparent;

        $attributes = [
            'name' => $input->name,
            'traceId' => $context->traceId,
            'spanId' => self::normalizeSpanId('span spanId', $input->spanId),
            'parentSpanId' => $context->parentSpanId,
            'status' => $input->status(),
        ];

        $durationMs = $input->durationMs();
        if ($durationMs !== null) {
            $attributes['durationMs'] = $durationMs;
        }

        $metadata = $input->metadata();
        if ($metadata !== null) {
            $attributes['metadata'] = $metadata;
        }

        return $attributes;
    }

    private static function requireVersion(string $version): void
    {
        if (strlen($version) !== 2 || !self::isLowerHex($version) || $version === 'ff') {
            throw new SdkError('validation_error', 'traceparent version must be two hex characters and not ff');
        }
    }

    private static function normalizeTraceId(string $traceId): string
    {
        $normalized = strtolower(trim($traceId));
        self::requireTraceId($normalized);
        return $normalized;
    }

    private static function requireTraceId(string $traceId): void
    {
        if (strlen($traceId) !== 32 || !self::isLowerHex($traceId) || self::isAllZero($traceId)) {
            throw new SdkError('validation_error', 'traceparent trace id must be 32 non-zero hex characters');
        }
    }

    private static function normalizeSpanId(string $label, string $spanId): string
    {
        $normalized = strtolower(trim($spanId));
        self::requireSpanId($label, $normalized);
        return $normalized;
    }

    private static function requireSpanId(string $label, string $spanId): void
    {
        if (strlen($spanId) !== 16 || !self::isLowerHex($spanId) || self::isAllZero($spanId)) {
            throw new SdkError('validation_error', sprintf('%s must be 16 non-zero hex characters', $label));
        }
    }

    private static function normalizeTraceFlags(string $traceFlags): string
    {
        $normalized = strtolower(trim($traceFlags));
        if (strlen($normalized) !== 2 || !self::isLowerHex($normalized)) {
            throw new SdkError('validation_error', 'traceparent flags must be two hex characters');
        }

        return $normalized;
    }

    private static function isLowerHex(string $value): bool
    {
        return preg_match('/^[0-9a-f]+$/', $value) === 1;
    }

    private static function isAllZero(string $value): bool
    {
        return trim($value, '0') === '';
    }
}
