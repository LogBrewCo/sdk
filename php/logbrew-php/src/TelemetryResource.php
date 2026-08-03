<?php

declare(strict_types=1);

namespace LogBrew;

/** Immutable bounded service, deployment, runtime, framework, OS, device, and application identity. */
final class TelemetryResource
{
    /** @param array<string, array<string, string>> $value */
    private function __construct(private readonly array $value)
    {
    }

    /** Return a builder for one non-empty telemetry resource. */
    public static function create(): TelemetryResourceBuilder
    {
        return new TelemetryResourceBuilder();
    }

    /**
     * Validate and detach a schema-shaped resource array.
     *
     * @param array<mixed> $value
     */
    public static function fromArray(array $value): self
    {
        $value = TelemetryContextValue::object($value, 'telemetry resource');
        TelemetryContextValue::rejectUnknownFields($value, [
            'service',
            'deployment',
            'runtime',
            'framework',
            'operatingSystem',
            'device',
            'application',
        ], 'telemetry resource');
        if ($value === []) {
            throw TelemetryContextValue::invalid('telemetry resource must not be empty');
        }

        $normalized = [];
        foreach ([
            'service' => ['name', 'version'],
            'deployment' => ['environment', 'release'],
            'runtime' => ['name', 'version'],
            'framework' => ['name', 'version'],
            'operatingSystem' => ['name', 'version', 'build'],
            'device' => ['family', 'model', 'architecture'],
            'application' => ['name', 'version', 'build'],
        ] as $sectionName => $fields) {
            if (!array_key_exists($sectionName, $value)) {
                continue;
            }
            $section = TelemetryContextValue::object(
                $value[$sectionName],
                "telemetry resource {$sectionName}"
            );
            TelemetryContextValue::rejectUnknownFields(
                $section,
                $fields,
                "telemetry resource {$sectionName}"
            );
            $normalizedSection = [];
            foreach ($fields as $field) {
                if (!array_key_exists($field, $section) || !is_string($section[$field])) {
                    if (array_key_exists($field, $section)) {
                        throw TelemetryContextValue::invalid(
                            "telemetry resource {$sectionName} {$field} must be a string"
                        );
                    }
                    continue;
                }
                $normalizedSection[$field] = TelemetryContextValue::requiredString(
                    $section[$field],
                    "telemetry resource {$sectionName} {$field}"
                );
            }
            if (in_array($sectionName, ['service', 'runtime', 'framework', 'operatingSystem'], true)
                && !array_key_exists('name', $normalizedSection)) {
                throw TelemetryContextValue::invalid("telemetry resource {$sectionName} name is required");
            }
            if ($normalizedSection === []) {
                throw TelemetryContextValue::invalid("telemetry resource {$sectionName} must not be empty");
            }
            $normalized[$sectionName] = $normalizedSection;
        }

        return new self($normalized);
    }

    /** Field-wise merge with later resource values taking precedence. */
    public static function merge(?self $base, ?self $override): ?self
    {
        if ($base === null) {
            return $override;
        }
        if ($override === null) {
            return $base;
        }

        $merged = [];
        foreach ([
            'service',
            'deployment',
            'runtime',
            'framework',
            'operatingSystem',
            'device',
            'application',
        ] as $section) {
            $baseSection = $base->value[$section] ?? null;
            $overrideSection = $override->value[$section] ?? null;
            if ($baseSection !== null || $overrideSection !== null) {
                $merged[$section] = array_merge($baseSection ?? [], $overrideSection ?? []);
            }
        }

        return self::fromArray($merged);
    }

    /** @return array<string, array<string, string>> */
    public function toArray(): array
    {
        return $this->value;
    }
}
