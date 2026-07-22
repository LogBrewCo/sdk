<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Stable transport response returned from flush and shutdown operations.
 */
final class TransportResponse
{
    public function __construct(
        /** Final HTTP-like status returned by the transport. */
        public readonly int $statusCode,
        /** Number of transport attempts used for the flush. */
        public readonly int $attempts,
        /** Number of accepted request batches completed by the flush. */
        public readonly int $batches = 1
    ) {
    }
}
