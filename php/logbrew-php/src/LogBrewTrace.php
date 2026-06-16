<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Lightweight request-local trace scope for synchronous PHP handlers.
 *
 * @phpstan-import-type Metadata from LogBrewClient
 */
final class LogBrewTrace
{
    /** @var array<int, LogBrewTraceContext> */
    private static array $stack = [];

    private static int $nextScopeId = 0;

    private function __construct()
    {
    }

    public static function current(): ?LogBrewTraceContext
    {
        if (self::$stack === []) {
            return null;
        }

        $context = end(self::$stack);
        return $context instanceof LogBrewTraceContext ? $context : null;
    }

    public static function activate(LogBrewTraceContext $context): LogBrewTraceScope
    {
        self::$nextScopeId++;
        self::$stack[self::$nextScopeId] = $context;
        return new LogBrewTraceScope(self::$nextScopeId);
    }

    /**
     * Run callback work while a LogBrew trace is active, restoring the previous trace in finally.
     */
    public static function withTrace(LogBrewTraceContext $context, callable $callback): mixed
    {
        $scope = self::activate($context);
        try {
            return $callback($context);
        } finally {
            $scope->close();
        }
    }

    /**
     * Merge primitive metadata with the currently active trace, when any.
     *
     * @param array<string, mixed> $metadata
     * @return Metadata
     */
    public static function metadataWithCurrentTrace(array $metadata = []): array
    {
        return self::metadataWithTrace(self::current(), $metadata);
    }

    /**
     * Merge primitive metadata with an explicit trace context.
     *
     * @param array<string, mixed> $metadata
     * @return Metadata
     */
    public static function metadataWithTrace(?LogBrewTraceContext $context, array $metadata = []): array
    {
        $copied = LogBrewClient::copyPrimitiveMetadata($metadata);
        if ($context !== null) {
            foreach ($context->metadata() as $key => $value) {
                $copied[$key] = $value;
            }
        }

        return $copied;
    }

    /** @internal */
    public static function removeScope(int $scopeId): bool
    {
        if (!array_key_exists($scopeId, self::$stack)) {
            return false;
        }

        unset(self::$stack[$scopeId]);
        return true;
    }
}
