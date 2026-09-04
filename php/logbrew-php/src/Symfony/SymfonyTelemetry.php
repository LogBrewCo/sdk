<?php

declare(strict_types=1);

namespace LogBrew\Symfony;

use Closure;
use Composer\InstalledVersions;
use DateTimeImmutable;
use DateTimeInterface;
use LogBrew\HttpTransport;
use LogBrew\IssueDiagnostics;
use LogBrew\LogBrewClient;
use LogBrew\LogBrewHttpRequestTelemetry;
use LogBrew\LogBrewMonologHandler;
use LogBrew\LogBrewTelemetry;
use LogBrew\LogBrewTelemetryScope;
use LogBrew\LogBrewTrace;
use LogBrew\SdkError;
use LogBrew\TelemetryContext;
use LogBrew\TelemetryResource;
use LogBrew\Transport;
use LogBrew\TransportResponse;
use Monolog\Handler\HandlerInterface;
use Monolog\Handler\NoopHandler;
use Monolog\Level;
use Symfony\Component\HttpFoundation\Request;
use Throwable;

/**
 * Native Symfony capture with conservative privacy defaults and bounded delivery.
 *
 * A missing key disables capture without preventing the application from booting.
 * Concrete request paths, query strings, exception messages, and stack traces are not
 * captured unless the corresponding exception options are explicitly enabled.
 *
 * @phpstan-type Status array{
 *   active: bool,
 *   reason: 'ready'|'disabled'|'missing_api_key',
 *   service: string,
 *   environment: string,
 *   sdk: string,
 *   sdkVersion: string
 * }
 * @phpstan-type TimestampProvider callable(): DateTimeInterface
 * @phpstan-type EventIdProvider callable(string, int): string
 * @phpstan-type ErrorHandler callable(Throwable): void
 * @phpstan-type ContextProvider callable(Request): (TelemetryContext|null)
 * @phpstan-type MonologLevelName 'debug'|'info'|'notice'|'warning'|'error'|'critical'|'alert'|'emergency'
 */
final class SymfonyTelemetry
{
    private const SDK_NAME = 'logbrew-php-symfony';

    private readonly string $apiKey;

    private readonly string $sdkVersion;

    private readonly ?LogBrewClient $client;

    private readonly ?Transport $transport;

    /** @var MonologLevelName|Level */
    private readonly string|Level $level;

    /** @var Closure|null */
    private readonly ?Closure $timestampProvider;

    /** @var Closure|null */
    private readonly ?Closure $eventIdProvider;

    /** @var Closure|null */
    private readonly ?Closure $onError;

    /** @var Closure|null */
    private readonly ?Closure $contextProvider;

    private int $nextEventNumber = 0;

    /**
     * @param TimestampProvider|null $timestampProvider
     * @param EventIdProvider|null $eventIdProvider
     * @param ErrorHandler|null $onError
     * @param ContextProvider|null $contextProvider
     * @param MonologLevelName|Level $level
     */
    public function __construct(
        private readonly bool $enabled = true,
        ?string $apiKey = null,
        private readonly string $service = 'symfony-app',
        private readonly string $release = 'unversioned',
        private readonly string $environment = 'production',
        ?Transport $transport = null,
        ?callable $timestampProvider = null,
        ?callable $eventIdProvider = null,
        private readonly string $endpoint = HttpTransport::DEFAULT_ENDPOINT,
        private readonly float $timeout = 2.0,
        private readonly int $maxRetries = 0,
        string|Level $level = 'warning',
        private readonly bool $captureRequests = true,
        private readonly bool $captureExceptions = true,
        private readonly bool $includeExceptionMessage = false,
        private readonly bool $includeExceptionTrace = false,
        ?string $sdkVersion = null,
        ?callable $onError = null,
        ?callable $contextProvider = null
    ) {
        LogBrewClient::requireNonEmpty('Symfony service', $this->service);
        LogBrewClient::requireNonEmpty('Symfony release', $this->release);
        LogBrewClient::requireNonEmpty('Symfony environment', $this->environment);
        if ($this->timeout <= 0) {
            throw new SdkError('configuration_error', 'Symfony LogBrew timeout must be positive');
        }
        if ($this->maxRetries < 0) {
            throw new SdkError('configuration_error', 'Symfony LogBrew maxRetries must be non-negative');
        }
        $this->level = self::normalizeLevel($level);

        $this->apiKey = trim($apiKey ?? self::environmentApiKey());
        $resolvedSdkVersion = trim($sdkVersion ?? self::installedSdkVersion());
        $this->sdkVersion = $resolvedSdkVersion === '' ? 'unversioned' : $resolvedSdkVersion;
        $this->timestampProvider = $timestampProvider === null ? null : Closure::fromCallable($timestampProvider);
        $this->eventIdProvider = $eventIdProvider === null ? null : Closure::fromCallable($eventIdProvider);
        $this->onError = $onError === null ? null : Closure::fromCallable($onError);
        $this->contextProvider = $contextProvider === null ? null : Closure::fromCallable($contextProvider);

        if (!$this->active()) {
            $this->client = null;
            $this->transport = null;
            return;
        }

        $frameworkVersion = self::installedPackageVersion('symfony/framework-bundle');
        $resource = TelemetryResource::create()
            ->withService($this->service)
            ->withDeployment($this->environment, $this->release)
            ->withFramework('symfony', $frameworkVersion)
            ->build();
        $this->client = LogBrewClient::create(
            apiKey: $this->apiKey,
            sdkName: self::SDK_NAME,
            sdkVersion: $this->sdkVersion,
            maxRetries: $this->maxRetries,
            context: TelemetryContext::create()->withResource($resource)->build()
        );
        $this->transport = $transport ?? new HttpTransport(endpoint: $this->endpoint, timeout: $this->timeout);
    }

    public function active(): bool
    {
        return $this->enabled && $this->apiKey !== '';
    }

    /** @return Status */
    public function status(): array
    {
        $reason = 'ready';
        if (!$this->enabled) {
            $reason = 'disabled';
        } elseif ($this->apiKey === '') {
            $reason = 'missing_api_key';
        }

        return [
            'active' => $this->active(),
            'reason' => $reason,
            'service' => $this->service,
            'environment' => $this->environment,
            'sdk' => self::SDK_NAME,
            'sdkVersion' => $this->sdkVersion,
        ];
    }

    /**
     * Return a service handler for MonologBundle. Disabled capture becomes a no-op.
     */
    public function monologHandler(): HandlerInterface
    {
        if ($this->client === null || $this->transport === null) {
            return new NoopHandler();
        }

        return new LogBrewMonologHandler(
            client: $this->client,
            loggerName: $this->service,
            eventIdPrefix: 'symfony_log_' . bin2hex(random_bytes(8)),
            metadata: $this->baseMetadata(),
            transport: $this->transport,
            flushOnLog: true,
            includeExceptionTrace: $this->includeExceptionTrace,
            timestampProvider: $this->timestampProvider,
            level: $this->level,
            onError: $this->onError,
            includeExceptionMessage: $this->includeExceptionMessage
        );
    }

    public function messengerTelemetry(): SymfonyMessengerTelemetry
    {
        return new SymfonyMessengerTelemetry(
            $this->client,
            $this->transport,
            fn (string $kind): string => $this->eventId('messenger_' . $kind),
            fn (): string => $this->timestamp(),
            function (Throwable $error): void {
                $this->reportError($error);
            }
        );
    }

    /**
     * Send one explicit diagnostic event for intake confirmation.
     */
    public function sendProbeEvent(): TransportResponse
    {
        if ($this->client === null || $this->transport === null) {
            throw new SdkError('configuration_error', 'Symfony LogBrew capture is not active');
        }

        $this->client->log($this->eventId('probe'), $this->timestamp(), [
            'message' => 'LogBrew Symfony delivery probe',
            'level' => 'info',
            'logger' => $this->service,
            'metadata' => $this->baseMetadata(),
        ]);

        return $this->client->flush($this->transport);
    }

    public function beginRequest(
        string $method,
        string $routeTemplate,
        ?string $incomingTraceparent = null,
        ?Request $symfonyRequest = null
    ): ?SymfonyRequestState {
        if ($this->client === null || (!$this->captureRequests && !$this->captureExceptions)) {
            return null;
        }

        try {
            $request = LogBrewHttpRequestTelemetry::start(
                $this->client,
                $method,
                $routeTemplate,
                $incomingTraceparent
            );

            $contextScope = $this->activateProvidedContext($symfonyRequest);
            try {
                return new SymfonyRequestState($request, $request->activate(), $contextScope);
            } catch (Throwable $error) {
                $contextScope?->close();
                throw $error;
            }
        } catch (Throwable $error) {
            $this->reportError($error);
            return null;
        }
    }

    public function recordException(SymfonyRequestState $state, Throwable $exception): void
    {
        if (!$state->finished) {
            $state->exception = $exception;
        }
    }

    public function finishRequest(SymfonyRequestState $state, int $statusCode): void
    {
        if ($state->finished) {
            return;
        }

        try {
            $captureAttempted = false;

            if ($this->captureExceptions && $state->exception !== null && $statusCode >= 500) {
                $captureAttempted = true;
                try {
                    $this->captureException($state, $statusCode);
                } catch (Throwable $error) {
                    $this->reportError($error);
                }
            }

            if ($this->captureRequests) {
                $captureAttempted = true;
                try {
                    $state->request->finishSpan(
                        $this->eventId('span'),
                        $this->timestamp(),
                        $statusCode,
                        $this->baseMetadata()
                    );
                } catch (Throwable $error) {
                    $this->reportError($error);
                }
            }

            if (
                $this->client !== null
                && $this->transport !== null
                && $captureAttempted
                && $this->client->pendingEvents() > 0
            ) {
                try {
                    $this->client->flush($this->transport);
                } catch (Throwable $error) {
                    $this->reportError($error);
                }
            }
        } finally {
            $this->cancelRequest($state);
        }
    }

    public function cancelRequest(SymfonyRequestState $state): void
    {
        if ($state->finished) {
            return;
        }

        $state->finished = true;
        try {
            $state->scope->close();
        } finally {
            $state->contextScope?->close();
        }
    }

    private function captureException(SymfonyRequestState $state, int $statusCode): void
    {
        if ($this->client === null || $state->exception === null) {
            return;
        }

        $metadata = $this->baseMetadata();
        $metadata['method'] = $state->request->method;
        $metadata['routeTemplate'] = $state->request->routeTemplate;
        $metadata['statusCode'] = $statusCode;
        $exceptionType = self::exceptionType($state->exception);
        $frameFile = self::exceptionFrameFile($state->exception);
        $metadata['exceptionType'] = $exceptionType;
        $metadata['errorName'] = $exceptionType;
        $metadata['issueGroupingKey'] = self::issueGroupingKey(
            $exceptionType,
            $state->request->routeTemplate,
            $frameFile
        );
        $metadata['issueGroupingSource'] = 'exception_type_route_file';
        $metadata['handled'] = false;
        $metadata['mechanism'] = 'symfony.kernel_exception';
        if ($frameFile !== null) {
            $metadata['errorFrameFile'] = $frameFile;
            $metadata['errorFrameLine'] = min($state->exception->getLine(), 2_147_483_647);
        }
        if ($this->includeExceptionMessage) {
            $metadata['exceptionMessage'] = self::boundedString($state->exception->getMessage(), 2_048);
        }
        if ($this->includeExceptionTrace) {
            $metadata['exceptionTrace'] = self::boundedString($state->exception->getTraceAsString(), 16_384);
        }

        $this->client->issue(
            $this->eventId('issue'),
            $this->timestamp(),
            IssueDiagnostics::fromThrowable(
                $state->exception,
                title: $exceptionType,
                message: 'A Symfony request ended with an unhandled exception.',
                mechanismType: 'symfony.kernel_exception',
                handled: false,
                metadata: LogBrewTrace::metadataWithTrace($state->request->trace, $metadata)
            )
        );
    }

    /** @return array<string, string> */
    private function baseMetadata(): array
    {
        return [
            'framework' => 'symfony',
            'service' => $this->service,
            'release' => $this->release,
            'environment' => $this->environment,
        ];
    }

    private function timestamp(): string
    {
        $timestamp = $this->timestampProvider === null
            ? new DateTimeImmutable('now')
            : ($this->timestampProvider)();
        if (!$timestamp instanceof DateTimeInterface) {
            throw new SdkError('validation_error', 'Symfony timestamp provider must return DateTimeInterface');
        }

        return $timestamp->format(DateTimeInterface::ATOM);
    }

    private function eventId(string $kind): string
    {
        $this->nextEventNumber++;
        $eventId = $this->eventIdProvider === null
            ? sprintf('symfony_%s_%s_%d', $kind, bin2hex(random_bytes(8)), $this->nextEventNumber)
            : ($this->eventIdProvider)($kind, $this->nextEventNumber);
        if (!is_string($eventId)) {
            throw new SdkError('validation_error', 'Symfony event id provider must return a string');
        }
        LogBrewClient::requireNonEmpty('Symfony event id', $eventId);

        return $eventId;
    }

    private function reportError(Throwable $error): void
    {
        if ($this->onError === null) {
            return;
        }

        try {
            ($this->onError)($error);
        } catch (Throwable) {
            // Telemetry failure callbacks must not affect the Symfony application.
        }
    }

    private function activateProvidedContext(?Request $request): ?LogBrewTelemetryScope
    {
        if ($this->contextProvider === null) {
            return null;
        }
        if ($request === null) {
            $this->reportError(new SdkError(
                'configuration_error',
                'Symfony context provider requires the current Request'
            ));
            return null;
        }

        try {
            $context = ($this->contextProvider)($request);
            if ($context === null) {
                return null;
            }
            if (!$context instanceof TelemetryContext) {
                throw new SdkError(
                    'validation_error',
                    'Symfony context provider must return TelemetryContext or null'
                );
            }
            return LogBrewTelemetry::activateContext($context);
        } catch (Throwable $error) {
            $this->reportError($error);
            return null;
        }
    }

    private static function environmentApiKey(): string
    {
        foreach ([
            $_SERVER['LOGBREW_SERVER_API_KEY'] ?? null,
            $_ENV['LOGBREW_SERVER_API_KEY'] ?? null,
            getenv('LOGBREW_SERVER_API_KEY'),
        ] as $value) {
            if (is_string($value)) {
                return $value;
            }
        }

        return '';
    }

    private static function installedSdkVersion(): string
    {
        if (!class_exists(InstalledVersions::class) || !InstalledVersions::isInstalled('logbrew/sdk')) {
            return 'unversioned';
        }

        return InstalledVersions::getPrettyVersion('logbrew/sdk') ?? 'unversioned';
    }

    private static function installedPackageVersion(string $package): ?string
    {
        if (!class_exists(InstalledVersions::class) || !InstalledVersions::isInstalled($package)) {
            return null;
        }

        $version = InstalledVersions::getPrettyVersion($package);
        return is_string($version) && trim($version) !== '' ? $version : null;
    }

    private static function boundedString(string $value, int $maxBytes): string
    {
        if (strlen($value) <= $maxBytes) {
            return $value;
        }

        return substr($value, 0, $maxBytes);
    }

    private static function exceptionType(Throwable $exception): string
    {
        $reflection = new \ReflectionClass($exception);
        if ($reflection->isAnonymous()) {
            return 'anonymous_exception';
        }

        return self::boundedString($exception::class, 512);
    }

    private static function exceptionFrameFile(Throwable $exception): ?string
    {
        $basename = basename(str_replace('\\', '/', $exception->getFile()));
        $sanitized = preg_replace('/[?#\x00-\x1F\x7F]+/', '_', trim($basename));
        if (!is_string($sanitized) || $sanitized === '') {
            return null;
        }

        return self::boundedString($sanitized, 512);
    }

    private static function issueGroupingKey(
        string $exceptionType,
        string $routeTemplate,
        ?string $frameFile
    ): string {
        $material = implode("\n", [$exceptionType, $routeTemplate, $frameFile ?? '']);
        return 'symfony-exception-' . hash('sha256', $material);
    }

    /** @return MonologLevelName|Level */
    private static function normalizeLevel(string|Level $level): string|Level
    {
        if ($level instanceof Level) {
            return $level;
        }

        return match (strtolower($level)) {
            'debug' => 'debug',
            'info' => 'info',
            'notice' => 'notice',
            'warning' => 'warning',
            'error' => 'error',
            'critical' => 'critical',
            'alert' => 'alert',
            'emergency' => 'emergency',
            default => throw new SdkError(
                'configuration_error',
                'Symfony LogBrew level must be a standard Monolog level name'
            ),
        };
    }
}
