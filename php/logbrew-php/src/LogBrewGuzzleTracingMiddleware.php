<?php

declare(strict_types=1);

namespace LogBrew;

/** @internal Created by LogBrewHttpClientTracing::guzzleMiddleware(). */
final class LogBrewGuzzleTracingMiddleware
{
    public function __construct(
        private readonly LogBrewClient $logBrew,
        private readonly mixed $onCaptureError
    ) {
    }

    public function __invoke(callable $handler): LogBrewGuzzleTracingHandler
    {
        return new LogBrewGuzzleTracingHandler($handler, $this->logBrew, $this->onCaptureError);
    }
}
