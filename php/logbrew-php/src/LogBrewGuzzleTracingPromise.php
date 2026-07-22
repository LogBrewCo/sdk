<?php

declare(strict_types=1);

namespace LogBrew;

use GuzzleHttp\Promise\CancellationException;
use GuzzleHttp\Promise\PromiseInterface;
use Psr\Http\Message\ResponseInterface;

/** @internal Promise decorator that observes caller-initiated cancellation. */
final class LogBrewGuzzleTracingPromise implements PromiseInterface
{
    public function __construct(
        private readonly PromiseInterface $promise,
        private readonly LogBrewHttpClientTraceOperation $operation
    ) {
    }

    public function then(?callable $onFulfilled = null, ?callable $onRejected = null): PromiseInterface
    {
        return new self($this->promise->then($onFulfilled, $onRejected), $this->operation);
    }

    public function otherwise(callable $onRejected): PromiseInterface
    {
        return new self($this->promise->otherwise($onRejected), $this->operation);
    }

    public function getState(): string
    {
        return $this->promise->getState();
    }

    public function resolve($value): void
    {
        $this->promise->resolve($value);
        if ($value instanceof ResponseInterface) {
            $this->operation->finishResponse($value);
        } else {
            $this->operation->finishWithoutResponse();
        }
    }

    public function reject($reason): void
    {
        $this->promise->reject($reason);
        $this->operation->finishError($reason);
    }

    public function cancel(): void
    {
        if ($this->promise->getState() !== self::PENDING) {
            return;
        }

        $this->operation->finishError(new CancellationException('Promise has been cancelled'));
        $this->promise->cancel();
    }

    public function wait(bool $unwrap = true): mixed
    {
        return $this->promise->wait($unwrap);
    }
}
