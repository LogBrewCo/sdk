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
use LogBrew\LogBrewWorkerLifecycle;
use LogBrew\RecordingTransport;
use LogBrew\WorkerDeliveryFailure;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'checkout-worker', '1.0.0');
$transport = RecordingTransport::alwaysAccept();
$deliveryFailureCodes = [];
$lifecycle = LogBrewWorkerLifecycle::create(
    $client,
    $transport,
    static function (WorkerDeliveryFailure $failure) use (&$deliveryFailureCodes): void {
        $deliveryFailureCodes[] = $failure->codeName;
    }
);

$workResult = $lifecycle->run(static function () use ($client): string {
    $client->log('evt_job_001', '2026-07-12T14:00:00Z', [
        'message' => 'checkout job completed',
        'level' => 'info',
        'logger' => 'checkout-worker',
    ]);

    return 'job-result';
});

$shutdown = $lifecycle->shutdown();

echo json_encode([
    'workResult' => $workResult,
    'requests' => count($transport->sentBodies),
    'deliveryFailureCodes' => $deliveryFailureCodes,
    'shutdownStatus' => $shutdown->statusCode,
], JSON_THROW_ON_ERROR) . PHP_EOL;
