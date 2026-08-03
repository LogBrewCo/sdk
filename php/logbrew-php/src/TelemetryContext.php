<?php

declare(strict_types=1);

namespace LogBrew;

/** Immutable schema-v1 resource, trace, session, subject, and tag context shared by every signal. */
final class TelemetryContext
{
    public const SCHEMA_VERSION = 1;

    /** @param array<string, mixed> $value */
    private function __construct(private readonly array $value)
    {
    }

    /** Return a builder for one non-empty shared context. */
    public static function create(): TelemetryContextBuilder
    {
        return new TelemetryContextBuilder();
    }

    /**
     * Validate, normalize, and detach a schema-shaped context array.
     *
     * @param array<mixed> $value
     */
    public static function fromArray(array $value): self
    {
        $value = TelemetryContextValue::object($value, 'telemetry context');
        TelemetryContextValue::rejectUnknownFields(
            $value,
            ['schemaVersion', 'resource', 'trace', 'session', 'subject', 'tags'],
            'telemetry context'
        );
        if (($value['schemaVersion'] ?? null) !== self::SCHEMA_VERSION) {
            throw TelemetryContextValue::invalid('telemetry context schemaVersion must be 1');
        }

        $normalized = ['schemaVersion' => self::SCHEMA_VERSION];
        if (array_key_exists('resource', $value)) {
            $resource = TelemetryContextValue::object($value['resource'], 'telemetry context resource');
            $normalized['resource'] = TelemetryResource::fromArray($resource)->toArray();
        }
        if (array_key_exists('trace', $value)) {
            $normalized['trace'] = self::normalizeTrace($value['trace']);
        }
        if (array_key_exists('session', $value)) {
            $normalized['session'] = self::normalizeSession($value['session']);
        }
        if (array_key_exists('subject', $value)) {
            $normalized['subject'] = self::normalizeSubject($value['subject']);
        }
        if (array_key_exists('tags', $value)) {
            $normalized['tags'] = self::normalizeTags($value['tags']);
        }
        if (count($normalized) === 1) {
            throw TelemetryContextValue::invalid(
                'telemetry context must include resource, trace, session, subject, or tags'
            );
        }

        return new self($normalized);
    }

    /**
     * Merge client context with an event override. Resource fields and tags merge by field;
     * later trace, session, and subject sections replace their earlier section.
     */
    public static function merge(?self $base, ?self $override): ?self
    {
        if ($base === null) {
            return $override;
        }
        if ($override === null) {
            return $base;
        }

        $baseValue = $base->value;
        $overrideValue = $override->value;
        $merged = ['schemaVersion' => self::SCHEMA_VERSION];
        $baseResourceValue = $baseValue['resource'] ?? null;
        $overrideResourceValue = $overrideValue['resource'] ?? null;
        $baseResource = is_array($baseResourceValue)
            ? TelemetryResource::fromArray($baseResourceValue)
            : null;
        $overrideResource = is_array($overrideResourceValue)
            ? TelemetryResource::fromArray($overrideResourceValue)
            : null;
        $resource = TelemetryResource::merge($baseResource, $overrideResource);
        if ($resource !== null) {
            $merged['resource'] = $resource->toArray();
        }
        foreach (['trace', 'session', 'subject'] as $section) {
            $sectionValue = $overrideValue[$section] ?? $baseValue[$section] ?? null;
            if (is_array($sectionValue)) {
                $merged[$section] = $sectionValue;
            }
        }
        $baseTags = $baseValue['tags'] ?? null;
        $overrideTags = $overrideValue['tags'] ?? null;
        if (is_array($baseTags) || is_array($overrideTags)) {
            $tags = array_merge(is_array($baseTags) ? $baseTags : [], is_array($overrideTags) ? $overrideTags : []);
            ksort($tags, SORT_STRING);
            TelemetryContextValue::requireTagCount(count($tags));
            $merged['tags'] = $tags;
        }

        return self::fromArray($merged);
    }

    /** @internal Add exact trace correlation over any existing context. */
    public static function withTrace(?self $context, LogBrewTraceContext $trace): self
    {
        $traceContext = self::create()->withTrace($trace)->build();
        $merged = self::merge($context, $traceContext);
        if ($merged === null) {
            throw TelemetryContextValue::invalid('telemetry trace context could not be created');
        }
        return $merged;
    }

    /** @internal Conservative automatic PHP runtime, OS-family, and architecture identity. */
    public static function runtimeDefaults(): self
    {
        $resource = TelemetryResource::create()->withRuntime('php', PHP_VERSION);
        $operatingSystem = self::safeRuntimeValue(static fn (): string => PHP_OS_FAMILY);
        if ($operatingSystem !== null) {
            $resource->withOperatingSystem(strtolower($operatingSystem));
        }
        $architecture = self::safeRuntimeValue(static fn (): string => php_uname('m'));
        if ($architecture !== null) {
            $resource->withDevice(architecture: $architecture);
        }

        return self::create()->withResource($resource->build())->build();
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return $this->value;
    }

    /** @return array<string, mixed> */
    private static function normalizeTrace(mixed $value): array
    {
        $value = TelemetryContextValue::object($value, 'telemetry context trace');
        TelemetryContextValue::rejectUnknownFields(
            $value,
            ['traceId', 'spanId', 'parentSpanId', 'sampled'],
            'telemetry context trace'
        );
        if (!is_string($value['traceId'] ?? null)) {
            throw TelemetryContextValue::invalid('traceId must be 32 non-zero hex characters');
        }
        $normalized = ['traceId' => TelemetryContextValue::traceId($value['traceId'])];
        foreach (['spanId', 'parentSpanId'] as $field) {
            if (array_key_exists($field, $value)) {
                if (!is_string($value[$field])) {
                    throw TelemetryContextValue::invalid("{$field} must be 16 non-zero hex characters");
                }
                $normalized[$field] = TelemetryContextValue::optionalSpanId($value[$field], $field);
            }
        }
        if (array_key_exists('sampled', $value)) {
            if (!is_bool($value['sampled'])) {
                throw TelemetryContextValue::invalid('sampled must be a boolean');
            }
            $normalized['sampled'] = $value['sampled'];
        }
        return $normalized;
    }

    /** @return array<string, string> */
    private static function normalizeSession(mixed $value): array
    {
        $value = TelemetryContextValue::object($value, 'telemetry context session');
        TelemetryContextValue::rejectUnknownFields($value, ['id', 'previousId'], 'telemetry context session');
        if (!is_string($value['id'] ?? null)) {
            throw TelemetryContextValue::invalid('session id must be a string');
        }
        $id = TelemetryContextValue::requiredId($value['id'], 'session id');
        $normalized = ['id' => $id];
        if (array_key_exists('previousId', $value)) {
            if (!is_string($value['previousId'])) {
                throw TelemetryContextValue::invalid('session previousId must be a string');
            }
            $previousId = TelemetryContextValue::requiredId($value['previousId'], 'session previousId');
            if ($previousId === $id) {
                throw TelemetryContextValue::invalid('session previousId must differ from id');
            }
            $normalized['previousId'] = $previousId;
        }
        return $normalized;
    }

    /** @return array{id:string, kind:string} */
    private static function normalizeSubject(mixed $value): array
    {
        $value = TelemetryContextValue::object($value, 'telemetry context subject');
        TelemetryContextValue::rejectUnknownFields($value, ['id', 'kind'], 'telemetry context subject');
        if (!is_string($value['id'] ?? null)) {
            throw TelemetryContextValue::invalid('subject id must be a string');
        }
        $kind = $value['kind'] ?? null;
        if ($kind !== 'anonymous' && $kind !== 'user') {
            throw TelemetryContextValue::invalid('subject kind must be anonymous or user');
        }
        return [
            'id' => TelemetryContextValue::requiredId($value['id'], 'subject id'),
            'kind' => $kind,
        ];
    }

    /** @return array<string, string> */
    private static function normalizeTags(mixed $value): array
    {
        $value = TelemetryContextValue::object($value, 'telemetry context tags');
        TelemetryContextValue::requireStringKeys($value, 'telemetry context tags');
        TelemetryContextValue::requireTagCount(count($value));
        $normalized = [];
        $keys = array_keys($value);
        sort($keys, SORT_STRING);
        foreach ($keys as $key) {
            if (!is_string($value[$key])) {
                throw TelemetryContextValue::invalid("tag value for {$key} must be a string");
            }
            $normalized[TelemetryContextValue::tagKey($key)] = TelemetryContextValue::requiredString(
                $value[$key],
                "tag value for {$key}"
            );
        }
        return $normalized;
    }

    private static function safeRuntimeValue(callable $probe): ?string
    {
        try {
            $value = $probe();
            return is_string($value)
                ? TelemetryContextValue::requiredString($value, 'runtime context value')
                : null;
        } catch (\Throwable) {
            return null;
        }
    }
}
