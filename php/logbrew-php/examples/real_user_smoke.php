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
use LogBrew\RecordingTransport;
use LogBrew\SupportTicketDraft;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0');
$client->release('evt_release_001', '2026-06-02T10:00:00Z', [
    'version' => '1.2.3',
    'commit' => 'abc123def456',
    'notes' => 'Public release marker',
]);
$client->environment('evt_environment_001', '2026-06-02T10:00:01Z', [
    'name' => 'production',
    'region' => 'global',
]);
$client->issue('evt_issue_001', '2026-06-02T10:00:02Z', [
    'title' => 'Checkout timeout',
    'level' => 'error',
    'message' => 'Request timed out after retry budget',
]);
$client->log('evt_log_001', '2026-06-02T10:00:03Z', [
    'message' => 'worker started',
    'level' => 'info',
    'logger' => 'job-runner',
]);
$client->span('evt_span_001', '2026-06-02T10:00:04Z', [
    'name' => 'GET /health',
    'traceId' => 'trace_001',
    'spanId' => 'span_001',
    'status' => 'ok',
    'durationMs' => 12.5,
]);
$client->action('evt_action_001', '2026-06-02T10:00:05Z', [
    'name' => 'deploy',
    'status' => 'success',
]);

echo $client->previewJson() . PHP_EOL;

$transport = RecordingTransport::alwaysAccept();
$response = $client->shutdown($transport);
$supportDraft = SupportTicketDraft::create(
    source: 'sdk',
    category: 'ingest_failure',
    title: 'PHP ingest failed',
    description: 'Local support draft for an explicit user handoff.',
    environment: 'production',
    runtime: PHP_VERSION,
    framework: 'php',
    sdkPackage: 'logbrew/sdk',
    sdkVersion: '0.1.0',
    release: 'checkout@1.2.3',
    traceId: '4BF92F3577B34DA6A3CE929D0E0E4736',
    eventId: 'evt_issue_001',
    diagnostics: [
        'authorization' => 'Bearer lbw_ingest_secret_value',
        'endpoint' => 'https://api.example.com/v1/events?token=secret#fragment',
        'exception' => new RuntimeException('do not include this message'),
    ],
);
$supportDiagnostics = $supportDraft['diagnostics'] ?? [];
if (!is_array($supportDiagnostics)) {
    $supportDiagnostics = [];
}
fwrite(STDERR, json_encode([
    'ok' => true,
    'status' => $response->statusCode,
    'attempts' => $response->attempts,
    'events' => 6,
    'supportDraftRedacted' => ($supportDiagnostics['authorization'] ?? null) === '[redacted]',
    'supportDraftTrace' => $supportDraft['trace_id'],
], JSON_THROW_ON_ERROR) . PHP_EOL);
