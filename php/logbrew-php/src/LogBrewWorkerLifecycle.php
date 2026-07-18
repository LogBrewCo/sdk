<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Explicit delivery boundaries for long-running PHP workers.
 */
final class LogBrewWorkerLifecycle
{
    private const SAFE_DELIVERY_CODES = [
        'delivery_error',
        'flush_error',
        'network_failure',
        'shutdown_error',
        'transport_error',
        'unauthenticated',
        'validation_error',
    ];

    private ?TransportResponse $shutdownResponse = null;

    private bool $operationActive = false;

    private function __construct(
        private readonly LogBrewClient $client,
        private readonly Transport $transport,
        private readonly ?\Closure $onDeliveryFailure,
        private readonly int $ownerProcessId
    ) {
    }

    /**
     * Create an app-scoped worker lifecycle around one client and transport.
     *
     * @param callable(WorkerDeliveryFailure): void|null $onDeliveryFailure
     */
    public static function create(
        LogBrewClient $client,
        Transport $transport,
        ?callable $onDeliveryFailure = null
    ): self {
        return new self(
            $client,
            $transport,
            $onDeliveryFailure === null ? null : \Closure::fromCallable($onDeliveryFailure),
            self::currentProcessId()
        );
    }

    /**
     * Run one work item and flush its queued telemetry at the boundary.
     *
     * @template TResult
     * @param callable(): TResult $work
     * @return TResult
     */
    public function run(callable $work): mixed
    {
        $this->assertProcessOwnership();
        if ($this->shutdownResponse !== null) {
            throw new SdkError('shutdown_error', 'worker lifecycle is already shut down');
        }
        $this->beginOperation();

        try {
            $applicationError = null;
            $result = null;
            try {
                $result = $work();
            } catch (\Throwable $error) {
                $applicationError = $error;
            }
            try {
                $this->assertProcessOwnership();
            } catch (SdkError $ownershipError) {
                if ($applicationError !== null) {
                    throw $applicationError;
                }
                throw $ownershipError;
            }
            try {
                $this->client->flush($this->transport);
            } catch (\Throwable $deliveryError) {
                $this->reportDeliveryFailure('work_boundary', $deliveryError);
            }

            if ($applicationError !== null) {
                throw $applicationError;
            }

            return $result;
        } finally {
            $this->operationActive = false;
        }
    }

    /**
     * Drain telemetry and close the client exactly once.
     */
    public function shutdown(): TransportResponse
    {
        $this->assertProcessOwnership();
        if ($this->shutdownResponse !== null) {
            return $this->shutdownResponse;
        }
        $this->beginOperation();

        try {
            try {
                $this->shutdownResponse = $this->client->shutdown($this->transport);
            } catch (\Throwable $deliveryError) {
                $this->reportDeliveryFailure('shutdown', $deliveryError);
                throw $deliveryError;
            }

            return $this->shutdownResponse;
        } finally {
            $this->operationActive = false;
        }
    }

    private function beginOperation(): void
    {
        if ($this->operationActive) {
            throw new SdkError('worker_lifecycle_error', 'worker lifecycle operation is already in progress');
        }
        $this->operationActive = true;
    }

    private function assertProcessOwnership(): void
    {
        if (self::currentProcessId() !== $this->ownerProcessId) {
            throw new SdkError(
                'process_ownership_error',
                'worker lifecycle must be created in the current process'
            );
        }
    }

    private static function currentProcessId(): int
    {
        $processId = getmypid();
        if ($processId === false) {
            throw new SdkError('process_ownership_error', 'worker process identity is unavailable');
        }

        return $processId;
    }

    /** @param 'work_boundary'|'shutdown' $stage */
    private function reportDeliveryFailure(string $stage, \Throwable $error): void
    {
        if ($this->onDeliveryFailure === null) {
            return;
        }

        $codeName = $error instanceof SdkError
            && in_array($error->codeName, self::SAFE_DELIVERY_CODES, true)
                ? $error->codeName
                : 'delivery_error';
        try {
            ($this->onDeliveryFailure)(new WorkerDeliveryFailure(
                $stage,
                $codeName,
                $this->client->pendingEvents(),
                $this->client->pendingEventBytes()
            ));
        } catch (\Throwable) {
            // Diagnostic callbacks must not affect telemetry or application behavior.
        }
    }
}
