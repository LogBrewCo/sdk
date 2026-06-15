<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Parsed W3C traceparent context with normalized lowercase identifiers.
 */
final class TraceparentContext
{
    public function __construct(
        public readonly string $version,
        public readonly string $traceId,
        public readonly string $parentSpanId,
        public readonly string $traceFlags,
        public readonly bool $sampled
    ) {
    }
}
