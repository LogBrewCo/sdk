<?php

declare(strict_types=1);

namespace LogBrew\Symfony;

use LogBrew\Traceparent;
use Symfony\Component\Messenger\Stamp\StampInterface;

/** Serializable W3C context carried with a Symfony Messenger envelope. */
final readonly class MessengerTraceStamp implements StampInterface
{
    public function __construct(public string $traceparent)
    {
        Traceparent::parse($this->traceparent);
    }
}
