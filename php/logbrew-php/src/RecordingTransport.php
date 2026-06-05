<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Scripted transport for previewing, accepting, or failing queued event flushes.
 */
final class RecordingTransport implements Transport
{
    /** @var list<int|TransportError> */
    private array $scriptedResponses;

    /**
     * Every request body sent through this transport instance.
     *
     * @var list<string>
     */
    public array $sentBodies = [];

    /**
     * @param list<int|TransportError> $scriptedResponses
     */
    public function __construct(array $scriptedResponses = [202])
    {
        $this->scriptedResponses = $scriptedResponses === [] ? [202] : array_values($scriptedResponses);
    }

    /**
     * Create a transport that accepts queued flushes with a 202 response.
     */
    public static function alwaysAccept(): self
    {
        return new self([202]);
    }

    /**
     * Return the most recent request body sent through this transport.
     */
    public function lastBody(): ?string
    {
        if ($this->sentBodies === []) {
            return null;
        }

        return $this->sentBodies[array_key_last($this->sentBodies)];
    }

    /**
     * Send a queued request body through the scripted transport sequence.
     */
    public function send(string $apiKey, string $body): TransportResponse
    {
        LogBrewClient::requireNonEmpty('api_key', $apiKey);
        $this->sentBodies[] = $body;

        $next = array_shift($this->scriptedResponses);
        if ($next instanceof TransportError) {
            throw $next;
        }

        $statusCode = is_int($next) ? $next : 202;
        return new TransportResponse($statusCode, 1);
    }
}
