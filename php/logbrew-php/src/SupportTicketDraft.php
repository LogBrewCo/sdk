<?php

declare(strict_types=1);

namespace LogBrew;

use Throwable;

/**
 * Local-only support-ticket draft helper for explicit user or agent handoff.
 *
 * This validates the planned public support-ticket create payload and redacts
 * diagnostics. It does not open a ticket, call backend routes, or send telemetry.
 *
 * @phpstan-type SupportDiagnosticsValue string|int|float|bool|null|array<string|int, mixed>
 * @phpstan-type SupportTicketPayload array<string, mixed>
 */
final class SupportTicketDraft
{
    /** @var list<string> */
    private const SOURCES = ['cli', 'sdk', 'website', 'docs', 'mobile'];

    /** @var list<string> */
    private const CATEGORIES = [
        'sdk_install_failure',
        'ingest_failure',
        'auth_failure',
        'project_setup',
        'dashboard_issue',
        'docs_confusion',
        'cli_issue',
        'mobile_issue',
        'billing_question',
        'other',
    ];

    /** @var list<string> */
    private const SENSITIVE_KEY_MARKERS = [
        'apikey',
        'auth',
        'authorization',
        'authtoken',
        'bearer',
        'clientsecret',
        'connectionstring',
        'cookie',
        'credential',
        'credentials',
        'dsn',
        'email',
        'errormessage',
        'exceptionmessage',
        'password',
        'passwd',
        'privatekey',
        'refreshtoken',
        'secret',
        'session',
        'setcookie',
        'stacktrace',
        'token',
        'traceback',
    ];

    private const REDACTED = '[redacted]';
    private const MAX_DEPTH = 5;
    private const MAX_ARRAY_LENGTH = 20;
    private const MAX_STRING_LENGTH = 500;

    /**
     * Build a planned support-ticket create payload locally without calling backend routes.
     *
     * @param array<string|int, mixed>|null $diagnostics
     * @return SupportTicketPayload
     */
    public static function create(
        string $source,
        string $category,
        string $title,
        string $description,
        ?string $projectId = null,
        ?string $environment = null,
        ?string $runtime = null,
        ?string $framework = null,
        ?string $sdkPackage = null,
        ?string $sdkVersion = null,
        ?string $release = null,
        ?string $traceId = null,
        ?string $eventId = null,
        mixed $diagnostics = null
    ): array {
        self::requireAllowedValue('support ticket source', $source, self::SOURCES);
        self::requireAllowedValue('support ticket category', $category, self::CATEGORIES);

        $draft = [
            'source' => $source,
            'category' => $category,
            'title' => self::requiredString('support ticket title', $title),
            'description' => self::requiredString('support ticket description', $description),
        ];

        self::addOptionalString($draft, 'project_id', 'support ticket project_id', $projectId);
        self::addOptionalString($draft, 'environment', 'support ticket environment', $environment);
        self::addOptionalString($draft, 'runtime', 'support ticket runtime', $runtime);
        self::addOptionalString($draft, 'framework', 'support ticket framework', $framework);
        self::addOptionalString($draft, 'sdk_package', 'support ticket sdk_package', $sdkPackage);
        self::addOptionalString($draft, 'sdk_version', 'support ticket sdk_version', $sdkVersion);
        self::addOptionalString($draft, 'release', 'support ticket release', $release);
        if ($traceId !== null) {
            $draft['trace_id'] = self::normalizeTraceId($traceId);
        }
        self::addOptionalString($draft, 'event_id', 'support ticket event_id', $eventId);

        if ($diagnostics !== null) {
            if (!is_array($diagnostics)) {
                throw new SdkError('validation_error', 'support ticket diagnostics must be an object');
            }
            $sanitized = self::sanitizeDiagnostics($diagnostics);
            if ($sanitized !== []) {
                $draft['diagnostics'] = $sanitized;
            }
        }

        return $draft;
    }

    /** @param list<string> $allowedValues */
    private static function requireAllowedValue(string $label, string $value, array $allowedValues): void
    {
        LogBrewClient::requireNonEmpty($label, $value);
        if (!in_array($value, $allowedValues, true)) {
            throw new SdkError('validation_error', sprintf('%s must be one of: %s', $label, implode(', ', $allowedValues)));
        }
    }

    private static function requiredString(string $label, string $value): string
    {
        LogBrewClient::requireNonEmpty($label, $value);
        return trim($value);
    }

    /** @param array<string, mixed> $target */
    private static function addOptionalString(array &$target, string $key, string $label, ?string $value): void
    {
        if ($value === null) {
            return;
        }
        $target[$key] = self::requiredString($label, $value);
    }

    private static function normalizeTraceId(string $traceId): string
    {
        $normalized = strtolower(trim($traceId));
        if (strlen($normalized) !== 32 || preg_match('/^[0-9a-f]{32}$/', $normalized) !== 1 || strspn($normalized, '0') === 32) {
            throw new SdkError('validation_error', 'support ticket trace_id must be 32 non-zero hex characters');
        }

        return $normalized;
    }

    /**
     * @param array<string|int, mixed> $diagnostics
     * @return array<string, mixed>
     */
    private static function sanitizeDiagnostics(array $diagnostics): array
    {
        return self::sanitizeDiagnosticMap($diagnostics, 0);
    }

    /**
     * @return array{0: bool, 1: mixed}
     */
    private static function sanitizeDiagnosticValue(mixed $value, int $depth): array
    {
        if ($depth > self::MAX_DEPTH) {
            return [false, null];
        }

        if ($value instanceof Throwable) {
            return [true, ['type' => self::shortTypeName($value)]];
        }

        if ($value === null || is_bool($value) || is_int($value)) {
            return [true, $value];
        }

        if (is_float($value)) {
            return is_finite($value) ? [true, $value] : [false, null];
        }

        if (is_string($value)) {
            return [true, self::sanitizeString($value)];
        }

        if (is_array($value)) {
            return array_is_list($value)
                ? [true, self::sanitizeList($value, $depth + 1)]
                : [true, self::sanitizeDiagnosticMap($value, $depth + 1)];
        }

        return [false, null];
    }

    /**
     * @param list<mixed> $values
     * @return list<mixed>
     */
    private static function sanitizeList(array $values, int $depth): array
    {
        $safe = [];
        foreach (array_slice($values, 0, self::MAX_ARRAY_LENGTH) as $value) {
            [$include, $sanitized] = self::sanitizeDiagnosticValue($value, $depth);
            if ($include) {
                $safe[] = $sanitized;
            }
        }

        return $safe;
    }

    /**
     * @param array<string|int, mixed> $values
     * @return array<string, mixed>
     */
    private static function sanitizeDiagnosticMap(array $values, int $depth): array
    {
        if ($depth > self::MAX_DEPTH) {
            return [];
        }

        $safe = [];
        $count = 0;
        foreach ($values as $key => $value) {
            if ($count >= self::MAX_ARRAY_LENGTH) {
                break;
            }
            $stringKey = (string) $key;
            if (trim($stringKey) === '') {
                continue;
            }
            if (self::isSensitiveKey($stringKey)) {
                $safe[$stringKey] = self::REDACTED;
                $count++;
                continue;
            }
            [$include, $sanitized] = self::sanitizeDiagnosticValue($value, $depth);
            if ($include) {
                $safe[$stringKey] = $sanitized;
                $count++;
            }
        }

        return $safe;
    }

    private static function sanitizeString(string $value): string
    {
        $text = trim($value);
        if ($text === '') {
            return '';
        }
        if (self::isHttpUrl($text)) {
            return self::truncateString(self::redactUrl($text));
        }

        $redacted = self::redactLocalPath(self::redactEmbeddedUrls($text));
        if (self::isSensitiveString($redacted)) {
            return self::REDACTED;
        }

        return self::truncateString($redacted);
    }

    private static function isSensitiveKey(string $key): bool
    {
        $normalized = strtolower((string) preg_replace('/[^a-z0-9]/i', '', $key));
        foreach (self::SENSITIVE_KEY_MARKERS as $marker) {
            if (str_contains($normalized, $marker)) {
                return true;
            }
        }

        return false;
    }

    private static function isSensitiveString(string $value): bool
    {
        return preg_match('/(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\s*[:=]/i', $value) === 1
            || preg_match('/\bBearer\s+[A-Za-z0-9._~+\/=-]+/i', $value) === 1
            || preg_match('/\blbw_(?:ingest|client|api)_[A-Za-z0-9._-]+/i', $value) === 1
            || preg_match('/\b(?:github_pat|ghp|gho|npm|pypi|sk_live|sk_test|xox[baprs]|AKIA)[A-Za-z0-9._-]+/', $value) === 1;
    }

    private static function redactLocalPath(string $value): string
    {
        return (string) preg_replace(
            '/(?:\/Users\/|\/home\/|\/var\/folders\/|\/private\/var\/|\/tmp\/|[A-Za-z]:\\\\)[^\s\'"<>]*/',
            '[redacted-path]',
            $value
        );
    }

    private static function redactEmbeddedUrls(string $value): string
    {
        return (string) preg_replace_callback(
            '/https?:\/\/[^\s\'"<>]+/i',
            fn (array $matches): string => self::redactUrl($matches[0]),
            $value
        );
    }

    private static function redactUrl(string $value): string
    {
        $parts = parse_url($value);
        if (is_array($parts) && isset($parts['scheme'], $parts['host']) && in_array(strtolower((string) $parts['scheme']), ['http', 'https'], true)) {
            $path = isset($parts['path']) && $parts['path'] !== '' ? $parts['path'] : '/';
            return '[redacted-url]' . $path;
        }

        return preg_split('/[?#]/', $value, 2)[0] ?? $value;
    }

    private static function isHttpUrl(string $value): bool
    {
        $parts = parse_url($value);
        return is_array($parts)
            && isset($parts['scheme'], $parts['host'])
            && in_array(strtolower((string) $parts['scheme']), ['http', 'https'], true);
    }

    private static function truncateString(string $value): string
    {
        if (strlen($value) > self::MAX_STRING_LENGTH) {
            return substr($value, 0, self::MAX_STRING_LENGTH) . '...';
        }

        return $value;
    }

    private static function shortTypeName(Throwable $value): string
    {
        $className = get_class($value);
        $position = strrpos($className, '\\');
        return $position === false ? $className : substr($className, $position + 1);
    }
}
