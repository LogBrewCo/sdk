<?php

declare(strict_types=1);

use LogBrew\LogBrewLaravelQueueTelemetry;
use LogBrew\LogBrewTrace;
use LogBrew\RecordingTransport;

final class TestLaravelQueue
{
    /** @var array<'after'|'before'|'exception', list<callable(object): void>> */
    private array $listeners = ['after' => [], 'before' => [], 'exception' => []];

    public function before(callable $listener): void
    {
        $this->listeners['before'][] = $listener;
    }

    public function after(callable $listener): void
    {
        $this->listeners['after'][] = $listener;
    }

    public function exceptionOccurred(callable $listener): void
    {
        $this->listeners['exception'][] = $listener;
    }

    /** @param 'after'|'before'|'exception' $type */
    public function fire(string $type, object $event): void
    {
        foreach ($this->listeners[$type] as $listener) {
            $listener($event);
        }
    }
}

final class TestLaravelJob
{
    public function __construct(private readonly string $name, public readonly string $privatePayload)
    {
    }

    public function resolveName(): string
    {
        return $this->name;
    }

    public function getQueue(): string
    {
        return 'emails';
    }

    public function attempts(): int
    {
        return 2;
    }
}

final class TestLaravelQueueEvent
{
    public function __construct(
        public readonly object $job,
        public readonly string $connectionName = 'redis',
        public readonly ?Throwable $exception = null
    ) {
    }
}

$queue = new TestLaravelQueue();
$client = sampleClient();
$transport = RecordingTransport::alwaysAccept();
LogBrewLaravelQueueTelemetry::register($queue, $client, $transport);

$job = new TestLaravelJob('App\\Jobs\\SendReceipt', 'PRIVATE_JOB_PAYLOAD');
$queue->fire('before', new TestLaravelQueueEvent($job));
$active = LogBrewTrace::current();
assertTrue($active !== null, 'expected active Laravel job trace');
$client->log('evt_laravel_job_log', '2026-06-02T10:00:11Z', [
    'message' => 'receipt job running',
    'level' => 'info',
    'logger' => 'laravel.queue',
]);
$queue->fire('after', new TestLaravelQueueEvent($job));
assertTrue(LogBrewTrace::current() === null, 'expected Laravel job trace to close');

$success = testStringMap(json_decode($transport->sentBodies[0] ?? '', true, 512, JSON_THROW_ON_ERROR), 'Laravel success');
$successEvents = testList($success['events'] ?? null, 'Laravel success events');
assertTrue(count($successEvents) === 2, 'expected Laravel job log and span');
$logContext = testStringMap(testStringMap($successEvents[0], 'Laravel job log')['attributes'] ?? null, 'Laravel job log attributes')['context'] ?? null;
$logTrace = testStringMap(testStringMap($logContext, 'Laravel job log context')['trace'] ?? null, 'Laravel job log trace');
$span = testStringMap(testStringMap($successEvents[1], 'Laravel job span')['attributes'] ?? null, 'Laravel job span attributes');
$spanMetadata = testStringMap($span['metadata'] ?? null, 'Laravel job span metadata');
assertTrue(($span['name'] ?? null) === 'App\\Jobs\\SendReceipt', 'expected stable Laravel job name');
assertTrue(($span['status'] ?? null) === 'ok', 'expected successful Laravel job span');
assertTrue(($spanMetadata['operation'] ?? null) === 'job.execute' && ($spanMetadata['queue'] ?? null) === 'emails' && ($spanMetadata['connection'] ?? null) === 'redis' && ($spanMetadata['attempt'] ?? null) === 2, 'expected bounded Laravel job facts');
assertTrue(($span['traceId'] ?? null) === ($logTrace['traceId'] ?? null), 'expected Laravel log and span trace correlation');
assertTrue(($span['spanId'] ?? null) === ($logTrace['spanId'] ?? null), 'expected Laravel log and span correlation');

$failedJob = new TestLaravelJob('App\\Jobs\\ChargeCard', 'PRIVATE_FAILED_PAYLOAD');
$queue->fire('before', new TestLaravelQueueEvent($failedJob));
$error = new RuntimeException('PRIVATE_EXCEPTION_MESSAGE');
$queue->fire('exception', new TestLaravelQueueEvent($failedJob, exception: $error));
$queue->fire('after', new TestLaravelQueueEvent($failedJob));
assertTrue(LogBrewTrace::current() === null, 'expected failed Laravel job trace to close');
assertTrue(count($transport->sentBodies) === 2, 'expected duplicate Laravel completion to be ignored');

$failureBody = $transport->sentBodies[1];
$failure = testStringMap(json_decode($failureBody, true, 512, JSON_THROW_ON_ERROR), 'Laravel failure');
$failureEvents = testList($failure['events'] ?? null, 'Laravel failure events');
assertTrue(count($failureEvents) === 2, 'expected Laravel job issue and error span');
$issue = testStringMap(testStringMap($failureEvents[0], 'Laravel job issue')['attributes'] ?? null, 'Laravel job issue attributes');
$errorSpan = testStringMap(testStringMap($failureEvents[1], 'Laravel error span')['attributes'] ?? null, 'Laravel error span attributes');
$issueTrace = testStringMap(testStringMap($issue['context'] ?? null, 'Laravel issue context')['trace'] ?? null, 'Laravel issue trace');
$exception = testStringMap($issue['exception'] ?? null, 'Laravel job exception');
$mechanism = testStringMap($exception['mechanism'] ?? null, 'Laravel job mechanism');
assertTrue(($exception['type'] ?? null) === RuntimeException::class, 'expected typed Laravel job exception');
assertTrue(($mechanism['type'] ?? null) === 'laravel.queue', 'expected Laravel queue mechanism');
assertTrue(($mechanism['handled'] ?? null) === false, 'expected unhandled Laravel job exception');
assertTrue(($errorSpan['status'] ?? null) === 'error', 'expected failed Laravel job span');
assertTrue(($errorSpan['traceId'] ?? null) === ($issueTrace['traceId'] ?? null), 'expected Laravel issue and span trace correlation');
assertTrue(($errorSpan['spanId'] ?? null) === ($issueTrace['spanId'] ?? null), 'expected Laravel issue and span correlation');
foreach (['PRIVATE_JOB_PAYLOAD', 'PRIVATE_FAILED_PAYLOAD', 'PRIVATE_EXCEPTION_MESSAGE'] as $privateValue) {
    assertTrue(!str_contains(implode('', $transport->sentBodies), $privateValue), 'expected Laravel queue telemetry to omit private values');
}
