<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\LogBrewMonologHandler;
use LogBrew\RecordingTransport;
use LogBrew\SdkError;
use Monolog\Handler\AbstractProcessingHandler;
use Monolog\LogRecord;
use Monolog\Logger as MonologLogger;

(static function (): void {
    $assert = static function (bool $condition, string $message): void {
        if (!$condition) {
            throw new RuntimeException($message);
        }
    };
    $cases = 0;

    foreach (['capture', 'delivery'] as $stage) {
        foreach ([false, true] as $strict) {
            foreach (['absent', 'healthy', 'throws'] as $callbackMode) {
                $label = $stage . '/' . ($strict ? 'strict' : 'default') . '/' . $callbackMode;
                $client = LogBrewClient::create('LOGBREW_API_KEY', 'php-callback-boundary', '1.0.0', maxRetries: 0);
                $transport = new RecordingTransport($stage === 'delivery' ? [503, 202, 202] : [202]);
                $captureError = new RuntimeException('synthetic capture failure');
                $callbackError = new RuntimeException('synthetic diagnostic failure');
                $reported = [];
                $callback = $callbackMode === 'absent' ? null
                    : static function (Throwable $error) use (&$reported, $callbackMode, $callbackError): void {
                        $reported[] = $error;
                        if ($callbackMode === 'throws') {
                            throw $callbackError;
                        }
                    };
                $timestampCalls = 0;
                $timestampProvider = static function () use (&$timestampCalls, $stage, $captureError): DateTimeImmutable {
                    $timestampCalls++;
                    if ($stage === 'capture' && $timestampCalls === 1) {
                        throw $captureError;
                    }
                    return new DateTimeImmutable('2026-06-02T10:00:00+00:00');
                };
                $prefix = 'callback_' . $stage . '_' . ($strict ? 'strict' : 'default') . '_' . $callbackMode;
                $options = [
                    'client' => $client,
                    'eventIdPrefix' => $prefix,
                    'transport' => $transport,
                    'flushOnLog' => true,
                    'timestampProvider' => $timestampProvider,
                    'onError' => $callback,
                ];
                if ($strict) {
                    $options['raiseErrors'] = true;
                }
                $handler = new LogBrewMonologHandler(...$options);
                $local = new class extends AbstractProcessingHandler {
                    /** @var list<LogRecord> */
                    public array $records = [];

                    protected function write(LogRecord $record): void
                    {
                        $this->records[] = $record;
                    }
                };
                $logger = new MonologLogger('capture.boundary', [$handler, $local]);

                $escaped = null;
                try {
                    $logger->warning('first record');
                } catch (Throwable $error) {
                    $escaped = $error;
                }

                $assert($strict ? $escaped !== null : $escaped === null, "{$label}: propagation must follow raiseErrors");
                $assert($escaped !== $callbackError, "{$label}: diagnostic failure must not escape");
                if ($strict && $stage === 'capture') {
                    $assert($escaped === $captureError, "{$label}: strict capture must rethrow the original error object");
                }
                if ($strict && $stage === 'delivery') {
                    $assert($escaped instanceof SdkError && $escaped->codeName === 'transport_error', "{$label}: strict delivery must preserve the transport error");
                }
                $reportedCount = $callbackMode === 'absent' ? 0 : 1;
                $assert(count($reported) === $reportedCount, "{$label}: report the original failure exactly once");
                if ($reportedCount === 1) {
                    if ($stage === 'capture') {
                        $assert($reported[0] === $captureError, "{$label}: callback must receive the original capture error");
                    } else {
                        $assert($reported[0] instanceof SdkError && $reported[0]->codeName === 'transport_error', "{$label}: callback must receive the transport error");
                    }
                    if ($strict) {
                        $assert($escaped === $reported[0], "{$label}: strict mode must rethrow the error given to the callback");
                    }
                }
                $assert(count($local->records) === ($strict ? 0 : 1), "{$label}: preserve the local handler's propagation boundary");
                $assert($client->pendingEvents() === ($stage === 'delivery' ? 1 : 0), "{$label}: preserve admission and retention");
                $assert(count($transport->sentBodies) === ($stage === 'delivery' ? 1 : 0), "{$label}: callback must not cause extra delivery attempts");
                if ($stage === 'delivery') {
                    $retained = testEvents(
                        testStringMap(json_decode($client->previewJson(), true, flags: JSON_THROW_ON_ERROR), "{$label}: retained payload"),
                        "{$label}: retained events"
                    );
                    $assert($retained[0]['id'] === $prefix . '_1', "{$label}: failed delivery must retain the original explicit ID");
                }

                $logger->warning('healthy record', ['attempt' => 2]);
                $assert($client->pendingEvents() === 0, "{$label}: subsequent healthy logging must drain admitted records");
                $assert(count($reported) === $reportedCount, "{$label}: healthy recovery must not report another failure");
                $assert(count($local->records) === ($strict ? 1 : 2), "{$label}: subsequent healthy logging must reach the local handler");
                $lastRecord = end($local->records);
                $assert($lastRecord !== false && $lastRecord->message === 'healthy record', "{$label}: preserve the application record");

                $attempts = $stage === 'delivery' ? 3 : 1;
                $assert(count($transport->sentBodies) === $attempts, "{$label}: recovery must make only the required attempts");
                if ($stage === 'delivery') {
                    $assert($transport->sentBodies[0] === $transport->sentBodies[1], "{$label}: retained retry bytes must not change");
                }
                $lastBody = $transport->lastBody();
                if (!is_string($lastBody)) {
                    throw new RuntimeException("{$label}: healthy event must have a recorded request");
                }
                $accepted = testEvents(
                    testStringMap(json_decode($lastBody, true, flags: JSON_THROW_ON_ERROR), "{$label}: accepted payload"),
                    "{$label}: accepted events"
                );
                $assert(count($accepted) === 1, "{$label}: healthy record must be sent once");
                $attributes = testAttributes($accepted[0], "{$label}: accepted attributes");
                $metadata = testStringMap($attributes['metadata'] ?? null, "{$label}: accepted metadata");
                $assert($accepted[0]['id'] === $prefix . '_2', "{$label}: preserve the explicit prefix and counter");
                $assert($attributes['message'] === 'healthy record', "{$label}: preserve the captured message");
                $assert($attributes['level'] === 'warning', "{$label}: preserve severity");
                $assert($metadata['context.attempt'] === 2, "{$label}: preserve structured log context");
                $client->shutdown($transport);
                $cases++;
            }
        }
    }

    fwrite(STDOUT, "php Monolog error callback checks passed ({$cases})\n");
})();
