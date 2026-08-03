<?php

declare(strict_types=1);

$autoloadCandidates = [
    __DIR__ . '/../vendor/autoload.php',
    __DIR__ . '/../../../autoload.php',
];

$autoloadPath = null;
foreach ($autoloadCandidates as $candidate) {
    if (is_file($candidate)) {
        $autoloadPath = $candidate;
        break;
    }
}

if ($autoloadPath === null) {
    fwrite(STDERR, "unable to locate Composer autoload.php for the example\n");
    exit(1);
}

require $autoloadPath;

use LogBrew\LogBrewClient;
use LogBrew\LogBrewTelemetry;
use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTraceContext;
use LogBrew\ProductTimeline;
use LogBrew\RecordingTransport;
use LogBrew\TelemetryContext;
use LogBrew\TelemetryResource;
use LogBrew\Traceparent;
use LogBrew\TraceparentSpanInput;

$incomingTraceparent = '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01';
$traceContext = Traceparent::parse($incomingTraceparent);
$childSpanId = 'b7ad6b7169203331';
$requestTrace = LogBrewTraceContext::fromTraceparent($incomingTraceparent, $childSpanId);
$outgoingHeaders = $requestTrace->headers();
$sessionId = 'sess_checkout_123';
$routeTemplate = '/checkout/:cart_id';

$clientContext = TelemetryContext::create()
    ->withResource(
        TelemetryResource::create()
            ->withService('checkout-service', '1.2.3')
            ->withDeployment('production', 'checkout@1.2.3')
            ->withApplication('checkout', '1.2.3', '20260602.1')
            ->build()
    )
    ->build();
$client = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'checkout-service',
    '1.2.3',
    context: $clientContext
);
$client->release('evt_release_checkout', '2026-06-02T10:00:00Z', [
    'version' => '1.2.3',
    'commit' => 'abc123def456',
]);
$client->environment('evt_environment_checkout', '2026-06-02T10:00:01Z', [
    'name' => 'production',
    'region' => 'global',
]);

$requestContext = TelemetryContext::create()
    ->withSession($sessionId)
    ->withSubject('visitor_checkout_123', 'anonymous')
    ->withTag('journey', 'checkout')
    ->withTag('region', 'global')
    ->build();
$contextScope = LogBrewTelemetry::activateContext($requestContext);
$traceScope = LogBrewTrace::activate($requestTrace);
try {
    $client->log('evt_log_checkout_started', '2026-06-02T10:00:02Z', [
        'message' => 'checkout request started',
        'level' => 'info',
        'logger' => 'checkout',
        'metadata' => ['routeTemplate' => $routeTemplate],
    ]);
    $client->action('evt_action_checkout_submit', '2026-06-02T10:00:03Z', ProductTimeline::productAction(
        name: 'checkout.submit',
        routeTemplate: 'https://shop.example/checkout/:cart_id?coupon=sample#review',
        screen: 'Checkout',
        funnel: 'checkout',
        step: 'submit',
        metadata: ['cartTier' => 'gold']
    ));
    $client->action('evt_action_payment_api', '2026-06-02T10:00:04Z', ProductTimeline::networkMilestone(
        routeTemplate: 'https://api.example/payments/:payment_id?card=sample',
        method: 'post',
        statusCode: 202,
        durationMs: 183.4,
        metadata: ['dependency' => 'payments']
    ));
    $client->metric('evt_metric_http_server_duration', '2026-06-02T10:00:05Z', [
        'name' => 'http.server.duration',
        'kind' => 'histogram',
        'value' => 183.4,
        'unit' => 'ms',
        'temporality' => 'delta',
        'metadata' => [
            'method' => 'POST',
            'routeTemplate' => $routeTemplate,
            'statusCode' => 202,
        ],
    ]);
    $client->span('evt_span_checkout_request', '2026-06-02T10:00:06Z', Traceparent::spanAttributesFromTraceparent(
        $traceContext,
        TraceparentSpanInput::create('POST /checkout/:cart_id', $childSpanId)
            ->withDurationMs(183.4)
            ->withMetadata(['routeTemplate' => $routeTemplate])
    ));
} finally {
    $traceScope->close();
    $contextScope->close();
}

echo $client->previewJson() . PHP_EOL;

$transport = RecordingTransport::alwaysAccept();
$response = $client->shutdown($transport);
fwrite(STDERR, json_encode([
    'ok' => true,
    'status' => $response->statusCode,
    'attempts' => $response->attempts,
    'events' => 7,
    'outgoingTraceparent' => $outgoingHeaders['traceparent'],
], JSON_THROW_ON_ERROR) . PHP_EOL);
