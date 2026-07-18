<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Content-free worker delivery failure details safe for local diagnostics.
 */
final class WorkerDeliveryFailure
{
    /**
     * @param 'work_boundary'|'shutdown' $stage
     */
    public function __construct(
        public readonly string $stage,
        public readonly string $codeName,
        public readonly int $pendingEvents,
        public readonly int $pendingEventBytes
    ) {
    }
}
