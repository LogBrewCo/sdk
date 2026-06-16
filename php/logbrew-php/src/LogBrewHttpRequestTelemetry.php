<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * Explicit app-owned HTTP request telemetry with trace/log/error correlation.
 *
 * @phpstan-import-type Metadata from LogBrewClient
 */
final class LogBrewHttpRequestTelemetry
{
    private readonly int $startedAtNs;
    private bool $finished = false;

    private function __construct(
        private readonly LogBrewClient $client,
        public readonly string $method,
        public readonly string $routeTemplate,
        public readonly LogBrewTraceContext $trace
    ) {
        $this->startedAtNs = hrtime(true);
    }

    /**
     * Start request telemetry, continuing a valid incoming traceparent or falling back to a local root trace.
     */
    public static function start(
        LogBrewClient $client,
        string $method,
        string $routeTemplate,
        ?string $incomingTraceparent = null
    ): self {
        return new self(
            $client,
            self::normalizeMethod($method),
            self::normalizeRouteTemplate($routeTemplate),
            LogBrewTraceContext::fromIncomingTraceparentOrCreateRoot($incomingTraceparent)
        );
    }

    /**
     * Start request telemetry from an app-created trace context.
     */
    public static function startWithTraceContext(
        LogBrewClient $client,
        string $method,
        string $routeTemplate,
        LogBrewTraceContext $trace
    ): self {
        return new self($client, self::normalizeMethod($method), self::normalizeRouteTemplate($routeTemplate), $trace);
    }

    /**
     * Activate this request trace while handler code runs.
     */
    public function activate(): LogBrewTraceScope
    {
        return LogBrewTrace::activate($this->trace);
    }

    /**
     * Return explicit outgoing propagation headers for app-owned HTTP clients.
     *
     * @return array{traceparent:string}
     */
    public function outgoingHeaders(): array
    {
        return $this->trace->headers();
    }

    /**
     * Finish the request span with route/status metadata.
     *
     * @param array<string, mixed> $metadata
     */
    public function finishSpan(string $eventId, string $timestamp, int $statusCode, array $metadata = []): void
    {
        $this->finish($eventId, null, $timestamp, $statusCode, $metadata);
    }

    /**
     * Finish the request span and matching http.server.duration metric.
     *
     * @param array<string, mixed> $metadata
     */
    public function finishSpanAndMetric(
        string $spanEventId,
        string $metricEventId,
        string $timestamp,
        int $statusCode,
        array $metadata = []
    ): void {
        $this->finish($spanEventId, $metricEventId, $timestamp, $statusCode, $metadata);
    }

    /**
     * @param array<string, mixed> $metadata
     */
    private function finish(
        string $spanEventId,
        ?string $metricEventId,
        string $timestamp,
        int $statusCode,
        array $metadata
    ): void {
        if ($this->finished) {
            throw new SdkError('validation_error', 'HTTP request telemetry is already finished');
        }
        self::requireStatusCode($statusCode);

        $durationMs = $this->elapsedMilliseconds();
        $requestMetadata = LogBrewTrace::metadataWithTrace($this->trace, $this->requestMetadata($statusCode, $metadata));
        $spanAttributes = [
            'name' => sprintf('%s %s', $this->method, $this->routeTemplate),
            'traceId' => $this->trace->traceId,
            'spanId' => $this->trace->spanId,
            'status' => self::statusFromHttpStatus($statusCode),
            'durationMs' => $durationMs,
            'metadata' => $requestMetadata,
        ];
        if ($this->trace->parentSpanId !== null) {
            $spanAttributes['parentSpanId'] = $this->trace->parentSpanId;
        }

        $this->client->span($spanEventId, $timestamp, $spanAttributes);
        if ($metricEventId !== null) {
            $this->client->metric($metricEventId, $timestamp, [
                'name' => 'http.server.duration',
                'kind' => 'histogram',
                'value' => $durationMs,
                'unit' => 'ms',
                'temporality' => 'delta',
                'metadata' => $requestMetadata,
            ]);
        }

        $this->finished = true;
    }

    private function elapsedMilliseconds(): float
    {
        return max(0.0, (hrtime(true) - $this->startedAtNs) / 1_000_000);
    }

    /**
     * @param array<string, mixed> $metadata
     * @return Metadata
     */
    private function requestMetadata(int $statusCode, array $metadata): array
    {
        $copied = LogBrewClient::copyPrimitiveMetadata($metadata);
        $copied['method'] = $this->method;
        $copied['routeTemplate'] = $this->routeTemplate;
        $copied['statusCode'] = $statusCode;
        return $copied;
    }

    private static function normalizeMethod(string $method): string
    {
        LogBrewClient::requireNonEmpty('HTTP request method', $method);
        $normalized = strtoupper(trim($method));
        if (preg_match('/^[A-Z]+$/', $normalized) !== 1) {
            throw new SdkError('validation_error', 'HTTP request method must be a valid HTTP method');
        }

        return $normalized;
    }

    private static function normalizeRouteTemplate(string $routeTemplate): string
    {
        LogBrewClient::requireNonEmpty('HTTP request routeTemplate', $routeTemplate);
        $trimmed = trim($routeTemplate);
        $parts = parse_url($trimmed);
        if (is_array($parts) && isset($parts['scheme'], $parts['host'])) {
            $path = (string) ($parts['path'] ?? '/');
            return $path === '' ? '/' : $path;
        }

        $cutoff = self::firstPresentIndex(strpos($trimmed, '?'), strpos($trimmed, '#'));
        if ($cutoff !== null) {
            $trimmed = rtrim(substr($trimmed, 0, $cutoff));
        }
        if ($trimmed === '') {
            throw new SdkError('validation_error', 'HTTP request routeTemplate must be non-empty');
        }

        return $trimmed;
    }

    private static function requireStatusCode(int $statusCode): void
    {
        if ($statusCode < 100 || $statusCode > 599) {
            throw new SdkError('validation_error', 'HTTP request statusCode must be between 100 and 599');
        }
    }

    /** @return 'ok'|'error' */
    private static function statusFromHttpStatus(int $statusCode): string
    {
        return $statusCode >= 500 ? 'error' : 'ok';
    }

    private static function firstPresentIndex(int|false $first, int|false $second): ?int
    {
        if ($first === false) {
            return $second === false ? null : $second;
        }
        if ($second === false) {
            return $first;
        }

        return min($first, $second);
    }
}
