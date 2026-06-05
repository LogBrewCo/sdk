<?php

declare(strict_types=1);

namespace LogBrew;

use RuntimeException;

/**
 * Transport failure with a stable public code and retry hint.
 */
final class TransportError extends RuntimeException
{
    public function __construct(
        public readonly string $codeName,
        string $message,
        public readonly bool $retryable = false
    ) {
        parent::__construct($message);
    }

    /**
     * Create a retryable network failure that preserves queued events.
     */
    public static function network(string $message): self
    {
        return new self('network_failure', $message, true);
    }
}
