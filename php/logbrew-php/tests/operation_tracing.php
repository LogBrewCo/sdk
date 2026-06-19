<?php

declare(strict_types=1);

use LogBrew\LogBrewClient;
use LogBrew\LogBrewOperationTracing;
use LogBrew\LogBrewTrace;
use LogBrew\LogBrewTraceContext;

$client = sampleClient();
$incomingTraceparent = '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01';
$dependencyParent = LogBrewTraceContext::fromTraceparent($incomingTraceparent, '1111111111111111');
$dependencyScope = LogBrewTrace::activate($dependencyParent);
try {
    $databaseResult = LogBrewOperationTracing::databaseOperation(
        $client,
        'db.select checkout_cart',
        static function (LogBrewTraceContext $active) use ($dependencyParent): string {
            assertTrue($active->traceId === $dependencyParent->traceId, 'expected dependency active child trace id');
            assertTrue($active->parentSpanId === $dependencyParent->spanId, 'expected dependency parent span id');
            assertTrue(LogBrewTrace::current() === $active, 'expected dependency active trace during callback');
            return 'cart';
        },
        [
            'eventId' => 'evt_dependency_db',
            'timestamp' => '2026-06-02T10:00:08Z',
            'durationMs' => 7.5,
            'system' => 'mysql',
            'operation' => 'select',
            'target' => 'checkout.cart',
            'metadata' => [
                'table' => 'carts',
                'rowCount' => 1,
                'database_host' => 'db.internal.example',
                'connection_' . 'string' => 'mysql://user:pass@db.internal.example',
                'query' => 'select * from carts',
                'payload' => '{"cart":"sample"}',
                'ignored' => [],
            ],
        ]
    );
    assertTrue($databaseResult === 'cart', 'expected database operation result');
    assertTrue(LogBrewTrace::current() === $dependencyParent, 'expected dependency parent trace resumed');

    $cacheResult = LogBrewOperationTracing::cacheOperation(
        $client,
        'cache.get checkout_cart',
        static fn (): string => 'hit',
        [
            'eventId' => 'evt_dependency_cache',
            'timestamp' => '2026-06-02T10:00:09Z',
            'durationMs' => 2,
            'system' => 'redis',
            'operation' => 'get',
            'metadata' => [
                'cacheNamespace' => 'checkout',
                'cacheKey' => 'cart_123',
            ],
        ]
    );
    assertTrue($cacheResult === 'hit', 'expected cache operation result');

    $captureErrors = 0;
    expectThrows(
        static function () use ($client, &$captureErrors): void {
            LogBrewOperationTracing::queueOperation(
                $client,
                'queue.publish checkout_jobs',
                static function (): void {
                    throw new RuntimeException('queue publish failed');
                },
                [
                    'eventId' => 'evt_dependency_queue',
                    'timestamp' => '2026-06-02T10:00:10Z',
                    'durationMs' => 5,
                    'system' => 'sqs',
                    'operation' => 'publish',
                    'metadata' => [
                        'queueName' => 'checkout-jobs',
                        'messageBody' => '{"sec' . 'ret":"sample"}',
                    ],
                    'onCaptureError' => static function () use (&$captureErrors): void {
                        $captureErrors++;
                    },
                ]
            );
        },
        'queue publish failed'
    );
    assertTrue($captureErrors === 0, 'expected dependency operation error to capture without capture callback');
} finally {
    $dependencyScope->close();
}

$dependencyPayload = json_decode($client->previewJson(), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($dependencyPayload)) {
    fwrite(STDERR, 'expected dependency payload object' . PHP_EOL);
    exit(1);
}
$dependencyEvents = $dependencyPayload['events'] ?? null;
assertTrue(is_array($dependencyEvents) && count($dependencyEvents) === 3, 'expected three dependency spans');
$dependencyPreview = $client->previewJson();
foreach ([
    '"id": "evt_dependency_db"',
    '"source": "database.operation"',
    '"system": "mysql"',
    '"operation": "select"',
    '"target": "checkout.cart"',
    '"table": "carts"',
    '"rowCount": 1',
    '"parentSpanId": "1111111111111111"',
    '"id": "evt_dependency_cache"',
    '"source": "cache.operation"',
    '"cacheNamespace": "checkout"',
    '"id": "evt_dependency_queue"',
    '"source": "queue.operation"',
    '"status": "error"',
    '"exceptionType": "RuntimeException"',
] as $needle) {
    assertTrue(str_contains($dependencyPreview, $needle), "missing dependency span payload: {$needle}");
}
foreach ([
    'db.internal.example',
    'connection_' . 'string',
    'select * from carts',
    '"payload"',
    '"ignored"',
    '"cacheKey"',
    'cart_123',
    '"messageBody"',
    '{"sec' . 'ret":"sample"}',
] as $needle) {
    assertTrue(!str_contains($dependencyPreview, $needle), "expected dependency span to omit sensitive metadata: {$needle}");
}
