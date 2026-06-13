<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * App-owned product and network timeline helpers.
 *
 * @phpstan-import-type ActionAttributes from LogBrewClient
 * @phpstan-import-type Metadata from LogBrewClient
 */
final class ProductTimeline
{
    /** @var list<string> */
    private const ACTION_STATUSES = ['queued', 'running', 'success', 'failure'];

    private function __construct()
    {
    }

    /**
     * Create an action attribute payload for a product step already known by the application.
     *
     * @param array<string, mixed> $metadata
     * @return ActionAttributes
     */
    public static function productAction(
        string $name,
        string $status = 'success',
        ?string $routeTemplate = null,
        ?string $sessionId = null,
        ?string $traceId = null,
        ?string $screen = null,
        ?string $funnel = null,
        ?string $step = null,
        array $metadata = []
    ): array {
        $normalizedStatus = self::normalizeStatus($status);
        $actionMetadata = self::createMetadata('product_timeline', $metadata);
        self::putIfNotNull($actionMetadata, 'routeTemplate', self::sanitizeOptionalRouteTemplate('product routeTemplate', $routeTemplate));
        self::putIfNotNull($actionMetadata, 'sessionId', self::label('sessionId', $sessionId));
        self::putIfNotNull($actionMetadata, 'traceId', self::label('traceId', $traceId));
        self::putIfNotNull($actionMetadata, 'screen', self::label('screen', $screen));
        self::putIfNotNull($actionMetadata, 'funnel', self::label('funnel', $funnel));
        self::putIfNotNull($actionMetadata, 'step', self::label('step', $step));

        return [
            'name' => self::requiredLabel('product action name', $name),
            'status' => $normalizedStatus,
            'metadata' => $actionMetadata,
        ];
    }

    /**
     * Create an action attribute payload for an app-owned API or network milestone.
     *
     * @param array<string, mixed> $metadata
     * @return ActionAttributes
     */
    public static function networkMilestone(
        string $routeTemplate,
        string $method = 'GET',
        ?int $statusCode = null,
        int|float|null $durationMs = null,
        ?string $status = null,
        ?string $name = null,
        ?string $sessionId = null,
        ?string $traceId = null,
        array $metadata = []
    ): array {
        $route = self::sanitizeRouteTemplate('network milestone routeTemplate', $routeTemplate);
        $normalizedMethod = self::normalizeMethod($method);
        self::validateStatusCode($statusCode);
        self::validateDurationMs($durationMs);
        $normalizedStatus = self::normalizeStatus($status ?? ($statusCode !== null && $statusCode >= 400 ? 'failure' : 'success'));

        $actionMetadata = self::createMetadata('network_timeline', $metadata);
        $actionMetadata['routeTemplate'] = $route;
        $actionMetadata['method'] = $normalizedMethod;
        self::putIfNotNull($actionMetadata, 'statusCode', $statusCode);
        self::putIfNotNull($actionMetadata, 'durationMs', $durationMs);
        self::putIfNotNull($actionMetadata, 'sessionId', self::label('sessionId', $sessionId));
        self::putIfNotNull($actionMetadata, 'traceId', self::label('traceId', $traceId));

        return [
            'name' => $name === null ? sprintf('network.%s %s', strtolower($normalizedMethod), $route) : self::requiredLabel('network milestone name', $name),
            'status' => $normalizedStatus,
            'metadata' => $actionMetadata,
        ];
    }

    private static function label(string $label, ?string $value): ?string
    {
        if ($value === null) {
            return null;
        }

        return self::requiredLabel($label, $value);
    }

    private static function requiredLabel(string $label, string $value): string
    {
        LogBrewClient::requireNonEmpty($label, $value);
        return trim($value);
    }

    /** @return 'queued'|'running'|'success'|'failure' */
    private static function normalizeStatus(string $status): string
    {
        LogBrewClient::requireNonEmpty('action status', $status);
        return match ($status) {
            'queued', 'running', 'success', 'failure' => $status,
            default => throw new SdkError('validation_error', 'action status must be one of: ' . implode(', ', self::ACTION_STATUSES)),
        };
    }

    private static function sanitizeOptionalRouteTemplate(string $label, ?string $routeTemplate): ?string
    {
        if ($routeTemplate === null) {
            return null;
        }

        return self::sanitizeRouteTemplate($label, $routeTemplate);
    }

    private static function sanitizeRouteTemplate(string $label, string $routeTemplate): string
    {
        LogBrewClient::requireNonEmpty($label, $routeTemplate);
        $trimmed = trim($routeTemplate);
        $parts = parse_url($trimmed);
        if (is_array($parts) && isset($parts['scheme'], $parts['host'])) {
            $path = (string) ($parts['path'] ?? '/');
            return $path === '' ? '/' : $path;
        }

        $cutoff = self::firstPresentIndex(strpos($trimmed, '?'), strpos($trimmed, '#'));
        if ($cutoff !== null) {
            $trimmed = rtrim(substr($trimmed, 0, $cutoff));
        }

        return $trimmed === '' ? '/' : $trimmed;
    }

    private static function normalizeMethod(string $method): string
    {
        $normalized = strtoupper(trim($method));
        if ($normalized === '' || preg_match('/^[A-Z0-9_-]+$/', $normalized) !== 1) {
            throw new SdkError('validation_error', 'network milestone method must be a valid HTTP method');
        }

        return $normalized;
    }

    private static function validateStatusCode(?int $statusCode): void
    {
        if ($statusCode !== null && ($statusCode < 100 || $statusCode > 599)) {
            throw new SdkError('validation_error', 'network milestone statusCode must be between 100 and 599');
        }
    }

    private static function validateDurationMs(int|float|null $durationMs): void
    {
        if ($durationMs === null) {
            return;
        }
        if (is_float($durationMs) && !is_finite($durationMs)) {
            throw new SdkError('validation_error', 'network milestone durationMs must be a finite number');
        }
        if ($durationMs < 0) {
            throw new SdkError('validation_error', 'network milestone durationMs must be non-negative');
        }
    }

    /**
     * @param array<string, mixed> $metadata
     * @return Metadata
     */
    private static function createMetadata(string $source, array $metadata): array
    {
        $copied = ['source' => $source];
        foreach ($metadata as $key => $value) {
            $stringKey = (string) $key;
            LogBrewClient::requireNonEmpty('metadata key', $stringKey);
            $metadataValue = self::metadataValue($stringKey, $value);
            if ($stringKey !== 'source') {
                $copied[$stringKey] = $metadataValue;
            }
        }

        return $copied;
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

    /**
     * @param Metadata $metadata
     */
    private static function putIfNotNull(array &$metadata, string $key, string|int|float|bool|null $value): void
    {
        if ($value !== null) {
            $metadata[$key] = $value;
        }
    }

    private static function firstPresentIndex(int|false $first, int|false $second): ?int
    {
        if ($first === false) {
            return $second === false ? null : $second;
        }
        if ($second === false) {
            return $first;
        }

        return min($first, $second);
    }
}
