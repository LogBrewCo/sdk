<?php

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use LogBrew\EncryptedFileEventStore;
use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;

// This local example uses an ephemeral key. Production workers should load a
// stable 32-byte key from application configuration instead.
$parent = sys_get_temp_dir() . '/logbrew-php-persistent-example-' . bin2hex(random_bytes(8));
if (!mkdir($parent, 0700) || !chmod($parent, 0700)) {
    throw new RuntimeException('could not create the local example directory');
}
$resolvedParent = realpath($parent);
if ($resolvedParent === false) {
    throw new RuntimeException('could not resolve the local example directory');
}
$queueDirectory = $resolvedParent . '/worker-0';
$key = random_bytes(32);

$store = EncryptedFileEventStore::open($queueDirectory, $key);
$client = LogBrewClient::create(
    apiKey: 'LOGBREW_API_KEY',
    sdkName: 'php-persistent-worker-example',
    sdkVersion: '1.0.0',
    eventStore: $store
);
$client->log('evt_worker_restart', '2026-07-14T08:00:00Z', [
    'message' => 'worker will retry after restart',
    'level' => 'warning',
    'logger' => 'checkout-worker',
]);
$store->close();
unset($client, $store);

$store = EncryptedFileEventStore::open($queueDirectory, $key);
$client = LogBrewClient::create(
    apiKey: 'LOGBREW_API_KEY',
    sdkName: 'php-persistent-worker-example',
    sdkVersion: '1.0.0',
    eventStore: $store
);
$recoveredEvents = $client->pendingEvents();
$transport = RecordingTransport::alwaysAccept();
$client->shutdown($transport);
$payload = json_decode($transport->sentBodies[0] ?? '{}', true, 512, JSON_THROW_ON_ERROR);
if (!is_array($payload)) {
    throw new RuntimeException('recorded payload must be an object');
}
$events = $payload['events'] ?? null;
$deliveredEvents = is_array($events) ? count($events) : 0;

fwrite(STDOUT, json_encode([
    'recoveredEvents' => $recoveredEvents,
    'deliveredEvents' => $deliveredEvents,
    'pendingEvents' => $client->pendingEvents(),
], JSON_THROW_ON_ERROR) . PHP_EOL);

$entries = scandir($queueDirectory);
if (!is_array($entries)) {
    throw new RuntimeException('could not clean the local example directory');
}
foreach ($entries as $entry) {
    if ($entry !== '.' && $entry !== '..') {
        unlink($queueDirectory . '/' . $entry);
    }
}
rmdir($queueDirectory);
rmdir($resolvedParent);
