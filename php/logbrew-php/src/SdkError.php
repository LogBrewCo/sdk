<?php

declare(strict_types=1);

namespace LogBrew;

use RuntimeException;

/**
 * Stable public SDK error with a parseable code and message.
 */
final class SdkError extends RuntimeException
{
    /**
     * Create a public SDK error with a stable code name and message.
     */
    public function __construct(
        public readonly string $codeName,
        string $message
    ) {
        parent::__construct($message);
    }
}
