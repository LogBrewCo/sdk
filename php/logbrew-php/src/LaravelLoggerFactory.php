<?php

declare(strict_types=1);

namespace LogBrew;

use InvalidArgumentException;
use Monolog\Level;
use Monolog\Logger as MonologLogger;
use RuntimeException;

/**
 * Config-cache-safe Laravel custom-channel factory with bounded immediate delivery.
 *
 * @phpstan-type MetadataInput array<string, mixed>
 * @phpstan-type LaravelChannelConfig array{
 *     driver: 'custom',
 *     via: class-string<self>,
 *     api_key: string|null,
 *     endpoint: string,
 *     timeout: float,
 *     max_retries: int,
 *     level: string,
 *     service: string,
 *     release: string,
 *     environment: string,
 *     include_exception_trace: bool
 * }
 */
final class LaravelLoggerFactory
{
    public function __construct(private readonly ?Transport $transport = null)
    {
    }

    /**
     * Build a scalar-only channel definition that Laravel can persist with config:cache.
     *
     * @return LaravelChannelConfig
     */
    public static function configuration(
        ?string $apiKey,
        string $service = 'laravel-app',
        string $release = 'unversioned',
        string $environment = 'production',
        string $endpoint = HttpTransport::DEFAULT_ENDPOINT,
        float $timeout = 2.0,
        int $maxRetries = 0,
        string $level = 'warning',
        bool $includeExceptionTrace = false
    ): array {
        return [
            'driver' => 'custom',
            'via' => self::class,
            'api_key' => $apiKey,
            'endpoint' => $endpoint,
            'timeout' => $timeout,
            'max_retries' => $maxRetries,
            'level' => $level,
            'service' => $service,
            'release' => $release,
            'environment' => $environment,
            'include_exception_trace' => $includeExceptionTrace,
        ];
    }

    /**
     * Create the Laravel Monolog channel and flush every accepted record immediately.
     *
     * @param array<string, mixed> $config
     */
    public function __invoke(array $config): MonologLogger
    {
        if (!class_exists(MonologLogger::class)) {
            throw new RuntimeException(
                'Laravel LogBrew logging requires monolog/monolog ^3.0; install it in the application.'
            );
        }

        $apiKey = trim(self::stringValue($config, 'api_key', ''));
        if ($apiKey === '') {
            throw new InvalidArgumentException(
                'LOGBREW_SERVER_API_KEY must be configured when the logbrew channel is enabled.'
            );
        }

        $service = self::stringValue($config, 'service', 'laravel-app');
        $release = self::stringValue($config, 'release', 'unversioned');
        $environment = self::stringValue($config, 'environment', 'production');
        $client = LogBrewClient::create(
            apiKey: $apiKey,
            sdkName: $service,
            sdkVersion: $release,
            maxRetries: self::intValue($config, 'max_retries', 0)
        );
        $transport = $this->transport ?? new HttpTransport(
            endpoint: self::stringValue($config, 'endpoint', HttpTransport::DEFAULT_ENDPOINT),
            timeout: self::floatValue($config, 'timeout', 2.0)
        );

        $metadata = self::metadataValue($config['metadata'] ?? []);
        $metadata['framework'] = 'laravel';
        $metadata['service'] = $service;
        $metadata['release'] = $release;
        $metadata['environment'] = $environment;

        $eventIdPrefix = trim(self::stringValue($config, 'event_id_prefix', ''));
        if ($eventIdPrefix === '') {
            $eventIdPrefix = 'laravel_' . bin2hex(random_bytes(16));
        }

        $handler = new LogBrewMonologHandler(
            client: $client,
            loggerName: $service,
            eventIdPrefix: $eventIdPrefix,
            metadata: $metadata,
            transport: $transport,
            flushOnLog: true,
            includeExceptionTrace: self::boolValue($config, 'include_exception_trace', false),
            level: self::levelValue($config),
            bubble: self::boolValue($config, 'bubble', true)
        );

        return new MonologLogger($service, [$handler]);
    }

    /** @param array<string, mixed> $config */
    private static function stringValue(array $config, string $key, string $default): string
    {
        $value = $config[$key] ?? $default;
        if (!is_string($value)) {
            throw new InvalidArgumentException("Laravel LogBrew {$key} must be a string.");
        }

        return $value;
    }

    /** @param array<string, mixed> $config */
    private static function intValue(array $config, string $key, int $default): int
    {
        $value = $config[$key] ?? $default;
        if (!is_int($value)) {
            throw new InvalidArgumentException("Laravel LogBrew {$key} must be an integer.");
        }

        return $value;
    }

    /** @param array<string, mixed> $config */
    private static function floatValue(array $config, string $key, float $default): float
    {
        $value = $config[$key] ?? $default;
        if (!is_float($value) && !is_int($value)) {
            throw new InvalidArgumentException("Laravel LogBrew {$key} must be a number.");
        }

        return (float) $value;
    }

    /** @param array<string, mixed> $config */
    private static function boolValue(array $config, string $key, bool $default): bool
    {
        $value = $config[$key] ?? $default;
        if (!is_bool($value)) {
            throw new InvalidArgumentException("Laravel LogBrew {$key} must be a boolean.");
        }

        return $value;
    }

    /** @param array<string, mixed> $config */
    private static function levelValue(array $config): Level
    {
        $level = strtolower(self::stringValue($config, 'level', 'warning'));

        return match ($level) {
            'debug' => Level::Debug,
            'info' => Level::Info,
            'notice' => Level::Notice,
            'warning' => Level::Warning,
            'error' => Level::Error,
            'critical' => Level::Critical,
            'alert' => Level::Alert,
            'emergency' => Level::Emergency,
            default => throw new InvalidArgumentException(
                'Laravel LogBrew level must be a standard Monolog level name.'
            ),
        };
    }

    /**
     * @return MetadataInput
     */
    private static function metadataValue(mixed $value): array
    {
        if (!is_array($value)) {
            throw new InvalidArgumentException('Laravel LogBrew metadata must be an array.');
        }

        $metadata = [];
        foreach ($value as $key => $metadataValue) {
            if (!is_string($key)) {
                throw new InvalidArgumentException('Laravel LogBrew metadata keys must be strings.');
            }
            $metadata[$key] = $metadataValue;
        }

        return $metadata;
    }
}
