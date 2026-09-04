<?php

declare(strict_types=1);

namespace LogBrew\Symfony;

use Closure;
use LogBrew\IssueDiagnostics;
use LogBrew\LogBrewClient;
use LogBrew\LogBrewOperationTracing;
use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTraceContext;
use LogBrew\Transport;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\Messenger\Envelope;
use Symfony\Component\Messenger\Event\WorkerMessageFailedEvent;
use Symfony\Component\Messenger\Exception\HandlerFailedException;
use Symfony\Component\Messenger\Middleware\MiddlewareInterface;
use Symfony\Component\Messenger\Middleware\StackInterface;
use Symfony\Component\Messenger\Stamp\ReceivedStamp;
use Symfony\Component\Messenger\Stamp\RedeliveryStamp;
use Throwable;
use WeakMap;

/** Producer-to-worker spans and terminal failure issues for Symfony Messenger. */
final class SymfonyMessengerTelemetry implements MiddlewareInterface, EventSubscriberInterface
{
    /** @var WeakMap<object, array{trace:LogBrewTraceContext,name:string,metadata:array<string, string|int>}> */
    private WeakMap $failedAttempts;

    /**
     * @param Closure(string): string $eventId
     * @param Closure(): string $timestamp
     * @param Closure(Throwable): void $onError
     */
    public function __construct(
        private readonly ?LogBrewClient $client,
        private readonly ?Transport $transport,
        private readonly Closure $eventId,
        private readonly Closure $timestamp,
        private readonly Closure $onError
    ) {
        $this->failedAttempts = new WeakMap();
    }

    public function handle(Envelope $envelope, StackInterface $stack): Envelope
    {
        if ($this->client === null || $this->transport === null) {
            return $stack->next()->handle($envelope, $stack);
        }

        $received = $envelope->last(ReceivedStamp::class);
        $message = $envelope->getMessage();
        $name = self::messageName($message);
        $metadata = self::metadata($envelope, $received);
        $options = [
            'eventId' => ($this->eventId)('span'),
            'timestamp' => ($this->timestamp)(),
            'operation' => $metadata['operation'],
            'metadata' => $metadata,
            'onCaptureError' => function (Throwable $error): void {
                $this->report($error);
            },
        ];
        $stamp = $envelope->last(MessengerTraceStamp::class);
        if ($received !== null && $stamp instanceof MessengerTraceStamp) {
            $options['incomingTraceparent'] = $stamp->traceparent;
        }

        try {
            $result = LogBrewOperationTracing::queueOperation(
                $this->client,
                $name,
                function (LogBrewTraceContext $trace) use ($envelope, $message, $metadata, $name, $received, $stack): Envelope {
                    if ($received === null) {
                        $envelope = $envelope->with(new MessengerTraceStamp($trace->traceparent()));
                    } else {
                        $this->failedAttempts[$message] = compact('trace', 'name', 'metadata');
                    }
                    $result = $stack->next()->handle($envelope, $stack);
                    if ($received !== null) {
                        unset($this->failedAttempts[$message]);
                    }
                    return $result;
                },
                $options
            );
            return $result instanceof Envelope ? $result : throw new \LogicException('Expected Messenger envelope');
        } finally {
            $this->flush();
        }
    }

    public function onMessageFailed(WorkerMessageFailedEvent $event): void
    {
        $message = $event->getEnvelope()->getMessage();
        $state = $this->failedAttempts[$message] ?? null;
        unset($this->failedAttempts[$message]);
        if ($state === null || $event->willRetry() || $this->client === null) {
            return;
        }

        try {
            $error = self::applicationError($event->getThrowable());
            $metadata = $state['metadata'];
            $metadata['exceptionType'] = $error::class;
            $metadata['issueGroupingKey'] = 'symfony-messenger-' . hash(
                'sha256',
                $state['name'] . "\n" . $error::class
            );
            $scope = LogBrewTrace::activate($state['trace']);
            try {
                $this->client->issue(
                    ($this->eventId)('issue'),
                    ($this->timestamp)(),
                    IssueDiagnostics::fromThrowable(
                        $error,
                        title: $state['name'] . ' failed',
                        message: 'A Symfony message exhausted its retry policy.',
                        mechanismType: 'symfony.messenger',
                        handled: false,
                        metadata: $metadata
                    )
                );
            } finally {
                $scope->close();
            }
        } catch (Throwable $error) {
            $this->report($error);
        }
        $this->flush();
    }

    public static function getSubscribedEvents(): array
    {
        return [WorkerMessageFailedEvent::class => ['onMessageFailed', 0]];
    }

    private function flush(): void
    {
        if ($this->client === null || $this->transport === null || $this->client->pendingEvents() === 0) {
            return;
        }
        try {
            $this->client->flush($this->transport);
        } catch (Throwable $error) {
            $this->report($error);
        }
    }

    /**
     * @return array{
     *   source:'symfony.messenger', framework:'symfony',
     *   operation:'messaging.send'|'messaging.process', transport?:string, attempt?:int
     * }
     */
    private static function metadata(Envelope $envelope, ?ReceivedStamp $received): array
    {
        $metadata = [
            'source' => 'symfony.messenger',
            'framework' => 'symfony',
            'operation' => $received === null ? 'messaging.send' : 'messaging.process',
        ];
        if ($received !== null) {
            $transport = trim($received->getTransportName());
            if (preg_match('/^[A-Za-z0-9._:-]{1,128}$/D', $transport) === 1) {
                $metadata['transport'] = $transport;
            }
            $metadata['attempt'] = RedeliveryStamp::getRetryCountFromEnvelope($envelope) + 1;
        }
        return $metadata;
    }

    private static function messageName(object $message): string
    {
        $reflection = new \ReflectionClass($message);
        $name = ltrim($message::class, '\\');
        return !$reflection->isAnonymous() && preg_match('/^[A-Za-z_][A-Za-z0-9_\\\\]{0,255}$/D', $name) === 1
            ? $name
            : 'symfony.message';
    }

    private static function applicationError(Throwable $error): Throwable
    {
        if (!$error instanceof HandlerFailedException) {
            return $error;
        }
        foreach ($error->getWrappedExceptions() as $wrapped) {
            return $wrapped;
        }
        return $error;
    }

    private function report(Throwable $error): void
    {
        try {
            ($this->onError)($error);
        } catch (Throwable) {
            // Telemetry diagnostics must not alter message handling.
        }
    }
}
