<?php

declare(strict_types=1);

namespace LogBrew;

/** @internal Shared validation for schema-v1 telemetry context values. */
final class TelemetryContextValue
{
    public const MAX_ID_LENGTH = 200;
    public const MAX_STRING_LENGTH = 256;
    public const MAX_TAGS = 32;
    public const MAX_TAG_KEY_LENGTH = 64;

    private function __construct()
    {
    }

    public static function requiredString(string $value, string $label, int $maxLength = self::MAX_STRING_LENGTH): string
    {
        $normalized = trim($value);
        if (
            $normalized === ''
            || preg_match('/\S/u', $normalized) !== 1
            || !self::hasAtMostCodePoints($normalized, $maxLength)
            || preg_match('/[\x00-\x1F\x7F-\x{009F}]/u', $normalized) === 1
        ) {
            throw self::invalid("{$label} is invalid");
        }

        return $normalized;
    }

    public static function optionalString(?string $value, string $label): ?string
    {
        return $value === null ? null : self::requiredString($value, $label);
    }

    public static function requiredId(string $value, string $label): string
    {
        return self::requiredString($value, $label, self::MAX_ID_LENGTH);
    }

    public static function optionalId(?string $value, string $label): ?string
    {
        return $value === null ? null : self::requiredId($value, $label);
    }

    public static function traceId(string $value, string $label = 'traceId'): string
    {
        return self::hexId($value, 32, $label);
    }

    public static function optionalSpanId(?string $value, string $label): ?string
    {
        return $value === null ? null : self::hexId($value, 16, $label);
    }

    public static function tagKey(string $value): string
    {
        if (
            strlen($value) > self::MAX_TAG_KEY_LENGTH
            || preg_match('/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/D', $value) !== 1
        ) {
            throw self::invalid('tag key is invalid');
        }

        return $value;
    }

    public static function requireTagCount(int $count): void
    {
        if ($count < 1 || $count > self::MAX_TAGS) {
            throw self::invalid('tags must contain 1-32 entries');
        }
    }

    /** @param array<mixed> $value */
    public static function requireStringKeys(array $value, string $label): void
    {
        foreach (array_keys($value) as $key) {
            if (!is_string($key)) {
                throw self::invalid("{$label} must be an object");
            }
        }
    }

    /** @return array<string, mixed> */
    public static function object(mixed $value, string $label): array
    {
        if (!is_array($value)) {
            throw self::invalid("{$label} must be an object");
        }
        $normalized = [];
        foreach ($value as $key => $item) {
            if (!is_string($key)) {
                throw self::invalid("{$label} must be an object");
            }
            $normalized[$key] = $item;
        }
        return $normalized;
    }

    /**
     * @param array<string, mixed> $value
     * @param list<string> $allowed
     */
    public static function rejectUnknownFields(array $value, array $allowed, string $label): void
    {
        self::requireStringKeys($value, $label);
        foreach (array_keys($value) as $key) {
            if (!in_array($key, $allowed, true)) {
                throw self::invalid("{$label} contains unsupported field {$key}");
            }
        }
    }

    public static function invalid(string $message): SdkError
    {
        return new SdkError('validation_error', $message);
    }

    private static function hexId(string $value, int $width, string $label): string
    {
        $normalized = strtolower(trim($value));
        if (
            strlen($normalized) !== $width
            || preg_match('/^[0-9a-f]+$/D', $normalized) !== 1
            || $normalized === str_repeat('0', $width)
        ) {
            throw self::invalid("{$label} must be {$width} non-zero hex characters");
        }

        return $normalized;
    }

    private static function hasAtMostCodePoints(string $value, int $maximum): bool
    {
        $count = preg_match_all('/./us', $value, $matches);
        return is_int($count) && $count > 0 && $count <= $maximum;
    }
}
