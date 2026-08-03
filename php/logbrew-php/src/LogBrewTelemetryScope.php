<?php

declare(strict_types=1);

namespace LogBrew;

/** Idempotent owner for one active shared-context scope. */
final class LogBrewTelemetryScope
{
    private bool $closed = false;

    /** @internal */
    public function __construct(private readonly int $scopeId)
    {
    }

    public function close(): void
    {
        if ($this->closed) {
            return;
        }
        $this->closed = LogBrewTelemetry::removeScope($this->scopeId);
    }

    public function __destruct()
    {
        $this->close();
    }
}
