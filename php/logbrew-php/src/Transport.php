<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Public transport contract used by flush and shutdown operations.
 */
interface Transport
{
    /**
     * Send a queued request body through the transport and return its response.
     *
     * @throws TransportError|SdkError
     */
    public function send(string $apiKey, string $body): TransportResponse;
}
