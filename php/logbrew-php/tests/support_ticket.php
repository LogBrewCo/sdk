<?php

declare(strict_types=1);

use LogBrew\SupportTicketDraft;

$supportDraft = SupportTicketDraft::create(
    source: 'sdk',
    category: 'ingest_failure',
    title: '  PHP ingest failed  ',
    description: '  Local support draft for an explicit user handoff.  ',
    projectId: 'proj_public_123',
    environment: 'production',
    runtime: PHP_VERSION,
    framework: 'laravel',
    sdkPackage: 'logbrew/sdk',
    sdkVersion: '0.1.0',
    release: 'checkout@1.2.3',
    traceId: '4BF92F3577B34DA6A3CE929D0E0E4736',
    eventId: 'evt_issue_001',
    diagnostics: [
        'authorization' => 'Bearer lbw_ingest_secret_value',
        'endpoint' => 'https://api.example.com/v1/events?token=secret#fragment',
        'localPath' => '/Users/example/project/.env',
        'debugNote' => 'failed at https://api.example.com/v1/events?token=secret from /Users/example/project/.env',
        'runtime' => PHP_VERSION,
        'attempts' => [1, 2, 3],
        'exception' => new RuntimeException('do not include this message'),
        'nested' => [
            'cookie' => 'session=secret',
            'tokenText' => 'token=secret',
            'safe' => 'kept',
        ],
        'objectValue' => new stdClass(),
        'nan' => NAN,
    ]
);
assertTrue($supportDraft['source'] === 'sdk', 'expected support draft source');
assertTrue($supportDraft['category'] === 'ingest_failure', 'expected support draft category');
assertTrue($supportDraft['title'] === 'PHP ingest failed', 'expected support draft trimmed title');
assertTrue($supportDraft['description'] === 'Local support draft for an explicit user handoff.', 'expected support draft trimmed description');
assertTrue($supportDraft['project_id'] === 'proj_public_123', 'expected support draft project id');
assertTrue($supportDraft['sdk_package'] === 'logbrew/sdk', 'expected support draft package');
assertTrue($supportDraft['trace_id'] === '4bf92f3577b34da6a3ce929d0e0e4736', 'expected support draft normalized trace id');
$supportDiagnostics = $supportDraft['diagnostics'] ?? null;
if (!is_array($supportDiagnostics)) {
    fwrite(STDERR, 'expected support draft diagnostics object' . PHP_EOL);
    exit(1);
}
assertTrue(($supportDiagnostics['authorization'] ?? null) === '[redacted]', 'expected support draft authorization redaction');
assertTrue(($supportDiagnostics['endpoint'] ?? null) === '[redacted-url]/v1/events', 'expected support draft URL redaction');
assertTrue(($supportDiagnostics['localPath'] ?? null) === '[redacted-path]', 'expected support draft local path redaction');
assertTrue(($supportDiagnostics['debugNote'] ?? null) === 'failed at [redacted-url]/v1/events from [redacted-path]', 'expected support draft embedded URL and path redaction');
$supportException = $supportDiagnostics['exception'] ?? null;
if (!is_array($supportException)) {
    fwrite(STDERR, 'expected support draft exception object' . PHP_EOL);
    exit(1);
}
assertTrue(($supportException['type'] ?? null) === 'RuntimeException', 'expected support draft exception type only');
$supportNested = $supportDiagnostics['nested'] ?? null;
if (!is_array($supportNested)) {
    fwrite(STDERR, 'expected support draft nested diagnostics object' . PHP_EOL);
    exit(1);
}
assertTrue(($supportNested['cookie'] ?? null) === '[redacted]', 'expected support draft nested cookie redaction');
assertTrue(($supportNested['tokenText'] ?? null) === '[redacted]', 'expected support draft nested token text redaction');
assertTrue(($supportNested['safe'] ?? null) === 'kept', 'expected support draft safe nested value');
$supportJson = json_encode($supportDraft, JSON_THROW_ON_ERROR);
foreach ([
    'lbw_ingest_secret_value',
    'api.example.com',
    'token=secret',
    '/Users/example/project',
    'do not include this message',
    'objectValue',
    'nan',
] as $needle) {
    assertTrue(!str_contains($supportJson, $needle), "support draft leaked diagnostic value: {$needle}");
}
expectThrows(
    fn () => SupportTicketDraft::create(
        source: 'bot',
        category: 'ingest_failure',
        title: 'Bad source',
        description: 'Bad source'
    ),
    'support ticket source must be one of'
);
expectThrows(
    fn () => SupportTicketDraft::create(
        source: 'sdk',
        category: 'ingest_failure',
        title: 'Bad trace',
        description: 'Bad trace',
        traceId: '00000000000000000000000000000000'
    ),
    'support ticket trace_id must be 32 non-zero hex characters'
);
expectThrows(
    fn () => SupportTicketDraft::create(
        source: 'sdk',
        category: 'not_real',
        title: 'Bad category',
        description: 'Bad category'
    ),
    'support ticket category must be one of'
);
