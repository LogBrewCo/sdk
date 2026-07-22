<?php

declare(strict_types=1);

namespace LogBrew;

use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use Throwable;

/** @internal Use LogBrewHttpClientTracing::wrapPsr18(). */
final class LogBrewPsr18TracingClient implements ClientInterface
{
    private function __construct(
        private readonly ClientInterface $client,
        private readonly LogBrewClient $logBrew,
        private readonly mixed $onCaptureError
    ) {
    }

    public static function wrap(
        ClientInterface $client,
        LogBrewClient $logBrew,
        ?callable $onCaptureError
    ): ClientInterface {
        if ($client instanceof self) {
            return $client;
        }

        return new self($client, $logBrew, $onCaptureError);
    }

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        $operation = LogBrewHttpClientTraceOperation::start(
            $this->logBrew,
            $request,
            'psr18',
            $this->onCaptureError
        );
        $scope = $operation?->activate();
        try {
            $response = $this->client->sendRequest($operation?->request() ?? $request);
        } catch (Throwable $error) {
            $scope?->close();
            $operation?->finishError($error);
            throw $error;
        } finally {
            $scope?->close();
        }

        $operation?->finishResponse($response);
        return $response;
    }
}
