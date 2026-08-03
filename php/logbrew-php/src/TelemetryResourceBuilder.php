<?php

declare(strict_types=1);

namespace LogBrew;

/** Builder for one immutable, privacy-bounded telemetry resource. */
final class TelemetryResourceBuilder
{
    /** @var array<string, array<string, string>> */
    private array $sections = [];

    /** Set the stable service name and optional version. */
    public function withService(string $name, ?string $version = null): self
    {
        $this->sections['service'] = self::namedVersion($name, $version, 'service');
        return $this;
    }

    /** Set deployment environment and/or release identity. */
    public function withDeployment(?string $environment = null, ?string $release = null): self
    {
        $this->sections['deployment'] = self::optionalSection([
            'environment' => TelemetryContextValue::optionalString($environment, 'deployment environment'),
            'release' => TelemetryContextValue::optionalString($release, 'deployment release'),
        ], 'deployment');
        return $this;
    }

    /** Set runtime name and optional version. */
    public function withRuntime(string $name, ?string $version = null): self
    {
        $this->sections['runtime'] = self::namedVersion($name, $version, 'runtime');
        return $this;
    }

    /** Set framework name and optional version. */
    public function withFramework(string $name, ?string $version = null): self
    {
        $this->sections['framework'] = self::namedVersion($name, $version, 'framework');
        return $this;
    }

    /** Set operating-system family and optional version/build. */
    public function withOperatingSystem(string $name, ?string $version = null, ?string $build = null): self
    {
        $section = ['name' => TelemetryContextValue::requiredString($name, 'operatingSystem name')];
        self::putOptional($section, 'version', TelemetryContextValue::optionalString($version, 'operatingSystem version'));
        self::putOptional($section, 'build', TelemetryContextValue::optionalString($build, 'operatingSystem build'));
        $this->sections['operatingSystem'] = $section;
        return $this;
    }

    /**
     * Set broad device family, model, and architecture values.
     * Never use unique device IDs, host names, addresses, or local account names.
     */
    public function withDevice(?string $family = null, ?string $model = null, ?string $architecture = null): self
    {
        $this->sections['device'] = self::optionalSection([
            'family' => TelemetryContextValue::optionalString($family, 'device family'),
            'model' => TelemetryContextValue::optionalString($model, 'device model'),
            'architecture' => TelemetryContextValue::optionalString($architecture, 'device architecture'),
        ], 'device');
        return $this;
    }

    /** Set application name, version, and build identity. */
    public function withApplication(?string $name = null, ?string $version = null, ?string $build = null): self
    {
        $this->sections['application'] = self::optionalSection([
            'name' => TelemetryContextValue::optionalString($name, 'application name'),
            'version' => TelemetryContextValue::optionalString($version, 'application version'),
            'build' => TelemetryContextValue::optionalString($build, 'application build'),
        ], 'application');
        return $this;
    }

    /** Validate, detach, and build one non-empty resource. */
    public function build(): TelemetryResource
    {
        return TelemetryResource::fromArray($this->sections);
    }

    /** @return array<string, string> */
    private static function namedVersion(string $name, ?string $version, string $label): array
    {
        $section = ['name' => TelemetryContextValue::requiredString($name, "{$label} name")];
        self::putOptional($section, 'version', TelemetryContextValue::optionalString($version, "{$label} version"));
        return $section;
    }

    /**
     * @param array<string, string|null> $values
     * @return array<string, string>
     */
    private static function optionalSection(array $values, string $label): array
    {
        $section = array_filter($values, static fn (?string $value): bool => $value !== null);
        if ($section === []) {
            throw TelemetryContextValue::invalid("{$label} must not be empty");
        }
        return $section;
    }

    /** @param array<string, string> $target */
    private static function putOptional(array &$target, string $key, ?string $value): void
    {
        if ($value !== null) {
            $target[$key] = $value;
        }
    }
}
