<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Framework-native Laravel queue spans, issue diagnostics, and active-trace correlation.
 */
final class LogBrewLaravelQueueTelemetry
{
    /** @var array<int, array{name:string, trace:LogBrewTraceContext, scope:LogBrewTraceScope, started:int|float, metadata:array<string, string|int>}> */
    private array $jobs = [];

    private function __construct(
        private readonly LogBrewClient $client,
        private readonly Transport $transport,
        private readonly ?\Closure $onCaptureError
    ) {
    }

    /**
     * Register one telemetry listener set on a Laravel queue manager.
     *
     * @param callable(\Throwable): void|null $onCaptureError
     */
    public static function register(
        object $queue,
        LogBrewClient $client,
        Transport $transport,
        ?callable $onCaptureError = null
    ): self {
        foreach (['before', 'after', 'exceptionOccurred'] as $method) {
            if (!is_callable([$queue, $method])) {
                throw new SdkError('configuration_error', "Laravel queue manager must provide {$method}().");
            }
        }

        $telemetry = new self(
            $client,
            $transport,
            $onCaptureError === null ? null : \Closure::fromCallable($onCaptureError)
        );
        $queue->before(static function (object $event) use ($telemetry): void {
            $telemetry->start($event);
        });
        $queue->after(static function (object $event) use ($telemetry): void {
            $telemetry->finish($event, false);
        });
        $queue->exceptionOccurred(static function (object $event) use ($telemetry): void {
            $telemetry->finish($event, true);
        });
        return $telemetry;
    }

    private function start(object $event): void
    {
        try {
            $job = self::eventJob($event);
            $key = spl_object_id($job);
            if (isset($this->jobs[$key])) {
                return;
            }
            $parent = LogBrewTrace::current();
            $trace = $parent === null ? LogBrewTraceContext::createRoot() : LogBrewTraceContext::createChild($parent);
            $name = self::jobName($job);
            $metadata = self::metadata($event, $job);
            $this->jobs[$key] = [
                'name' => $name,
                'trace' => $trace,
                'scope' => LogBrewTrace::activate($trace),
                'started' => hrtime(true),
                'metadata' => $metadata,
            ];
        } catch (\Throwable $error) {
            $this->report($error);
        }
    }

    private function finish(object $event, bool $failed): void
    {
        try {
            $job = self::eventJob($event);
            $applicationError = null;
            if ($failed) {
                $candidate = $event->exception ?? null;
                if (!$candidate instanceof \Throwable) {
                    throw new SdkError('capture_error', 'Laravel queue failure event must expose its exception.');
                }
                $applicationError = $candidate;
            }
        } catch (\Throwable $error) {
            $this->report($error);
            return;
        }
        $key = spl_object_id($job);
        $state = $this->jobs[$key] ?? null;
        if ($state === null) {
            return;
        }
        unset($this->jobs[$key]);

        try {
            $timestamp = gmdate('Y-m-d\TH:i:s\Z');
            if ($applicationError !== null) {
                try {
                    $this->client->issue(
                        self::eventId('issue'),
                        $timestamp,
                        IssueDiagnostics::fromThrowable(
                            $applicationError,
                            title: $state['name'] . ' failed',
                            mechanismType: 'laravel.queue',
                            handled: false,
                            metadata: $state['metadata']
                        )
                    );
                } catch (\Throwable $error) {
                    $this->report($error);
                }
            }
            $span = [
                'name' => $state['name'],
                'traceId' => $state['trace']->traceId,
                'spanId' => $state['trace']->spanId,
                'status' => $applicationError === null ? 'ok' : 'error',
                'durationMs' => max(0.0, (hrtime(true) - $state['started']) / 1_000_000),
                'metadata' => LogBrewTrace::metadataWithTrace($state['trace'], $state['metadata']),
            ];
            if ($state['trace']->parentSpanId !== null) {
                $span['parentSpanId'] = $state['trace']->parentSpanId;
            }
            $this->client->span(self::eventId('span'), $timestamp, $span);
        } catch (\Throwable $error) {
            $this->report($error);
        } finally {
            $state['scope']->close();
        }

        try {
            $this->client->flush($this->transport);
        } catch (\Throwable $error) {
            $this->report($error);
        }
    }

    private static function eventJob(object $event): object
    {
        if (!isset($event->job) || !is_object($event->job)) {
            throw new SdkError('capture_error', 'Laravel queue event must expose its job.');
        }
        return $event->job;
    }

    private static function jobName(object $job): string
    {
        $resolved = is_callable([$job, 'resolveName']) ? $job->resolveName() : $job::class;
        $name = is_string($resolved) ? ltrim(trim($resolved), '\\') : '';
        return preg_match('/^[A-Za-z_][A-Za-z0-9_\\\\]{0,255}$/D', $name) === 1 ? $name : 'laravel.job';
    }

    /** @return array<string, string|int> */
    private static function metadata(object $event, object $job): array
    {
        $metadata = ['source' => 'laravel.queue', 'framework' => 'laravel', 'operation' => 'job.execute'];
        foreach (['connectionName' => 'connection', 'getQueue' => 'queue'] as $source => $target) {
            $value = $source === 'connectionName' ? ($event->connectionName ?? null) : (is_callable([$job, $source]) ? $job->{$source}() : null);
            if (is_string($value) && preg_match('/^[A-Za-z0-9._:-]{1,128}$/D', $value) === 1) {
                $metadata[$target] = $value;
            }
        }
        if (is_callable([$job, 'attempts'])) {
            $attempt = $job->attempts();
            if (is_int($attempt) && $attempt >= 0 && $attempt <= 1_000_000) {
                $metadata['attempt'] = $attempt;
            }
        }
        return $metadata;
    }

    private static function eventId(string $type): string
    {
        return "evt_{$type}_php_laravel_" . bin2hex(random_bytes(6));
    }

    private function report(\Throwable $error): void
    {
        if ($this->onCaptureError === null) {
            return;
        }
        try {
            ($this->onCaptureError)($error);
        } catch (\Throwable) {
            // Diagnostics must not alter Laravel job execution.
        }
    }
}
