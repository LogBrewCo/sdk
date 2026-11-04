<?php

declare(strict_types=1);

require getenv('LOGBREW_CAPTURE_WORK') . '/vendor/autoload.php';

use LogBrew\HttpTransport;
use LogBrew\IssueDiagnostics;
use LogBrew\LogBrewClient;
use LogBrew\LogBrewHttpRequestTelemetry;
use LogBrew\LogBrewPsrLogger;
use LogBrew\LogBrewTelemetry;
use LogBrew\TelemetryContext;
use LogBrew\TelemetryResource;

function now(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
}

$client = LogBrewClient::create(
    'LOGBREW_SERVER_API_KEY',
    'checkout-api',
    '1.2.3',
    context: TelemetryContext::create()
        ->withResource(TelemetryResource::create()->withService('checkout-api')->withDeployment('production', 'checkout@1.2.3')->build())
        ->build()
);
$logger = new LogBrewPsrLogger($client, loggerName: 'checkout');
$failing = str_starts_with($_SERVER['REQUEST_URI'], '/fail/');
$request = LogBrewHttpRequestTelemetry::start(
    $client,
    $_SERVER['REQUEST_METHOD'],
    $failing ? '/fail/:cart_id' : '/checkout/:cart_id',
    $_SERVER['HTTP_TRACEPARENT'] ?? null
);
$status = 200;
$userScope = LogBrewTelemetry::activateContext(TelemetryContext::create()->withSubject('user_123', 'user')->build());
$traceScope = $request->activate();
try {
    $logger->info('checkout started');
    try {
        if ($failing) {
            $logger->warning('payment step failing');
            throw new RuntimeException('payment declined');
        }
        echo '{"ok":true}';
    } catch (RuntimeException $error) {
        $status = 500;
        $client->issue('evt_issue_' . bin2hex(random_bytes(8)), now(), IssueDiagnostics::fromThrowable($error, mechanismType: 'php.request', handled: false));
    }
} finally {
    $traceScope->close();
    $userScope->close();
}
http_response_code($status);
$request->finishSpanAndMetric('evt_span_' . bin2hex(random_bytes(8)), 'evt_metric_' . bin2hex(random_bytes(8)), now(), $status);
$client->shutdown(new HttpTransport(endpoint: getenv('LOGBREW_CAPTURE_ENDPOINT')));
