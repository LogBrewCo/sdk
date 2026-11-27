<?php

declare(strict_types=1);

use LogBrew\LogBrewClient;
use LogBrew\Transport;
use LogBrew\TransportResponse;

final class ServerApiKeyRecordingTransport implements Transport
{
    /** @var list<string> */
    public array $apiKeys = [];

    public function send(string $apiKey, string $body): TransportResponse
    {
        $this->apiKeys[] = $apiKey;

        return new TransportResponse(202, 1);
    }
}

/**
 * @return list<string>
 */
function serverApiKeysSent(?string $explicitKey): array
{
    $client = LogBrewClient::create($explicitKey, 'logbrew-php-test', '1.0.0');
    $client->log('evt_server_key_001', '2026-11-27T10:00:00Z', ['message' => 'first event', 'level' => 'info']);
    $transport = new ServerApiKeyRecordingTransport();
    $client->flush($transport);

    return $transport->apiKeys;
}

function withServerApiKey(string $value, callable $callback): void
{
    $previous = [$_SERVER['LOGBREW_SERVER_API_KEY'] ?? null, $_ENV['LOGBREW_SERVER_API_KEY'] ?? null, getenv('LOGBREW_SERVER_API_KEY')];
    unset($_SERVER['LOGBREW_SERVER_API_KEY'], $_ENV['LOGBREW_SERVER_API_KEY']);
    putenv('LOGBREW_SERVER_API_KEY=' . $value);
    try {
        $callback();
    } finally {
        [$server, $env, $process] = $previous;
        if ($server !== null) {
            $_SERVER['LOGBREW_SERVER_API_KEY'] = $server;
        }
        if ($env !== null) {
            $_ENV['LOGBREW_SERVER_API_KEY'] = $env;
        }
        putenv($process === false ? 'LOGBREW_SERVER_API_KEY' : 'LOGBREW_SERVER_API_KEY=' . $process);
    }
}

withServerApiKey('env-server-key', static function (): void {
    assertTrue(serverApiKeysSent(null) === ['env-server-key'], 'client without key sends with LOGBREW_SERVER_API_KEY');
    assertTrue(serverApiKeysSent('explicit-key') === ['explicit-key'], 'explicit key wins over LOGBREW_SERVER_API_KEY');
});

withServerApiKey(' ', static function (): void {
    expectSdkError(
        static fn () => LogBrewClient::create(null, 'logbrew-php-test', '1.0.0'),
        'configuration_error',
        'LOGBREW_SERVER_API_KEY'
    );
});
