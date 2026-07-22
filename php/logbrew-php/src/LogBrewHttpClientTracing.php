<?php

declare(strict_types=1);

namespace LogBrew;

use Psr\Http\Client\ClientInterface;

/**
 * Explicit adapters for tracing app-owned PSR-18 and Guzzle HTTP clients.
 */
final class LogBrewHttpClientTracing
{
    private function __construct()
    {
    }

    /**
     * Wrap a PSR-18 client without changing request, response, or exception behavior.
     */
    public static function wrapPsr18(
        ClientInterface $client,
        LogBrewClient $logBrew,
        ?callable $onCaptureError = null
    ): ClientInterface {
        return LogBrewPsr18TracingClient::wrap($client, $logBrew, $onCaptureError);
    }

    /** Return duplicate-safe Guzzle middleware for one app-owned HandlerStack. */
    public static function guzzleMiddleware(
        LogBrewClient $logBrew,
        ?callable $onCaptureError = null
    ): LogBrewGuzzleTracingMiddleware
    {
        return new LogBrewGuzzleTracingMiddleware($logBrew, $onCaptureError);
    }
}
