<?php

declare(strict_types=1);

namespace LogBrew;

use Closure;
use Throwable;

/**
 * Dependency-free HTTP transport for sending queued event batches to LogBrew.
 */
final class HttpTransport implements Transport
{
    public const DEFAULT_ENDPOINT = 'https://api.logbrew.co/v1/events';
    public const DEFAULT_TIMEOUT = 10.0;

    /** @var array<string, string> */
    public readonly array $headers;

    /** @var Closure|null */
    private readonly ?Closure $requester;

    /**
     * @param array<string, string> $headers
     */
    public function __construct(
        public readonly string $endpoint = self::DEFAULT_ENDPOINT,
        array $headers = [],
        public readonly float $timeout = self::DEFAULT_TIMEOUT,
        ?callable $requester = null
    ) {
        $this->validateEndpoint($endpoint);
        $this->validateTimeout($timeout);
        $this->headers = $this->copyHeaders($headers);
        $this->requester = $requester === null ? null : Closure::fromCallable($requester);
    }

    /**
     * POST one serialized event batch and return the HTTP status.
     */
    public function send(string $apiKey, string $body): TransportResponse
    {
        LogBrewClient::requireNonEmpty('api_key', $apiKey);
        if ($body === '') {
            throw new SdkError('validation_error', 'body must be non-empty');
        }

        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => $this->headerLines($apiKey),
                'content' => $body,
                'ignore_errors' => true,
                'timeout' => $this->timeout,
                'protocol_version' => 1.1,
                'follow_location' => 0,
            ],
        ]);

        try {
            if ($this->requester !== null) {
                $result = ($this->requester)($this->endpoint, $context);
                if ($result instanceof TransportResponse) {
                    return $result;
                }
                if (!is_int($result)) {
                    throw new SdkError('configuration_error', 'HTTP transport requester must return a status code');
                }

                return new TransportResponse($result, 1);
            }

            return new TransportResponse($this->sendWithStreams($context), 1);
        } catch (TransportError|SdkError $error) {
            throw $error;
        } catch (Throwable $error) {
            throw TransportError::network('http transport failed: ' . $error->getMessage());
        }
    }

    /**
     * @return list<string>
     */
    private function headerLines(string $apiKey): array
    {
        $headers = [
            'content-type' => 'application/json',
            'authorization' => 'Bearer ' . $apiKey,
            'connection' => 'close',
        ];

        foreach ($this->headers as $name => $value) {
            $headers[$name] = $value;
        }

        $lines = [];
        foreach ($headers as $name => $value) {
            $lines[] = $name . ': ' . $value;
        }

        return $lines;
    }

    /**
     * @param resource $context
     */
    private function sendWithStreams($context): int
    {
        error_clear_last();
        $responseBody = @file_get_contents($this->endpoint, false, $context);
        $streamError = error_get_last();

        if (function_exists('http_get_last_response_headers')) {
            $headers = http_get_last_response_headers() ?? [];
        } else {
            $definedVariables = get_defined_vars();
            $headers = is_array($definedVariables['http_response_header'] ?? null)
                ? $definedVariables['http_response_header']
                : [];
        }
        $statusCode = $this->statusCodeFromHeaders($headers);
        if ($statusCode !== null) {
            return $statusCode;
        }

        if ($responseBody === false) {
            $message = $streamError === null
                ? 'request failed'
                : $streamError['message'];
            throw TransportError::network('http transport failed: ' . $message);
        }

        throw TransportError::network('http transport failed: missing HTTP status');
    }

    /**
     * @param list<string> $headers
     */
    private function statusCodeFromHeaders(array $headers): ?int
    {
        foreach ($headers as $header) {
            if (preg_match('/^HTTP\/\S+\s+(\d{3})\b/', $header, $matches) === 1) {
                return (int) $matches[1];
            }
        }

        return null;
    }

    private function validateEndpoint(string $endpoint): void
    {
        LogBrewClient::requireNonEmpty('endpoint', $endpoint);
        $parts = parse_url($endpoint);
        if (!is_array($parts)) {
            throw new SdkError('configuration_error', 'invalid HTTP transport endpoint');
        }

        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        $target = (string) ($parts['host'] ?? '');
        if (($scheme !== 'http' && $scheme !== 'https') || trim($target) === '') {
            throw new SdkError('configuration_error', 'HTTP transport endpoint must use http or https');
        }
    }

    private function validateTimeout(float $timeout): void
    {
        if ($timeout <= 0) {
            throw new SdkError('configuration_error', 'HTTP transport timeout must be positive');
        }
    }

    /**
     * @param array<string, string> $headers
     * @return array<string, string>
     */
    private function copyHeaders(array $headers): array
    {
        $copied = [];
        foreach ($headers as $name => $value) {
            if (trim((string) $name) === '') {
                throw new SdkError('configuration_error', 'HTTP transport header name must be non-empty');
            }
            if (!is_string($value)) {
                throw new SdkError('configuration_error', 'HTTP transport header value must be a string');
            }
            if (str_contains((string) $name, "\r") || str_contains((string) $name, "\n")) {
                throw new SdkError('configuration_error', 'HTTP transport header name must be a single line');
            }
            if (str_contains($value, "\r") || str_contains($value, "\n")) {
                throw new SdkError('configuration_error', 'HTTP transport header value must be a single line');
            }
            $copied[(string) $name] = $value;
        }

        return $copied;
    }
}
