<?php

declare(strict_types=1);

namespace LogBrew\Symfony;

use LogBrew\LogBrewHttpRequestTelemetry;
use LogBrew\LogBrewTraceScope;
use Throwable;

/** @internal Request-local state owned by SymfonyRequestSubscriber. */
final class SymfonyRequestState
{
    public ?Throwable $exception = null;

    public bool $finished = false;

    public function __construct(
        public readonly LogBrewHttpRequestTelemetry $request,
        public readonly LogBrewTraceScope $scope
    ) {
    }
}
