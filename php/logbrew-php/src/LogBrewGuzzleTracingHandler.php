<?php

declare(strict_types=1);

namespace LogBrew;

use Closure;
use GuzzleHttp\Promise\Create;
use GuzzleHttp\Promise\PromiseInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use Throwable;
use UnexpectedValueException;

/** @internal One duplicate-aware invocation boundary in a Guzzle HandlerStack. */
final class LogBrewGuzzleTracingHandler
{
    private const ACTIVE_OPTION = 'logbrew.http_client_tracing.active';

    private readonly Closure $handler;

    public function __construct(
        callable $handler,
        private readonly LogBrewClient $logBrew,
        private readonly mixed $onCaptureError
    ) {
        $this->handler = Closure::fromCallable($handler);
    }

    /** @param array<string, mixed> $options */
    public function __invoke(RequestInterface $request, array $options): PromiseInterface
    {
        if (($options[self::ACTIVE_OPTION] ?? null) === true) {
            return $this->invokeHandler($request, $options);
        }

        $options[self::ACTIVE_OPTION] = true;
        $operation = LogBrewHttpClientTraceOperation::start(
            $this->logBrew,
            $request,
            'guzzle',
            $this->onCaptureError
        );
        $scope = $operation?->activate();
        try {
            $promise = $this->invokeHandler($operation?->request() ?? $request, $options);
        } catch (Throwable $error) {
            $scope?->close();
            $operation?->finishError($error);
            throw $error;
        } finally {
            $scope?->close();
        }

        if ($operation === null) {
            return $promise;
        }

        $observed = $promise->then(
            static function (mixed $result) use ($operation): mixed {
                if ($result instanceof ResponseInterface) {
                    $operation->finishResponse($result);
                } else {
                    $operation->finishWithoutResponse();
                }
                return $result;
            },
            static function (mixed $reason) use ($operation): PromiseInterface {
                $operation->finishError($reason);
                return Create::rejectionFor($reason);
            }
        );
        return new LogBrewGuzzleTracingPromise($observed, $operation);
    }

    /** @param array<string, mixed> $options */
    private function invokeHandler(RequestInterface $request, array $options): PromiseInterface
    {
        $promise = ($this->handler)($request, $options);
        if (!$promise instanceof PromiseInterface) {
            throw new UnexpectedValueException('Guzzle handler must return a promise');
        }

        return $promise;
    }
}
