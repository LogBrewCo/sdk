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

use LogBrew\IssueDiagnostics;
use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;

final class CheckoutFailureFixture
{
    public static function fail(): never
    {
        throw new RuntimeException('sensitive provider response fixture');
    }
}

$client = LogBrewClient::create('LOGBREW_API_KEY', 'checkout-php-service', '1.4.2');
$breadcrumbs = [
    IssueDiagnostics::breadcrumb(
        timestamp: '2026-08-02T10:14:58.125+00:00',
        category: 'checkout.navigation',
        type: 'navigation',
        level: 'info',
        message: 'User reached payment review',
        data: ['step' => 'payment']
    ),
    IssueDiagnostics::breadcrumb(
        timestamp: '2026-08-02T10:14:59Z',
        category: 'checkout.request',
        type: 'http',
        level: 'warn',
        data: ['method' => 'POST', 'statusCode' => 503]
    ),
];

try {
    CheckoutFailureFixture::fail();
} catch (Throwable $error) {
    $client->issue(
        'evt_issue_checkout_failure',
        '2026-08-02T10:15:00Z',
        IssueDiagnostics::fromThrowable(
            $error,
            message: 'Checkout could not be completed.',
            mechanismType: 'php.exception',
            handled: true,
            metadata: ['routeTemplate' => '/checkout/:cart_id'],
            breadcrumbs: $breadcrumbs
        )
    );
}

echo $client->previewJson() . PHP_EOL;

$response = $client->shutdown(RecordingTransport::alwaysAccept());
fwrite(STDERR, json_encode([
    'ok' => true,
    'status' => $response->statusCode,
    'events' => 1,
], JSON_THROW_ON_ERROR) . PHP_EOL);
