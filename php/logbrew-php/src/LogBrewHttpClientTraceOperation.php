<?php

declare(strict_types=1);

namespace LogBrew;

use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use Throwable;

/** @internal Shared exact-once outbound HTTP tracing lifecycle. */
final class LogBrewHttpClientTraceOperation
{
    private bool $finished = false;

    private function __construct(
        private readonly LogBrewClient $client,
        private readonly RequestInterface $propagatedRequest,
        private readonly LogBrewTraceContext $trace,
        private readonly string $method,
        private readonly string $host,
        private readonly string $source,
        private readonly int $startedAt,
        private readonly mixed $onCaptureError
    ) {
    }

    public static function start(
        LogBrewClient $client,
        RequestInterface $request,
        string $source,
        mixed $onCaptureError
    ): ?self {
        $parent = LogBrewTrace::current();
        if ($parent === null) {
            return null;
        }

        try {
            $trace = LogBrewTraceContext::createChild($parent);
            $propagatedRequest = $request->withHeader('traceparent', $trace->traceparent());

            return new self(
                $client,
                $propagatedRequest,
                $trace,
                self::normalizeMethod($request->getMethod()),
                self::normalizeHost($request->getUri()->getHost()),
                $source,
                hrtime(true),
                $onCaptureError
            );
        } catch (Throwable $error) {
            self::reportCaptureError($onCaptureError, $error);
            return null;
        }
    }

    public function request(): RequestInterface
    {
        return $this->propagatedRequest;
    }

    public function activate(): LogBrewTraceScope
    {
        return LogBrewTrace::activate($this->trace);
    }

    public function finishResponse(ResponseInterface $response): void
    {
        if ($this->finished) {
            return;
        }
        $this->finished = true;

        try {
            $statusCode = $response->getStatusCode();
            $this->capture($statusCode >= 400 ? 'error' : 'ok', $statusCode, null);
        } catch (Throwable $error) {
            self::reportCaptureError($this->onCaptureError, $error);
        }
    }

    public function finishError(mixed $reason): void
    {
        if ($this->finished) {
            return;
        }
        $this->finished = true;

        try {
            $this->capture('error', null, $reason instanceof Throwable ? $reason : null);
        } catch (Throwable $error) {
            self::reportCaptureError($this->onCaptureError, $error);
        }
    }

    public function finishWithoutResponse(): void
    {
        if ($this->finished) {
            return;
        }
        $this->finished = true;

        try {
            $this->capture('error', null, null);
        } catch (Throwable $error) {
            self::reportCaptureError($this->onCaptureError, $error);
        }
    }

    /** @param 'ok'|'error' $status */
    private function capture(string $status, ?int $statusCode, ?Throwable $error): void
    {
        $metadata = [
            'method' => $this->method,
            'host' => $this->host,
        ];
        if ($statusCode !== null) {
            $metadata['statusCode'] = $statusCode;
        }
        $metadata['source'] = $this->source;
        $metadata['sampled'] = $this->trace->sampled;
        if ($error !== null) {
            $metadata['exceptionType'] = $error::class;
        }

        $attributes = [
            'name' => 'http.client',
            'traceId' => $this->trace->traceId,
            'spanId' => $this->trace->spanId,
            'status' => $status,
            'durationMs' => max(0.0, (hrtime(true) - $this->startedAt) / 1_000_000),
            'metadata' => $metadata,
        ];
        if ($this->trace->parentSpanId !== null) {
            $attributes['parentSpanId'] = $this->trace->parentSpanId;
        }

        $this->client->span(
            'evt_span_php_http_client_' . bin2hex(random_bytes(6)),
            gmdate('Y-m-d\TH:i:s\Z'),
            $attributes
        );
    }

    private static function normalizeMethod(string $method): string
    {
        $normalized = strtoupper(trim($method));
        return preg_match('/^[A-Z]{1,32}$/D', $normalized) === 1 ? $normalized : 'OTHER';
    }

    private static function normalizeHost(string $host): string
    {
        $normalized = strtolower(rtrim(trim($host), '.'));
        if ($normalized === '' || strlen($normalized) > 253 || preg_match('/^[a-z0-9.:[\]-]+$/D', $normalized) !== 1) {
            return 'unknown';
        }

        return $normalized;
    }

    private static function reportCaptureError(mixed $callback, Throwable $error): void
    {
        if (!is_callable($callback)) {
            return;
        }

        try {
            $callback($error);
        } catch (Throwable) {
            // Capture diagnostics are advisory and cannot alter the HTTP operation.
        }
    }
}
