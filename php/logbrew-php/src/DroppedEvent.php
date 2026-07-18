<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Content-free local notice emitted when queue pressure rejects an event.
 */
final class DroppedEvent
{
    public function __construct(
        public readonly string $eventId,
        public readonly string $eventType,
        public readonly string $reason,
        public readonly int $droppedEvents,
        public readonly int $pendingEvents,
        public readonly int $pendingEventBytes
    ) {
    }
}
