<?php

declare(strict_types=1);

namespace LogBrew;

use DateTimeImmutable;
use DateTimeInterface;
use Psr\Log\AbstractLogger;
use Psr\Log\InvalidArgumentException;
use Psr\Log\LogLevel;
use Stringable;
use Throwable;

/**
 * PSR-3 logger implementation that queues LogBrew log events.
 *
 * @phpstan-type MetadataValue string|int|float|bool|null
 * @phpstan-type Metadata array<string, MetadataValue>
 * @phpstan-type MetadataInput array<string, mixed>
 * @phpstan-type TimestampProvider callable(): DateTimeInterface
 * @phpstan-type ErrorHandler callable(Throwable): void
 */
final class LogBrewPsrLogger extends AbstractLogger
{
    private const LEVEL_MAP = [
        LogLevel::DEBUG => 'debug',
        LogLevel::INFO => 'info',
        LogLevel::NOTICE => 'info',
        LogLevel::WARNING => 'warning',
        LogLevel::ERROR => 'error',
        LogLevel::CRITICAL => 'error',
        LogLevel::ALERT => 'error',
        LogLevel::EMERGENCY => 'error',
    ];

    private int $nextEventNumber = 0;

    /**
     * @param MetadataInput $metadata
     * @param TimestampProvider|null $timestampProvider
     * @param ErrorHandler|null $onError
     */
    public function __construct(
        private readonly LogBrewClient $client,
        private readonly string $loggerName = 'psr-3',
        private readonly string $eventIdPrefix = 'php_log',
        private readonly array $metadata = [],
        private readonly ?Transport $transport = null,
        private readonly bool $flushOnLog = false,
        private readonly bool $includeExceptionTrace = false,
        private readonly mixed $timestampProvider = null,
        private readonly mixed $onError = null
    ) {
        LogBrewClient::requireNonEmpty('logger name', $this->loggerName);
        LogBrewClient::requireNonEmpty('event id prefix', $this->eventIdPrefix);
    }

    /**
     * @param string|\Stringable $message
     * @param array<string, mixed> $context
     */
    public function log($level, string|Stringable $message, array $context = []): void
    {
        if (!is_string($level) || !array_key_exists($level, self::LEVEL_MAP)) {
            throw new InvalidArgumentException('unsupported PSR-3 log level');
        }

        try {
            $this->nextEventNumber++;
            $metadata = $this->metadata($level, $message, $context);
            $this->client->log(
                sprintf('%s_%d', $this->eventIdPrefix, $this->nextEventNumber),
                $this->timestamp(),
                [
                    'message' => $this->interpolate((string) $message, $context),
                    'level' => self::LEVEL_MAP[$level],
                    'logger' => $this->loggerName,
                    'metadata' => $metadata,
                ]
            );

            if ($this->flushOnLog && $this->transport !== null) {
                $this->client->flush($this->transport);
            }
        } catch (Throwable $error) {
            if (is_callable($this->onError)) {
                ($this->onError)($error);
                return;
            }

            throw $error;
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
     * @param string|\Stringable $message
     * @param array<string, mixed> $context
     * @return Metadata
     */
    private function metadata(string $level, string|Stringable $message, array $context): array
    {
        $metadata = $this->copyMetadata($this->metadata);
        $metadata['psrLevel'] = $level;
        $metadata['messageTemplate'] = (string) $message;

        foreach ($context as $key => $value) {
            if ($key === 'exception') {
                $this->addException($metadata, $value);
                continue;
            }

            if ($this->isMetadataValue($value)) {
                $metadata['context.' . $key] = $value;
            }
        }

        return $metadata;
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

    /** @phpstan-assert-if-true MetadataValue $value */
    private function isMetadataValue(mixed $value): bool
    {
        if ($value === null || is_string($value) || is_int($value) || is_bool($value)) {
            return true;
        }

        return is_float($value) && is_finite($value);
    }
}
