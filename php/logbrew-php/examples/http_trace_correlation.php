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
use LogBrew\LogBrewHttpRequestTelemetry;
use LogBrew\LogBrewPsrLogger;
use LogBrew\LogBrewTrace;
use LogBrew\ProductTimeline;
use LogBrew\RecordingTransport;
use Psr\Log\LogLevel;

$incomingTraceparent = '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01';
$client = LogBrewClient::create('LOGBREW_API_KEY', 'checkout-php-service', '1.4.2');
$request = LogBrewHttpRequestTelemetry::start(
    $client,
    'POST',
    'https://shop.example/checkout/:cart_id?coupon=sample#review',
    $incomingTraceparent
);
$logger = new LogBrewPsrLogger(
    client: $client,
    loggerName: 'checkout.trace',
    eventIdPrefix: 'php_http_trace',
    timestampProvider: static fn (): DateTimeImmutable => new DateTimeImmutable('2026-06-02T10:00:03+00:00')
);

$client->release('evt_release_checkout_http_trace', '2026-06-02T10:00:00Z', [
    'version' => '1.4.2',
    'commit' => 'abc123def456',
    'metadata' => ['service' => 'checkout'],
]);
$client->environment('evt_environment_checkout_http_trace', '2026-06-02T10:00:01Z', [
    'name' => 'production',
    'region' => 'global',
]);

$scope = $request->activate();
try {
    $logger->log(LogLevel::WARNING, 'checkout slow for {cartId}', [
        'cartId' => 'cart_123',
        'ignoredContext' => [],
    ]);

    $client->issue('evt_issue_checkout_trace', '2026-06-02T10:00:04Z', [
        'title' => 'Checkout handler failed',
        'level' => 'error',
        'message' => 'payment provider failed',
        'metadata' => LogBrewTrace::metadataWithCurrentTrace([
            'routeTemplate' => $request->routeTemplate,
            'exceptionType' => RuntimeException::class,
            'exceptionMessage' => 'payment provider failed',
            'ignored' => [],
        ]),
    ]);

    $client->action('evt_action_checkout_trace', '2026-06-02T10:00:05Z', ProductTimeline::productAction(
        name: 'checkout.submit',
        routeTemplate: 'https://shop.example/checkout/:cart_id?coupon=sample#review',
        sessionId: 'sess_checkout_123',
        traceId: $request->trace->traceId,
        screen: 'Checkout',
        funnel: 'checkout',
        step: 'submit',
        metadata: ['cartTier' => 'gold']
    ));
} finally {
    $scope->close();
}

$request->finishSpanAndMetric(
    'evt_span_checkout_trace',
    'evt_metric_checkout_trace',
    '2026-06-02T10:00:06Z',
    503,
    ['cartTier' => 'gold']
);

echo $client->previewJson() . PHP_EOL;

$response = $client->shutdown(RecordingTransport::alwaysAccept());
fwrite(STDERR, json_encode([
    'ok' => true,
    'status' => $response->statusCode,
    'attempts' => $response->attempts,
    'events' => 7,
    'outgoingTraceparent' => $request->outgoingHeaders()['traceparent'],
], JSON_THROW_ON_ERROR) . PHP_EOL);
