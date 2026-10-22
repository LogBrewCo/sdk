<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use LogBrew\EncryptedFileEventStore;
use LogBrew\LogBrewClient;

// The app that drops an event and exits without shutdown.
// tests/persistent_client_report.php starts it and restarts the app in another process.
$directory = $argv[1] ?? '';
$key = hex2bin($argv[2] ?? '');
if ($directory === '' || !is_string($key)) {
    fwrite(STDERR, 'usage: persistent_client_report_child.php <directory> <hex key>' . PHP_EOL);
    exit(2);
}
$client = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    maxQueueSize: 1,
    eventStore: EncryptedFileEventStore::open($directory, $key),
    captureRuntimeContext: false
);
$client->log('evt_child_1', '2026-07-15T10:00:00Z', ['message' => 'queued', 'level' => 'info']);
$client->log('evt_child_2', '2026-07-15T10:00:01Z', ['message' => 'dropped', 'level' => 'info']);
exit(0);
