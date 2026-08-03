<?php

declare(strict_types=1);

namespace LogBrew;

use ReflectionClass;
use Throwable;

/**
 * Typed, privacy-bounded issue diagnostics for explicit and framework capture.
 *
 * Throwable projection never copies the exception message, raw trace text,
 * arguments, locals, source text, or absolute source paths. Applications may
 * still attach an explicit issue message or use an adapter's documented opt-ins.
 *
 * @phpstan-import-type Metadata from LogBrewClient
 * @phpstan-import-type Severity from LogBrewClient
 * @phpstan-import-type SeverityAlias from LogBrewClient
 * @phpstan-type IssueExceptionMechanism array{type: string, handled: bool}
 * @phpstan-type IssueException array{type: string, mechanism?: IssueExceptionMechanism}
 * @phpstan-type IssueStackFrame array{
 *   filename: string,
 *   line: int,
 *   column: int,
 *   function?: string,
 *   module?: string,
 *   inApp?: bool,
 *   debugId?: string
 * }
 * @phpstan-type IssueBreadcrumbDataValue string|int|float|bool|null
 * @phpstan-type IssueBreadcrumb array{
 *   timestamp: string,
 *   category: string,
 *   type?: string,
 *   level?: 'debug'|'info'|'warning'|'error'|'critical'|'trace'|'log'|'warn'|'fatal',
 *   message?: string,
 *   data?: array<string, IssueBreadcrumbDataValue>
 * }
 * @phpstan-type IssueAttributes array{
 *   title: string,
 *   level: Severity|SeverityAlias,
 *   message?: string,
 *   exception?: IssueException,
 *   stackFrames?: list<IssueStackFrame>,
 *   breadcrumbs?: list<IssueBreadcrumb>,
 *   breadcrumbsTruncated?: bool,
 *   metadata?: Metadata,
 *   context?: TelemetryContext
 * }
 */
final class IssueDiagnostics
{
    public const MAX_STACK_FRAMES = 32;
    public const MAX_BREADCRUMBS = 64;

    private const MAX_EXCEPTION_TYPE_LENGTH = 256;
    private const MAX_MECHANISM_TYPE_LENGTH = 64;
    private const MAX_STACK_FILENAME_LENGTH = 2_048;
    private const MAX_STACK_FUNCTION_LENGTH = 256;
    private const MAX_STACK_MODULE_LENGTH = 512;
    private const MAX_BREADCRUMB_NAME_LENGTH = 64;
    private const MAX_BREADCRUMB_MESSAGE_LENGTH = 512;
    private const MAX_BREADCRUMB_DATA_FIELDS = 8;
    private const MAX_BREADCRUMB_DATA_STRING_LENGTH = 256;
    private const MAX_STACK_COORDINATE = 2_147_483_647;

    /** @var list<string> */
    private const SEVERITY_VALUES = ['trace', 'debug', 'info', 'warn', 'warning', 'error', 'fatal', 'critical'];

    /** @var array<string, 'debug'|'info'|'warning'|'error'|'critical'> */
    private const BREADCRUMB_LEVELS = [
        'trace' => 'debug',
        'debug' => 'debug',
        'info' => 'info',
        'log' => 'info',
        'warn' => 'warning',
        'warning' => 'warning',
        'error' => 'error',
        'fatal' => 'critical',
        'critical' => 'critical',
    ];

    /**
     * Build complete issue attributes from a throwable without copying sensitive content.
     *
     * Breadcrumbs must be supplied oldest first. Set breadcrumbsTruncated when
     * an earlier portion of that history was discarded by the application.
     *
     * @param Metadata|null $metadata
     * @param list<IssueBreadcrumb>|null $breadcrumbs
     * @return IssueAttributes
     */
    public static function fromThrowable(
        Throwable $error,
        ?string $title = null,
        string $level = 'error',
        ?string $message = null,
        string $mechanismType = 'php.exception',
        bool $handled = true,
        ?array $metadata = null,
        ?array $breadcrumbs = null,
        bool $breadcrumbsTruncated = false,
        bool $includeStackFrames = true,
        ?TelemetryContext $context = null
    ): array {
        $exceptionType = self::throwableType($error);
        $attributes = [
            'title' => $title ?? $exceptionType,
            'level' => $level,
            'exception' => self::exception($exceptionType, $mechanismType, $handled),
        ];
        if ($message !== null) {
            $attributes['message'] = $message;
        }
        if ($includeStackFrames) {
            $attributes['stackFrames'] = self::stackFramesFromThrowable($error);
        }
        if ($breadcrumbs !== null) {
            $attributes['breadcrumbs'] = $breadcrumbs;
        }
        if ($breadcrumbsTruncated) {
            $attributes['breadcrumbsTruncated'] = true;
        }
        if ($metadata !== null) {
            $attributes['metadata'] = $metadata;
        }

        $validated = self::validateIssueAttributes($attributes);
        if ($context !== null) {
            $validated['context'] = $context;
        }
        return $validated;
    }

    /** @return IssueException */
    public static function exception(string $type, string $mechanismType, bool $handled): array
    {
        return self::validateException([
            'type' => $type,
            'mechanism' => ['type' => $mechanismType, 'handled' => $handled],
        ]);
    }

    /**
     * Build and validate one explicit structured stack frame.
     *
     * Absolute filenames are reduced to their basename, and URL query or
     * fragment text is removed before the frame enters an event.
     *
     * @return IssueStackFrame
     */
    public static function stackFrame(
        string $filename,
        int $line,
        int $column = 1,
        ?string $function = null,
        ?string $module = null,
        ?bool $inApp = null,
        ?string $debugId = null
    ): array {
        $frame = [
            'filename' => $filename,
            'line' => $line,
            'column' => $column,
        ];
        if ($function !== null) {
            $frame['function'] = $function;
        }
        if ($module !== null) {
            $frame['module'] = $module;
        }
        if ($inApp !== null) {
            $frame['inApp'] = $inApp;
        }
        if ($debugId !== null) {
            $frame['debugId'] = $debugId;
        }

        return self::validateStackFrame($frame);
    }

    /**
     * Project a throwable into newest-first code identity without copying arguments or source.
     *
     * @return non-empty-list<IssueStackFrame>
     */
    public static function stackFramesFromThrowable(Throwable $error): array
    {
        $frames = [];
        $currentFile = $error->getFile();
        $currentLine = $error->getLine();

        foreach ($error->getTrace() as $sourceFrame) {
            if (count($frames) >= self::MAX_STACK_FRAMES) {
                break;
            }
            $frames[] = self::generatedStackFrame($currentFile, $currentLine, $sourceFrame);
            $currentFile = is_string($sourceFrame['file'] ?? null) ? $sourceFrame['file'] : 'internal.php';
            $currentLine = is_int($sourceFrame['line'] ?? null) ? $sourceFrame['line'] : 1;
        }

        if (count($frames) < self::MAX_STACK_FRAMES) {
            $frames[] = self::generatedStackFrame($currentFile, $currentLine, []);
        }

        return $frames;
    }

    /**
     * Build one oldest-to-newest breadcrumb with bounded primitive data.
     *
     * @param array<string, IssueBreadcrumbDataValue>|null $data
     * @return IssueBreadcrumb
     */
    public static function breadcrumb(
        string $timestamp,
        string $category,
        ?string $type = null,
        ?string $level = null,
        ?string $message = null,
        ?array $data = null
    ): array {
        $breadcrumb = [
            'timestamp' => $timestamp,
            'category' => $category,
        ];
        if ($type !== null) {
            $breadcrumb['type'] = $type;
        }
        if ($level !== null) {
            $breadcrumb['level'] = $level;
        }
        if ($message !== null) {
            $breadcrumb['message'] = $message;
        }
        if ($data !== null) {
            $breadcrumb['data'] = $data;
        }

        return self::validateBreadcrumb($breadcrumb);
    }

    /**
     * Validate and detach a complete issue attribute payload.
     *
     * @param array<string, mixed> $attributes
     * @return IssueAttributes
     */
    public static function validateIssueAttributes(array $attributes): array
    {
        $title = self::requireStringAttribute($attributes, 'title', 'issue title');
        $level = self::normalizeSeverity(
            self::requireStringAttribute($attributes, 'level', 'issue level')
        );
        $message = self::optionalStringAttribute($attributes, 'message', 'issue message');
        $validated = [
            'title' => $title,
            'level' => $level,
        ];
        if ($message !== null) {
            $validated['message'] = $message;
        }

        if (array_key_exists('exception', $attributes)) {
            $validated['exception'] = self::validateException($attributes['exception']);
        }
        if (array_key_exists('stackFrames', $attributes)) {
            $validated['stackFrames'] = self::validateStackFrames($attributes['stackFrames']);
        }
        if (array_key_exists('breadcrumbs', $attributes)) {
            $validated['breadcrumbs'] = self::validateBreadcrumbs($attributes['breadcrumbs']);
        }
        if (array_key_exists('breadcrumbsTruncated', $attributes)) {
            if (!is_bool($attributes['breadcrumbsTruncated'])) {
                throw self::validation('issue breadcrumbsTruncated must be a boolean');
            }
            if ($attributes['breadcrumbsTruncated']) {
                $validated['breadcrumbsTruncated'] = true;
            }
        }

        if (array_key_exists('metadata', $attributes) && $attributes['metadata'] !== null) {
            $validated['metadata'] = self::validateMetadata($attributes['metadata']);
        }

        return $validated;
    }

    private static function throwableType(Throwable $error): string
    {
        $reflection = new ReflectionClass($error);
        if ($reflection->isAnonymous()) {
            return 'anonymous_exception';
        }

        return self::validBoundedText($error::class, self::MAX_EXCEPTION_TYPE_LENGTH, true)
            ? $error::class
            : 'Throwable';
    }

    /**
     * @param array<string, mixed> $sourceFrame
     * @return IssueStackFrame
     */
    private static function generatedStackFrame(string $filename, int $line, array $sourceFrame): array
    {
        $frame = [
            'filename' => self::sanitizeFrameFilename($filename, true),
            'line' => self::generatedCoordinate($line),
            'column' => 1,
        ];
        $function = self::safeGeneratedPhpSymbol($sourceFrame['function'] ?? null, true);
        if ($function !== null) {
            $frame['function'] = $function;
        }
        $module = self::safeGeneratedPhpSymbol($sourceFrame['class'] ?? null, false);
        if ($module !== null) {
            $frame['module'] = $module;
        }

        return self::validateStackFrame($frame);
    }

    private static function safeGeneratedPhpSymbol(mixed $value, bool $allowClosure): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        $value = trim($value);
        $maximum = $allowClosure ? self::MAX_STACK_FUNCTION_LENGTH : self::MAX_STACK_MODULE_LENGTH;
        if (!self::validBoundedText($value, $maximum) || str_contains($value, '/')) {
            return null;
        }
        if ($allowClosure && $value === '{closure}') {
            return $value;
        }

        return preg_match('/^[A-Za-z_][A-Za-z0-9_]*(?:\\\\[A-Za-z_][A-Za-z0-9_]*)*$/D', $value) === 1
            ? $value
            : null;
    }

    private static function generatedCoordinate(int $value): int
    {
        return $value >= 1 && $value <= self::MAX_STACK_COORDINATE ? $value : 1;
    }

    /** @return IssueException */
    private static function validateException(mixed $value): array
    {
        $exception = self::requireObject('issue exception', $value);
        self::rejectUnknownKeys('issue exception', $exception, ['type', 'mechanism']);
        $validated = [
            'type' => self::boundedText(
                'issue exception type',
                $exception['type'] ?? null,
                self::MAX_EXCEPTION_TYPE_LENGTH,
                true
            ),
        ];
        if (array_key_exists('mechanism', $exception)) {
            $validated['mechanism'] = self::validateMechanism($exception['mechanism']);
        }

        return $validated;
    }

    /** @return IssueExceptionMechanism */
    private static function validateMechanism(mixed $value): array
    {
        $mechanism = self::requireObject('issue exception mechanism', $value);
        self::rejectUnknownKeys('issue exception mechanism', $mechanism, ['type', 'handled']);
        $type = self::machineName(
            'issue exception mechanism type',
            $mechanism['type'] ?? null,
            self::MAX_MECHANISM_TYPE_LENGTH
        );
        $handled = $mechanism['handled'] ?? null;
        if (!is_bool($handled)) {
            throw self::validation('issue exception mechanism handled must be a boolean');
        }

        return ['type' => $type, 'handled' => $handled];
    }

    /** @return list<IssueStackFrame> */
    private static function validateStackFrames(mixed $value): array
    {
        if (!is_array($value) || !array_is_list($value) || count($value) < 1 || count($value) > self::MAX_STACK_FRAMES) {
            throw self::validation('issue stackFrames must contain 1-32 frames');
        }

        return array_map(self::validateStackFrame(...), $value);
    }

    /** @return IssueStackFrame */
    private static function validateStackFrame(mixed $value): array
    {
        $frame = self::requireObject('issue stack frame', $value);
        self::rejectUnknownKeys(
            'issue stack frame',
            $frame,
            ['filename', 'line', 'column', 'function', 'module', 'inApp', 'debugId']
        );
        $validated = [
            'filename' => self::sanitizeFrameFilename($frame['filename'] ?? null),
            'line' => self::positiveCoordinate('line', $frame['line'] ?? null),
            'column' => self::positiveCoordinate('column', $frame['column'] ?? null),
        ];
        if (array_key_exists('function', $frame)) {
            $validated['function'] = self::boundedText(
                'issue stack frame function',
                $frame['function'],
                self::MAX_STACK_FUNCTION_LENGTH
            );
        }
        if (array_key_exists('module', $frame)) {
            $validated['module'] = self::boundedText(
                'issue stack frame module',
                $frame['module'],
                self::MAX_STACK_MODULE_LENGTH,
                true
            );
        }
        if (array_key_exists('inApp', $frame)) {
            if (!is_bool($frame['inApp'])) {
                throw self::validation('issue stack frame inApp must be a boolean');
            }
            $validated['inApp'] = $frame['inApp'];
        }
        if (array_key_exists('debugId', $frame)) {
            $debugId = $frame['debugId'];
            if (!is_string($debugId)) {
                throw self::validation('issue stack frame debugId is invalid');
            }
            $debugId = strtolower(trim($debugId));
            if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D', $debugId) !== 1) {
                throw self::validation('issue stack frame debugId is invalid');
            }
            $validated['debugId'] = $debugId;
        }

        return $validated;
    }

    /** @return list<IssueBreadcrumb> */
    private static function validateBreadcrumbs(mixed $value): array
    {
        if (!is_array($value) || !array_is_list($value) || count($value) < 1 || count($value) > self::MAX_BREADCRUMBS) {
            throw self::validation('issue breadcrumbs must contain 1-64 entries');
        }

        return array_map(self::validateBreadcrumb(...), $value);
    }

    /** @return IssueBreadcrumb */
    private static function validateBreadcrumb(mixed $value): array
    {
        $breadcrumb = self::requireObject('issue breadcrumb', $value);
        self::rejectUnknownKeys(
            'issue breadcrumb',
            $breadcrumb,
            ['timestamp', 'type', 'category', 'level', 'message', 'data']
        );
        $validated = [
            'timestamp' => self::breadcrumbTimestamp($breadcrumb['timestamp'] ?? null),
            'category' => self::machineName(
                'issue breadcrumb category',
                $breadcrumb['category'] ?? null,
                self::MAX_BREADCRUMB_NAME_LENGTH
            ),
        ];
        if (array_key_exists('type', $breadcrumb)) {
            $validated['type'] = self::machineName(
                'issue breadcrumb type',
                $breadcrumb['type'],
                self::MAX_BREADCRUMB_NAME_LENGTH
            );
        }
        if (array_key_exists('level', $breadcrumb)) {
            $level = $breadcrumb['level'];
            if (!is_string($level) || !array_key_exists($level, self::BREADCRUMB_LEVELS)) {
                throw self::validation(
                    'issue breadcrumb level must be one of: ' . implode(', ', array_keys(self::BREADCRUMB_LEVELS))
                );
            }
            $validated['level'] = self::BREADCRUMB_LEVELS[$level];
        }
        if (array_key_exists('message', $breadcrumb)) {
            $validated['message'] = self::boundedText(
                'issue breadcrumb message',
                $breadcrumb['message'],
                self::MAX_BREADCRUMB_MESSAGE_LENGTH
            );
        }
        if (array_key_exists('data', $breadcrumb)) {
            $data = self::validateBreadcrumbData($breadcrumb['data']);
            if ($data !== []) {
                $validated['data'] = $data;
            }
        }

        return $validated;
    }

    /** @return array<string, string|int|float|bool|null> */
    private static function validateBreadcrumbData(mixed $value): array
    {
        if (!is_array($value)) {
            throw self::validation('issue breadcrumb data must be an object');
        }
        $copied = [];
        foreach ($value as $key => $item) {
            if (!is_string($key)) {
                throw self::validation('issue breadcrumb data keys must be stable machine names');
            }
            $copied[$key] = $item;
        }
        if (count($copied) > self::MAX_BREADCRUMB_DATA_FIELDS) {
            throw self::validation('issue breadcrumb data must contain at most 8 fields');
        }

        $validated = [];
        foreach ($copied as $key => $item) {
            self::machineName('issue breadcrumb data key', $key, self::MAX_BREADCRUMB_NAME_LENGTH, false);
            if (is_string($item)) {
                $validated[$key] = self::boundedText(
                    sprintf('issue breadcrumb data value for %s', $key),
                    $item,
                    self::MAX_BREADCRUMB_DATA_STRING_LENGTH
                );
                continue;
            }
            if ($item === null || is_bool($item) || is_int($item) || (is_float($item) && is_finite($item))) {
                $validated[$key] = $item;
                continue;
            }
            throw self::validation(
                sprintf('issue breadcrumb data value for %s must be a finite primitive', $key)
            );
        }

        return $validated;
    }

    /** @return array<string, string|int|float|bool|null> */
    private static function validateMetadata(mixed $value): array
    {
        if (!is_array($value)) {
            throw self::validation('metadata must be an object');
        }
        $validated = [];
        foreach ($value as $key => $item) {
            if (!is_string($key) || !LogBrewClient::isMetadataValue($item)) {
                throw self::validation('metadata must contain primitive values with string keys');
            }
            $validated[$key] = $item;
        }

        return $validated;
    }

    /** @param array<string, mixed> $attributes */
    private static function requireStringAttribute(array $attributes, string $field, string $label): string
    {
        $value = $attributes[$field] ?? null;
        if (!is_string($value)) {
            throw self::validation(sprintf('%s must be a string', $label));
        }
        if (trim($value) === '') {
            throw self::validation(sprintf('%s must be non-empty', $label));
        }

        return $value;
    }

    /** @param array<string, mixed> $attributes */
    private static function optionalStringAttribute(array $attributes, string $field, string $label): ?string
    {
        if (!array_key_exists($field, $attributes) || $attributes[$field] === null) {
            return null;
        }
        if (!is_string($attributes[$field])) {
            throw self::validation(sprintf('%s must be a string', $label));
        }

        return $attributes[$field];
    }

    /** @return 'info'|'warning'|'error'|'critical' */
    private static function normalizeSeverity(string $value): string
    {
        if (!in_array($value, self::SEVERITY_VALUES, true)) {
            throw self::validation('issue level must be one of: ' . implode(', ', self::SEVERITY_VALUES));
        }

        return match ($value) {
            'trace', 'debug', 'info' => 'info',
            'warn', 'warning' => 'warning',
            'error' => 'error',
            'fatal', 'critical' => 'critical',
        };
    }

    private static function positiveCoordinate(string $label, mixed $value): int
    {
        if (!is_int($value) || $value < 1 || $value > self::MAX_STACK_COORDINATE) {
            throw self::validation(sprintf('issue stack frame %s must be a positive integer', $label));
        }

        return $value;
    }

    private static function sanitizeFrameFilename(mixed $value, bool $alwaysBasename = false): string
    {
        if (!is_string($value)) {
            throw self::validation('issue stack frame filename is invalid');
        }
        $filename = trim($value);
        if (str_starts_with(strtolower($filename), 'file://')) {
            $filename = substr($filename, 7);
            $alwaysBasename = true;
        }
        $end = strlen($filename);
        foreach (['?', '#'] as $separator) {
            $position = strpos($filename, $separator);
            if ($position !== false) {
                $end = min($end, $position);
            }
        }
        $filename = trim(substr($filename, 0, $end));
        $normalized = str_replace('\\', '/', $filename);
        $isAbsolute = str_starts_with($normalized, '/')
            || preg_match('/^[A-Za-z]:\//D', $normalized) === 1;
        if ($alwaysBasename || $isAbsolute) {
            $separator = strrpos($normalized, '/');
            $normalized = $separator === false ? $normalized : substr($normalized, $separator + 1);
        }

        return self::boundedText(
            'issue stack frame filename',
            $normalized,
            self::MAX_STACK_FILENAME_LENGTH,
            true
        );
    }

    private static function breadcrumbTimestamp(mixed $value): string
    {
        if (!is_string($value)) {
            throw self::validation('issue breadcrumb timestamp must be RFC 3339 with an explicit timezone');
        }
        $matches = [];
        if (
            preg_match(
                '/^(?<year>[0-9]{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12][0-9]|3[01])'
                . 'T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?'
                . '(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/D',
                $value,
                $matches
            ) !== 1
        ) {
            throw self::validation('issue breadcrumb timestamp must be RFC 3339 with an explicit timezone');
        }
        if (!checkdate((int) $matches['month'], (int) $matches['day'], (int) $matches['year'])) {
            throw self::validation('issue breadcrumb timestamp must be a valid RFC 3339 date-time');
        }

        return $value;
    }

    private static function machineName(
        string $label,
        mixed $value,
        int $maximum,
        bool $allowColon = true
    ): string {
        $pattern = $allowColon
            ? '/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/D'
            : '/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/D';
        if (!is_string($value) || strlen($value) > $maximum || preg_match($pattern, $value) !== 1) {
            throw self::validation(sprintf('%s must be a stable machine name', $label));
        }

        return $value;
    }

    private static function boundedText(
        string $label,
        mixed $value,
        int $maximum,
        bool $rejectLocationText = false
    ): string {
        if (!is_string($value) || !self::validBoundedText($value, $maximum, $rejectLocationText)) {
            throw self::validation(sprintf('%s is invalid or exceeds %d characters', $label, $maximum));
        }

        return $value;
    }

    private static function validBoundedText(string $value, int $maximum, bool $rejectLocationText = false): bool
    {
        return trim($value) !== ''
            && strlen($value) <= $maximum
            && preg_match('//u', $value) === 1
            && preg_match('/[\x{0000}-\x{001F}\x{007F}-\x{009F}]/u', $value) !== 1
            && (!$rejectLocationText || (!str_contains($value, '?') && !str_contains($value, '#')));
    }

    /** @return array<string, mixed> */
    private static function requireObject(string $label, mixed $value): array
    {
        if (!is_array($value) || array_is_list($value)) {
            throw self::validation(sprintf('%s must be an object', $label));
        }
        $copied = [];
        foreach ($value as $key => $item) {
            if (!is_string($key)) {
                throw self::validation(sprintf('%s keys must be strings', $label));
            }
            $copied[$key] = $item;
        }

        return $copied;
    }

    /**
     * @param array<string, mixed> $value
     * @param list<string> $allowed
     */
    private static function rejectUnknownKeys(string $label, array $value, array $allowed): void
    {
        $unknown = array_values(array_diff(array_keys($value), $allowed));
        if ($unknown === []) {
            return;
        }
        sort($unknown, SORT_STRING);
        throw self::validation(sprintf('%s has unsupported fields: %s', $label, implode(', ', $unknown)));
    }

    private static function validation(string $message): SdkError
    {
        return new SdkError('validation_error', $message);
    }
}
