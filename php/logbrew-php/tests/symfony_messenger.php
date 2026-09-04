<?php

declare(strict_types=1);

use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\Symfony\MessengerTraceStamp;
use LogBrew\Symfony\SymfonyMessengerTelemetry;
use Symfony\Component\Messenger\Envelope;
use Symfony\Component\Messenger\Event\WorkerMessageFailedEvent;
use Symfony\Component\Messenger\Exception\HandlerFailedException;
use Symfony\Component\Messenger\MessageBus;
use Symfony\Component\Messenger\Middleware\MiddlewareInterface;
use Symfony\Component\Messenger\Middleware\StackInterface;
use Symfony\Component\Messenger\Stamp\ReceivedStamp;
use Symfony\Component\Messenger\Stamp\RedeliveryStamp;

final class SymfonyMessengerTestMessage
{
    public function __construct(public readonly string $privatePayload)
    {
    }
}

final class SymfonyMessengerTestHandler implements MiddlewareInterface
{
    public ?Throwable $failure = null;

    public function __construct(private readonly LogBrewClient $client)
    {
    }

    public function handle(Envelope $envelope, StackInterface $stack): Envelope
    {
        $this->client->log('evt_symfony_messenger_log_' . bin2hex(random_bytes(4)), '2026-09-04T09:00:00Z', [
            'message' => 'order message handled',
            'level' => 'info',
            'logger' => 'messenger',
        ]);
        if ($this->failure !== null) {
            throw $this->failure;
        }
        return $envelope;
    }
}

/** @return list<array<string, mixed>> */
function symfonyMessengerEvents(RecordingTransport $transport): array
{
    $events = [];
    foreach ($transport->sentBodies as $body) {
        $payload = testStringMap(json_decode($body, true, 512, JSON_THROW_ON_ERROR), 'Messenger payload');
        foreach (testList($payload['events'] ?? null, 'Messenger events') as $event) {
            $events[] = testStringMap($event, 'Messenger event');
        }
    }
    return $events;
}

$client = LogBrewClient::create('LOGBREW_API_KEY', 'symfony-worker', '0.1.0');
$transport = RecordingTransport::alwaysAccept();
$sequence = 0;
$captureErrors = [];
$telemetry = new SymfonyMessengerTelemetry(
    $client,
    $transport,
    static function (string $kind) use (&$sequence): string {
        return 'evt_symfony_messenger_' . $kind . '_' . ++$sequence;
    },
    static fn (): string => '2026-09-04T09:00:00Z',
    static function (Throwable $error) use (&$captureErrors): void {
        $captureErrors[] = $error;
    }
);
$handler = new SymfonyMessengerTestHandler($client);
$bus = new MessageBus([$telemetry, $handler]);
$message = new SymfonyMessengerTestMessage('PRIVATE_MESSAGE_BODY');

$sent = $bus->dispatch($message);
$stamp = $sent->last(MessengerTraceStamp::class);
assertTrue($stamp instanceof MessengerTraceStamp, 'expected producer trace stamp');
$sendEvents = symfonyMessengerEvents($transport);
$sendSpan = testAttributes($sendEvents[1], 'Messenger send span');
assertTrue(testValueAt($sendSpan, ['metadata', 'operation']) === 'messaging.send', 'expected Messenger send operation');
assertTrue(testValueAt(testContext($sendEvents[0], 'Messenger send log'), ['trace', 'spanId']) === ($sendSpan['spanId'] ?? null), 'expected dispatch log correlation');

$received = $sent->with(new ReceivedStamp('async'));
$bus->dispatch($received);
$workerEvents = array_slice(symfonyMessengerEvents($transport), 2);
$workerSpan = testAttributes($workerEvents[1], 'Messenger worker span');
assertTrue(testValueAt($workerSpan, ['metadata', 'operation']) === 'messaging.process', 'expected Messenger process operation');
assertTrue(testValueAt($workerSpan, ['metadata', 'transport']) === 'async', 'expected bounded Messenger transport');
assertTrue(testValueAt($workerSpan, ['metadata', 'attempt']) === 1, 'expected first Messenger attempt');
assertTrue(($workerSpan['parentSpanId'] ?? null) === ($sendSpan['spanId'] ?? null), 'expected producer-to-worker parentage');
assertTrue(testValueAt(testContext($workerEvents[0], 'Messenger worker log'), ['trace', 'spanId']) === ($workerSpan['spanId'] ?? null), 'expected worker log correlation');

$handler->failure = new RuntimeException('PRIVATE_EXCEPTION_MESSAGE');
try {
    $bus->dispatch($received);
} catch (Throwable $error) {
    $retryEvent = new WorkerMessageFailedEvent($received, 'async', $error);
    $retryEvent->setForRetry();
    $telemetry->onMessageFailed($retryEvent);
}
$eventsAfterRetry = symfonyMessengerEvents($transport);
assertTrue(count(array_filter($eventsAfterRetry, static fn (array $event): bool => ($event['type'] ?? null) === 'issue')) === 0, 'expected retry without issue');

$retryEnvelope = $received->with(new RedeliveryStamp(1));
try {
    $bus->dispatch($retryEnvelope);
} catch (Throwable $error) {
    $telemetry->onMessageFailed(new WorkerMessageFailedEvent(
        $retryEnvelope,
        'async',
        new HandlerFailedException($retryEnvelope, ['handler' => $error])
    ));
}
$allEvents = symfonyMessengerEvents($transport);
$issues = array_values(array_filter($allEvents, static fn (array $event): bool => ($event['type'] ?? null) === 'issue'));
$errorSpans = array_values(array_filter($allEvents, static fn (array $event): bool => ($event['type'] ?? null) === 'span' && testValueAt($event, ['attributes', 'status']) === 'error'));
assertTrue(count($issues) === 1, 'expected one terminal Messenger issue');
$issue = testAttributes($issues[0], 'Messenger issue');
$terminalSpan = testAttributes($errorSpans[1], 'terminal Messenger span');
assertTrue(testValueAt($terminalSpan, ['metadata', 'attempt']) === 2, 'expected retry attempt count');
assertTrue(testValueAt($issue, ['exception', 'type']) === RuntimeException::class, 'expected unwrapped Messenger exception');
assertTrue(testValueAt($issue, ['exception', 'mechanism', 'type']) === 'symfony.messenger', 'expected Messenger mechanism');
assertTrue(testValueAt($issue, ['context', 'trace', 'spanId']) === ($terminalSpan['spanId'] ?? null), 'expected terminal issue correlation');
assertTrue($captureErrors === [], 'expected no Messenger capture diagnostics');
foreach (['PRIVATE_MESSAGE_BODY', 'PRIVATE_EXCEPTION_MESSAGE'] as $privateValue) {
    assertTrue(!str_contains(implode('', $transport->sentBodies), $privateValue), 'expected Messenger private values to be absent');
}
