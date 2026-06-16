<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Reinstates the previous active trace when closed.
 */
final class LogBrewTraceScope
{
    private bool $closed = false;

    public function __construct(private readonly int $scopeId)
    {
    }

    public function close(): void
    {
        if ($this->closed) {
            return;
        }

        $this->closed = LogBrewTrace::removeScope($this->scopeId);
    }

    public function __destruct()
    {
        $this->close();
    }
}
