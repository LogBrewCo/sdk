<?php

declare(strict_types=1);

namespace LogBrew;

use DateTimeImmutable;
use DateTimeInterface;
use Monolog\Handler\AbstractProcessingHandler;
use Monolog\Level;
use Monolog\LogRecord;
use Psr\Log\LogLevel;
use Stringable;
use Throwable;

/**
 * Optional Monolog handler for Laravel and other Monolog-based PHP apps.
 *
 * @phpstan-type MetadataValue string|int|float|bool|null
 * @phpstan-type Metadata array<string, MetadataValue>
 * @phpstan-type MetadataInput array<string, mixed>
 * @phpstan-type TimestampProvider callable(): DateTimeInterface
 * @phpstan-type ErrorHandler callable(Throwable): void
 */
final class LogBrewMonologHandler extends AbstractProcessingHandler
{
    private int $nextEventNumber = 0;

    /**
     * @param MetadataInput $metadata
     * @param TimestampProvider|null $timestampProvider
     * @param ErrorHandler|null $onError
     */
    public function __construct(
        private readonly LogBrewClient $client,
        private readonly string $loggerName = 'monolog',
        private readonly string $eventIdPrefix = 'php_monolog',
        private readonly array $metadata = [],
        private readonly ?Transport $transport = null,
        private readonly bool $flushOnLog = false,
        private readonly bool $includeExceptionTrace = false,
        private readonly mixed $timestampProvider = null,
        int|string|Level $level = Level::Debug,
        bool $bubble = true,
        private readonly mixed $onError = null,
        private readonly bool $raiseErrors = false
    ) {
        parent::__construct($level, $bubble);
        LogBrewClient::requireNonEmpty('logger name', $this->loggerName);
        LogBrewClient::requireNonEmpty('event id prefix', $this->eventIdPrefix);
    }

    protected function write(LogRecord $record): void
    {
        try {
            $this->nextEventNumber++;
            $context = $this->stringKeyed($record->context);
            $metadata = $this->metadata($record, $context);
            $this->client->log(
                sprintf('%s_%d', $this->eventIdPrefix, $this->nextEventNumber),
                $this->timestamp(),
                [
                    'message' => $this->interpolate($record->message, $context),
                    'level' => $this->mapLevel($record->level),
                    'logger' => $record->channel !== '' ? $record->channel : $this->loggerName,
                    'metadata' => $metadata,
                ]
            );

            if ($this->flushOnLog && $this->transport !== null) {
                $this->client->flush($this->transport);
            }
        } catch (Throwable $error) {
            if (is_callable($this->onError)) {
                ($this->onError)($error);
            }
            if ($this->raiseErrors) {
                throw $error;
            }
        }
    }

    private function timestamp(): string
    {
        $provider = $this->timestampProvider;
        $timestamp = is_callable($provider) ? $provider() : new DateTimeImmutable('now');
        if (!$timestamp instanceof DateTimeInterface) {
            throw new SdkError('validation_error', 'timestamp provider must return DateTimeInterface');
        }

        return $timestamp->format(DateTimeInterface::ATOM);
    }

    /**
     * @param array<string, mixed> $context
     * @return Metadata
     */
    private function metadata(LogRecord $record, array $context): array
    {
        $metadata = $this->copyMetadata($this->metadata);
        $metadata['monologLevel'] = strtolower($record->level->getName());
        $metadata['monologChannel'] = $record->channel;
        $metadata['messageTemplate'] = $record->message;

        foreach ($context as $key => $value) {
            if ($key === 'exception') {
                $this->addException($metadata, $value);
                continue;
            }

            if ($this->isMetadataValue($value)) {
                $metadata['context.' . $key] = $value;
            }
        }

        foreach ($this->stringKeyed($record->extra) as $key => $value) {
            if ($this->isMetadataValue($value)) {
                $metadata['extra.' . $key] = $value;
            }
        }

        return $metadata;
    }

    /** @return 'debug'|'info'|'warning'|'error' */
    private function mapLevel(Level $level): string
    {
        return match ($level->toPsrLogLevel()) {
            LogLevel::DEBUG => 'debug',
            LogLevel::INFO, LogLevel::NOTICE => 'info',
            LogLevel::WARNING => 'warning',
            default => 'error',
        };
    }

    /**
     * @param MetadataInput $metadata
     * @return Metadata
     */
    private function copyMetadata(array $metadata): array
    {
        $copied = [];
        foreach ($metadata as $key => $value) {
            if ($this->isMetadataValue($value)) {
                $copied[$key] = $value;
            }
        }

        return $copied;
    }

    /**
     * @param Metadata $metadata
     */
    private function addException(array &$metadata, mixed $value): void
    {
        if (!$value instanceof Throwable) {
            return;
        }

        $metadata['exceptionType'] = $value::class;
        $metadata['exceptionMessage'] = $value->getMessage();
        if ($this->includeExceptionTrace) {
            $metadata['exceptionTrace'] = $value->getTraceAsString();
        }
    }

    /**
     * @param array<string, mixed> $context
     */
    private function interpolate(string $message, array $context): string
    {
        $replace = [];
        foreach ($context as $key => $value) {
            if ($key === 'exception') {
                continue;
            }

            if ($value === null || is_scalar($value) || $value instanceof Stringable) {
                $replace['{' . $key . '}'] = (string) $value;
            }
        }

        return strtr($message, $replace);
    }

    /**
     * @param array<mixed> $values
     * @return array<string, mixed>
     */
    private function stringKeyed(array $values): array
    {
        $copied = [];
        foreach ($values as $key => $value) {
            if (is_string($key)) {
                $copied[$key] = $value;
            }
        }

        return $copied;
    }

    /** @phpstan-assert-if-true MetadataValue $value */
    private function isMetadataValue(mixed $value): bool
    {
        if ($value === null || is_string($value) || is_int($value) || is_bool($value)) {
            return true;
        }

        return is_float($value) && is_finite($value);
    }
}
