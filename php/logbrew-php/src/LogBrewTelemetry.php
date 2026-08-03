<?php

declare(strict_types=1);

namespace LogBrew;

/** Request-local shared context scopes for synchronous PHP handlers. */
final class LogBrewTelemetry
{
    /** @var array<int, TelemetryContext> */
    private static array $stack = [];

    private static int $nextScopeId = 0;

    private function __construct()
    {
    }

    /** Return the active merged context, if any. */
    public static function currentContext(): ?TelemetryContext
    {
        if (self::$stack === []) {
            return null;
        }
        $context = end(self::$stack);
        return $context instanceof TelemetryContext ? $context : null;
    }

    /** Activate context until the returned idempotent scope is closed. */
    public static function activateContext(TelemetryContext $context): LogBrewTelemetryScope
    {
        $merged = TelemetryContext::merge(self::currentContext(), $context);
        if ($merged === null) {
            throw TelemetryContextValue::invalid('active telemetry context could not be created');
        }
        self::$nextScopeId++;
        self::$stack[self::$nextScopeId] = $merged;
        return new LogBrewTelemetryScope(self::$nextScopeId);
    }

    /** Run work with context active, restoring the exact prior context in finally. */
    public static function withContext(TelemetryContext $context, callable $callback): mixed
    {
        $scope = self::activateContext($context);
        try {
            return $callback($context);
        } finally {
            $scope->close();
        }
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
