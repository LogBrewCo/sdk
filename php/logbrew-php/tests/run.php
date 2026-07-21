<?php

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use LogBrew\ActionAttributes;
use LogBrew\HttpTransport;
use LogBrew\LogBrewClient;
use LogBrew\LogBrewMonologHandler;
use LogBrew\LogBrewPsrLogger;
use LogBrew\ProductTimeline;
use LogBrew\RecordingTransport;
use LogBrew\SdkError;
use LogBrew\Traceparent;
use LogBrew\TraceparentSpanInput;
use LogBrew\TransportError;
use Monolog\LogRecord;
use Monolog\Logger as MonologLogger;
use Psr\Log\LogLevel;

function assertTrue(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, $message . PHP_EOL);
        exit(1);
    }
}

function expectThrows(callable $callback, string $needle): void
{
    try {
        $callback();
    } catch (Throwable $error) {
        assertTrue(str_contains($error->getMessage(), $needle), "expected exception containing: {$needle}");
        return;
    }

    fwrite(STDERR, "expected exception not thrown: {$needle}" . PHP_EOL);
    exit(1);
}

/**
 * @param list<string> $command
 * @return array{stdout: string, stderr: string}
 */
function runCommand(string $cwd, array $command): array
{
    $descriptorSpec = [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];

    $process = proc_open($command, $descriptorSpec, $pipes, $cwd);
    if (!is_resource($process)) {
        fwrite(STDERR, 'expected process to start' . PHP_EOL);
        exit(1);
    }

    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[2]);

    $exitCode = proc_close($process);
    assertTrue($exitCode === 0, 'expected command to succeed: ' . implode(' ', $command) . PHP_EOL . $stderr);

    return [
        'stdout' => $stdout === false ? '' : $stdout,
        'stderr' => $stderr === false ? '' : $stderr,
    ];
}

final class LocalHttpIntake
{
    public readonly string $endpoint;

    private readonly string $dir;

    private readonly string $script;

    /** @var resource */
    private $process;

    /** @var array<int, resource> */
    private array $pipes;

    /** @param list<int> $statuses */
    public function __construct(array $statuses)
    {
        $this->dir = sys_get_temp_dir() . '/logbrew-php-http-' . bin2hex(random_bytes(6));
        if (!mkdir($this->dir) && !is_dir($this->dir)) {
            throw new RuntimeException('failed to create local HTTP intake dir');
        }
        $this->script = $this->dir . '/server.php';
        file_put_contents($this->script, <<<'PHP'
<?php

declare(strict_types=1);

$statuses = array_map('intval', explode(',', $argv[1]));
$dir = $argv[2];
$server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
if ($server === false) {
    file_put_contents($dir . '/server-error.txt', sprintf('%d %s', $errno, $errstr));
    exit(1);
}
$socketName = stream_socket_get_name($server, false);
if (!is_string($socketName)) {
    file_put_contents($dir . '/server-error.txt', 'failed to read local socket name');
    exit(1);
}
file_put_contents($dir . '/endpoint.txt', 'http://' . $socketName . '/v1/events');

for ($index = 0; $index < count($statuses); $index++) {
    $connection = stream_socket_accept($server, 15);
    if ($connection === false) {
        file_put_contents($dir . '/server-error.txt', 'timed out waiting for request');
        exit(1);
    }
    stream_set_timeout($connection, 5);

    $head = '';
    while (($line = fgets($connection)) !== false) {
        $head .= $line;
        if (rtrim($line, "\r\n") === '') {
            break;
        }
    }

    $contentLength = 0;
    foreach (preg_split('/\r?\n/', trim($head)) ?: [] as $line) {
        if (stripos($line, 'content-length:') === 0) {
            $contentLength = (int) trim(substr($line, strlen('content-length:')));
        }
    }

    $body = '';
    while (strlen($body) < $contentLength && !feof($connection)) {
        $chunk = fread($connection, $contentLength - strlen($body));
        if ($chunk === false || $chunk === '') {
            break;
        }
        $body .= $chunk;
    }

    file_put_contents($dir . '/request-' . $index . '.txt', $head . "\n--BODY--\n" . $body);

    $status = $statuses[$index];
    $reason = $status >= 500 ? 'Service Unavailable' : 'Accepted';
    fwrite($connection, "HTTP/1.1 {$status} {$reason}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    fclose($connection);
}

fclose($server);
PHP);

        $descriptorSpec = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];
        $process = proc_open([PHP_BINARY, $this->script, implode(',', $statuses), $this->dir], $descriptorSpec, $pipes);
        if (!is_resource($process)) {
            throw new RuntimeException('failed to start local HTTP intake');
        }
        fclose($pipes[0]);
        $this->process = $process;
        $this->pipes = $pipes;

        $endpointFile = $this->dir . '/endpoint.txt';
        for ($attempt = 0; $attempt < 100; $attempt++) {
            if (is_file($endpointFile)) {
                $endpoint = file_get_contents($endpointFile);
                if (is_string($endpoint) && trim($endpoint) !== '') {
                    $this->endpoint = trim($endpoint);
                    return;
                }
            }
            usleep(50_000);
        }

        $message = is_file($this->dir . '/server-error.txt')
            ? (string) file_get_contents($this->dir . '/server-error.txt')
            : 'local HTTP intake did not start';
        $this->close();
        throw new RuntimeException($message);
    }

    public function close(): void
    {
        if (is_resource($this->process)) {
            $status = proc_get_status($this->process);
            if ($status['running']) {
                proc_terminate($this->process);
            }
            foreach ($this->pipes as $pipe) {
                if (is_resource($pipe)) {
                    fclose($pipe);
                }
            }
            proc_close($this->process);
        }
        $this->removeDirectory($this->dir);
    }

    /**
     * @return list<array{method:string,target:string,headers:array<string, string>,body:string}>
     */
    public function requests(): array
    {
        $files = glob($this->dir . '/request-*.txt');
        if ($files === false) {
            return [];
        }
        sort($files, SORT_STRING);

        $requests = [];
        foreach ($files as $file) {
            $content = file_get_contents($file);
            if (!is_string($content)) {
                continue;
            }
            $parts = explode("\n--BODY--\n", $content, 2);
            $head = $parts[0] ?? '';
            $body = $parts[1] ?? '';
            $lines = preg_split('/\r?\n/', trim($head)) ?: [];
            $requestLine = array_shift($lines) ?? '';
            $requestParts = explode(' ', $requestLine, 3);
            $headers = [];
            foreach ($lines as $line) {
                $position = strpos($line, ':');
                if ($position === false) {
                    continue;
                }
                $headers[strtolower(substr($line, 0, $position))] = trim(substr($line, $position + 1));
            }
            $requests[] = [
                'method' => $requestParts[0] ?? '',
                'target' => $requestParts[1] ?? '',
                'headers' => $headers,
                'body' => $body,
            ];
        }

        return $requests;
    }

    private function removeDirectory(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $items = scandir($dir);
        if (!is_array($items)) {
            return;
        }
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $path = $dir . DIRECTORY_SEPARATOR . $item;
            if (is_dir($path)) {
                $this->removeDirectory($path);
                continue;
            }
            unlink($path);
        }
        rmdir($dir);
    }
}

function sampleClient(): LogBrewClient
{
    return LogBrewClient::create('LOGBREW_API_KEY', 'logbrew-php', '0.1.0', 2);
}

function enqueueAll(LogBrewClient $client): void
{
    $client->release('evt_release_001', '2026-06-02T10:00:00Z', [
        'version' => '1.2.3',
        'commit' => 'abc123def456',
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
}

$client = sampleClient();
enqueueAll($client);
$payload = json_decode($client->previewJson(), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($payload)) {
    fwrite(STDERR, 'expected preview payload object' . PHP_EOL);
    exit(1);
}
$events = $payload['events'] ?? null;
if (!is_array($events)) {
    fwrite(STDERR, 'expected preview payload events array' . PHP_EOL);
    exit(1);
}
assertTrue(count($events) === 6, 'expected full event batch');

$client = sampleClient();
enqueueAll($client);
$transport = RecordingTransport::alwaysAccept();
$response = $client->flush($transport);
assertTrue($response->statusCode === 202, 'expected successful flush');
assertTrue($response->attempts === 1, 'expected one attempt');
assertTrue($client->pendingEvents() === 0, 'expected queue cleared');

expectThrows(
    fn () => sampleClient()->log('evt_log_001', '2026-06-02T10:00:03', ['message' => 'worker started', 'level' => 'info']),
    'timestamp must be a valid RFC3339 date-time'
);
expectThrows(
    static function (): void {
        $method = new ReflectionMethod(LogBrewClient::class, 'issue');
        $method->invoke(sampleClient(), 'evt_issue_001', '2026-06-02T10:00:02Z', [
            'title' => 'Checkout timeout',
            'level' => 'verbose',
        ]);
    },
    'issue level must be one of'
);
$client = sampleClient();
$client->issue('evt_issue_alias', '2026-06-02T10:00:02Z', ['title' => 'Checkout timeout', 'level' => 'fatal']);
$client->log('evt_log_debug', '2026-06-02T10:00:03Z', ['message' => 'verbose runtime detail', 'level' => 'debug']);
$client->log('evt_log_warn', '2026-06-02T10:00:04Z', ['message' => 'legacy warning alias', 'level' => 'warn']);
$preview = $client->previewJson();
foreach (['"level": "critical"', '"level": "info"', '"level": "warning"'] as $needle) {
    assertTrue(str_contains($preview, $needle), "missing severity alias normalization: {$needle}");
}
expectThrows(
    fn () => sampleClient()->span('evt_span_001', '2026-06-02T10:00:04Z', ['name' => 'GET /health', 'traceId' => 'trace_001', 'spanId' => 'span_001', 'status' => 'ok', 'durationMs' => -1]),
    'span durationMs must be non-negative'
);

$incomingTraceparent = '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01';
$traceContext = Traceparent::parse($incomingTraceparent);
assertTrue($traceContext->version === '00', 'expected traceparent version');
assertTrue($traceContext->traceId === '4bf92f3577b34da6a3ce929d0e0e4736', 'expected normalized trace id');
assertTrue($traceContext->parentSpanId === '00f067aa0ba902b7', 'expected normalized parent span id');
assertTrue($traceContext->traceFlags === '01', 'expected normalized trace flags');
assertTrue($traceContext->sampled === true, 'expected sampled trace flag');
assertTrue(
    Traceparent::create('4BF92F3577B34DA6A3CE929D0E0E4736', 'B7AD6B7169203331') === '00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01',
    'expected normalized outgoing traceparent'
);
$outgoingHeaders = Traceparent::createHeaders($traceContext->traceId, 'b7ad6b7169203331');
assertTrue($outgoingHeaders === ['traceparent' => '00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01'], 'expected outgoing traceparent headers');
$traceMetadata = ['sampled' => $traceContext->sampled, 'routeTemplate' => '/checkout/:cart_id'];
$spanInput = TraceparentSpanInput::create('POST /checkout/:cart_id', 'B7AD6B7169203331')
    ->withDurationMs(42.5)
    ->withMetadata($traceMetadata);
$traceMetadata['routeTemplate'] = '/mutated';
$spanAttributes = Traceparent::spanAttributesFromTraceparent($traceContext, $spanInput);
assertTrue($spanAttributes['traceId'] === '4bf92f3577b34da6a3ce929d0e0e4736', 'expected traceparent span trace id');
assertTrue($spanAttributes['spanId'] === 'b7ad6b7169203331', 'expected traceparent span child span id');
assertTrue(($spanAttributes['parentSpanId'] ?? null) === '00f067aa0ba902b7', 'expected traceparent span parent id');
assertTrue(($spanAttributes['metadata']['sampled'] ?? null) === true, 'expected traceparent span sampled metadata');
assertTrue(($spanAttributes['metadata']['routeTemplate'] ?? null) === '/checkout/:cart_id', 'expected traceparent span metadata copy');
$client = sampleClient();
$client->span('evt_span_traceparent', '2026-06-02T10:00:04Z', $spanAttributes);
$tracePreview = $client->previewJson();
foreach ([
    '"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"',
    '"spanId": "b7ad6b7169203331"',
    '"parentSpanId": "00f067aa0ba902b7"',
    '"sampled": true',
] as $needle) {
    assertTrue(str_contains($tracePreview, $needle), "missing traceparent span payload: {$needle}");
}
expectThrows(
    fn () => Traceparent::parse('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
    'traceparent version must be two hex characters and not ff'
);
expectThrows(
    fn () => Traceparent::parse('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
    'traceparent trace id must be 32 non-zero hex characters'
);
expectThrows(
    fn () => Traceparent::parse('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'),
    'traceparent parent span id must be 16 non-zero hex characters'
);
expectThrows(
    fn () => Traceparent::create('4bf92f3577b34da6a3ce929d0e0e4736', '0000000000000000'),
    'traceparent span id must be 16 non-zero hex characters'
);
expectThrows(
    fn () => Traceparent::create('4bf92f3577b34da6a3ce929d0e0e4736', 'b7ad6b7169203331', 'zz'),
    'traceparent flags must be two hex characters'
);
expectThrows(
    fn () => TraceparentSpanInput::create('POST /checkout/:cart_id', 'b7ad6b7169203331', 'done'),
    'span status must be one of'
);
expectThrows(
    fn () => TraceparentSpanInput::create('POST /checkout/:cart_id', 'b7ad6b7169203331')->withDurationMs(NAN),
    'span durationMs must be a finite number'
);
expectThrows(
    fn () => TraceparentSpanInput::create('POST /checkout/:cart_id', 'b7ad6b7169203331')->withMetadata(['bad' => []]),
    'metadata value for bad must be a string, number, boolean, or null'
);

require __DIR__ . '/operation_tracing.php';
require __DIR__ . '/support_ticket.php';
require __DIR__ . '/bounded_queue.php';
require __DIR__ . '/bounded_batching.php';

$client = sampleClient();
$client->metric('evt_metric_001', '2026-06-02T10:00:06Z', [
    'name' => 'queue.depth',
    'kind' => 'gauge',
    'value' => -2.0,
    'unit' => '{items}',
    'temporality' => 'instant',
    'metadata' => ['service' => 'worker', 'queue' => 'default'],
]);
$metricPreview = $client->previewJson();
assertTrue($client->pendingEvents() === 1, 'expected metric event to queue');
foreach ([
    '"type": "metric"',
    '"name": "queue.depth"',
    '"kind": "gauge"',
    '"value": -2',
    '"unit": "{items}"',
    '"temporality": "instant"',
    '"queue": "default"',
] as $needle) {
    assertTrue(str_contains($metricPreview, $needle), "missing metric payload: {$needle}");
}
expectThrows(
    fn () => sampleClient()->metric('evt_metric_invalid_value', '2026-06-02T10:00:06Z', [
        'name' => 'queue.depth',
        'kind' => 'gauge',
        'value' => NAN,
        'unit' => '{items}',
        'temporality' => 'instant',
    ]),
    'metric value must be a finite number'
);
expectThrows(
    fn () => sampleClient()->metric('evt_metric_invalid_counter', '2026-06-02T10:00:06Z', [
        'name' => 'jobs.completed',
        'kind' => 'counter',
        'value' => -1,
        'unit' => '1',
        'temporality' => 'delta',
    ]),
    'metric counter value must be non-negative'
);
expectThrows(
    fn () => sampleClient()->metric('evt_metric_invalid_temporality', '2026-06-02T10:00:06Z', [
        'name' => 'queue.depth',
        'kind' => 'gauge',
        'value' => 2,
        'unit' => '{items}',
        'temporality' => 'delta',
    ]),
    'metric temporality for gauge must be one of'
);

$productMetadata = [
    'cartTier' => 'gold',
    'attempt' => 2,
    'routeTemplate' => '/raw?debug=sample',
];
$client = sampleClient();
$client->action('evt_product_timeline', '2026-06-02T10:00:05Z', ProductTimeline::productAction(
    name: 'checkout.submit',
    routeTemplate: 'https://shop.example/checkout/:step?cart=sample#review',
    sessionId: 'session_123',
    traceId: 'trace_abc',
    screen: 'Checkout',
    funnel: 'checkout',
    step: 'submit',
    metadata: $productMetadata
));
$productMetadata['cartTier'] = 'platinum';
$productPreview = $client->previewJson();
foreach ([
    '"name": "checkout.submit"',
    '"status": "success"',
    '"source": "product_timeline"',
    '"routeTemplate": "\/checkout\/:step"',
    '"sessionId": "session_123"',
    '"traceId": "trace_abc"',
    '"screen": "Checkout"',
    '"funnel": "checkout"',
    '"step": "submit"',
    '"cartTier": "gold"',
    '"attempt": 2',
] as $needle) {
    assertTrue(str_contains($productPreview, $needle), "missing product timeline payload: {$needle}");
}
assertTrue(!str_contains($productPreview, 'cart=sample'), 'expected product query text to be omitted');
assertTrue(!str_contains($productPreview, 'debug=sample'), 'expected app metadata route override');
assertTrue(!str_contains($productPreview, 'platinum'), 'expected product timeline metadata to be copied');

$client = sampleClient();
$client->action('evt_network_timeline', '2026-06-02T10:00:06Z', ProductTimeline::networkMilestone(
    routeTemplate: 'https://api.example/v1/payments/:id?debug=sample#fragment',
    method: 'post',
    statusCode: 503,
    durationMs: 183.4,
    sessionId: 'session_123',
    traceId: 'trace_abc',
    metadata: ['api' => 'payments']
));
$client->action('evt_network_timeline_default', '2026-06-02T10:00:07Z', ProductTimeline::networkMilestone('/health'));
$networkPreview = $client->previewJson();
foreach ([
    '"name": "network.post \/v1\/payments\/:id"',
    '"status": "failure"',
    '"source": "network_timeline"',
    '"routeTemplate": "\/v1\/payments\/:id"',
    '"method": "POST"',
    '"statusCode": 503',
    '"durationMs": 183.4',
    '"api": "payments"',
    '"name": "network.get \/health"',
    '"status": "success"',
] as $needle) {
    assertTrue(str_contains($networkPreview, $needle), "missing network timeline payload: {$needle}");
}
assertTrue(!str_contains($networkPreview, 'debug=sample'), 'expected network query text to be omitted');
expectThrows(
    fn () => ProductTimeline::networkMilestone('/orders/:id', method: 'GET /bad'),
    'network milestone method must be a valid HTTP method'
);
expectThrows(
    fn () => ProductTimeline::networkMilestone('/orders/:id', statusCode: 700),
    'network milestone statusCode must be between 100 and 599'
);
expectThrows(
    fn () => ProductTimeline::networkMilestone('/orders/:id', durationMs: -1),
    'network milestone durationMs must be non-negative'
);
expectThrows(
    fn () => ProductTimeline::networkMilestone('/orders/:id', name: '   '),
    'network milestone name must be non-empty'
);
expectThrows(
    fn () => ProductTimeline::networkMilestone('   '),
    'network milestone routeTemplate must be non-empty'
);
expectThrows(
    fn () => ProductTimeline::productAction('checkout.submit', metadata: ['bad' => []]),
    'metadata value for bad must be a string, number, boolean, or null'
);
expectThrows(
    fn () => ProductTimeline::productAction('checkout.submit', metadata: ['source' => []]),
    'metadata value for source must be a string, number, boolean, or null'
);

$client = sampleClient();
enqueueAll($client);
expectThrows(
    fn () => $client->flush(new RecordingTransport([401])),
    'transport rejected the API key'
);

$client = sampleClient();
enqueueAll($client);
$transport = new RecordingTransport([TransportError::network('temporary outage'), 202]);
$response = $client->flush($transport);
assertTrue($response->attempts === 2, 'expected retry before success');
assertTrue(count($transport->sentBodies) === 2, 'expected two send attempts');

$intake = new LocalHttpIntake([202]);
try {
    $transport = new HttpTransport(
        endpoint: $intake->endpoint,
        headers: ['x-logbrew-test' => 'php'],
        timeout: 2.0
    );
    assertTrue($transport->endpoint === $intake->endpoint, 'expected HTTP transport endpoint');
    assertTrue($transport->headers === ['x-logbrew-test' => 'php'], 'expected HTTP transport headers');
    assertTrue($transport->timeout === 2.0, 'expected HTTP transport timeout');

    $response = $transport->send('LOGBREW_API_KEY', '{}');
    assertTrue($response->statusCode === 202, 'expected HTTP transport status');
    assertTrue($response->attempts === 1, 'expected HTTP transport attempt count');

    $requests = $intake->requests();
    assertTrue(count($requests) === 1, 'expected one HTTP request');
    assertTrue($requests[0]['method'] === 'POST', 'expected HTTP POST');
    assertTrue($requests[0]['target'] === '/v1/events', 'expected HTTP request path');
    assertTrue($requests[0]['body'] === '{}', 'expected HTTP request body');
    assertTrue(($requests[0]['headers']['authorization'] ?? '') === 'Bearer LOGBREW_API_KEY', 'expected HTTP authorization header');
    assertTrue(($requests[0]['headers']['content-type'] ?? '') === 'application/json', 'expected HTTP content-type header');
    assertTrue(($requests[0]['headers']['x-logbrew-test'] ?? '') === 'php', 'expected custom HTTP header');
} finally {
    $intake->close();
}

$intake = new LocalHttpIntake([503, 202]);
try {
    $client = sampleClient();
    enqueueAll($client);
    $response = $client->flush(new HttpTransport(endpoint: $intake->endpoint, timeout: 2.0));
    assertTrue($response->statusCode === 202, 'expected HTTP retry success');
    assertTrue($response->attempts === 2, 'expected HTTP retry attempt count');
    assertTrue($client->pendingEvents() === 0, 'expected HTTP retry queue cleared');
    $requests = $intake->requests();
    assertTrue(count($requests) === 2, 'expected two HTTP retry requests');
    assertTrue($requests[0]['body'] === $requests[1]['body'], 'expected unchanged HTTP retry body');
} finally {
    $intake->close();
}

try {
    (new HttpTransport(endpoint: 'http://127.0.0.1:1/v1/events', timeout: 0.2))->send('LOGBREW_API_KEY', '{}');
    fwrite(STDERR, 'expected HTTP network failure' . PHP_EOL);
    exit(1);
} catch (TransportError $error) {
    assertTrue($error->codeName === 'network_failure', 'expected HTTP network failure code');
    assertTrue($error->retryable, 'expected HTTP network failure to be retryable');
    assertTrue($error->getMessage() === 'http transport failed', 'expected content-free HTTP network failure message');
}
expectThrows(fn () => new HttpTransport(endpoint: '/v1/events'), 'HTTP transport endpoint must use http or https');
expectThrows(fn () => new HttpTransport(headers: [' ' => 'bad']), 'HTTP transport header name must be non-empty');
expectThrows(fn () => new HttpTransport(timeout: 0.0), 'HTTP transport timeout must be positive');

$client = sampleClient();
enqueueAll($client);
$client->shutdown(RecordingTransport::alwaysAccept());
expectThrows(
    fn () => $client->action('evt_action_002', '2026-06-02T10:00:06Z', ['name' => 'deploy', 'status' => 'success']),
    'client is already shut down'
);

$client = sampleClient();
$transport = RecordingTransport::alwaysAccept();
$logger = new LogBrewPsrLogger(
    client: $client,
    loggerName: 'checkout',
    eventIdPrefix: 'psr_test',
    metadata: ['service' => 'checkout', 'ignoredBase' => []],
    timestampProvider: static fn (): DateTimeImmutable => new DateTimeImmutable('2026-06-02T10:00:06+00:00')
);
$logger->debug('debug detail for {region}', ['region' => 'global']);
$logger->warning('checkout slow for {region}', [
    'region' => 'global',
    'attempt' => 2,
    'messageContext' => true,
    'ignoredContext' => [],
]);
$logger->error('checkout failed for {region}', [
    'region' => 'global',
    'exception' => new RuntimeException('payment failed'),
]);
$logger->critical('checkout down for {region}', [
    'region' => 'global',
    'exception' => new RuntimeException('checkout down'),
]);
assertTrue($client->pendingEvents() === 4, 'expected PSR logger to queue events');
$preview = $client->previewJson();
foreach ([
    '"id": "psr_test_1"',
    '"timestamp": "2026-06-02T10:00:06+00:00"',
    '"logger": "checkout"',
    '"level": "info"',
    '"level": "warning"',
    '"level": "error"',
    '"level": "critical"',
    '"message": "checkout slow for global"',
    '"psrLevel": "warning"',
    '"messageTemplate": "checkout slow for {region}"',
    '"context.region": "global"',
    '"context.attempt": 2',
    '"context.messageContext": true',
    '"exceptionType": "RuntimeException"',
    '"exceptionMessage": "payment failed"',
] as $needle) {
    assertTrue(str_contains($preview, $needle), "missing PSR logger payload: {$needle}");
}
assertTrue(!str_contains($preview, 'exceptionTrace'), 'expected PSR logger trace text to be opt-in');
assertTrue(!str_contains($preview, 'ignoredBase'), 'expected PSR logger to skip non-primitive base metadata');
assertTrue(!str_contains($preview, 'ignoredContext'), 'expected PSR logger to skip non-primitive context metadata');
$response = $client->flush($transport);
assertTrue($response->statusCode === 202, 'expected PSR logger flush');
assertTrue(count($transport->sentBodies) === 1, 'expected PSR logger transport body');

$client = sampleClient();
$transport = RecordingTransport::alwaysAccept();
$logger = new LogBrewPsrLogger(
    client: $client,
    transport: $transport,
    flushOnLog: true,
    timestampProvider: static fn (): DateTimeImmutable => new DateTimeImmutable('2026-06-02T10:00:07+00:00')
);
$logger->log(LogLevel::NOTICE, 'notice becomes info');
assertTrue($client->pendingEvents() === 0, 'expected PSR flush-on-log to clear queue');
assertTrue(count($transport->sentBodies) === 1, 'expected PSR flush-on-log transport body');
expectThrows(
    fn () => $logger->log('verbose', 'unsupported'),
    'unsupported PSR-3 log level'
);

$client = sampleClient();
$transport = RecordingTransport::alwaysAccept();
$monolog = new MonologLogger('checkout.monolog');
$monolog->pushProcessor(static function (LogRecord $record): LogRecord {
    return $record->with(extra: ['requestId' => 'req_123', 'ignoredExtra' => []]);
});
$monolog->pushHandler(new LogBrewMonologHandler(
    client: $client,
    loggerName: 'fallback-monolog',
    eventIdPrefix: 'monolog_test',
    metadata: ['service' => 'checkout', 'ignoredBase' => []],
    timestampProvider: static fn (): DateTimeImmutable => new DateTimeImmutable('2026-06-02T10:00:08+00:00')
));
$monolog->warning('Checkout slow for {region}', [
    'region' => 'global',
    'attempt' => 2,
    'ignoredContext' => [],
]);
$monolog->error('Checkout failed for {region}', [
    'region' => 'global',
    'exception' => new RuntimeException('payment failed'),
]);
$monolog->critical('Checkout down for {region}', [
    'region' => 'global',
    'exception' => new RuntimeException('checkout down'),
]);
assertTrue($client->pendingEvents() === 3, 'expected Monolog handler to queue events');
$preview = $client->previewJson();
foreach ([
    '"id": "monolog_test_1"',
    '"timestamp": "2026-06-02T10:00:08+00:00"',
    '"logger": "checkout.monolog"',
    '"level": "warning"',
    '"level": "error"',
    '"level": "critical"',
    '"message": "Checkout slow for global"',
    '"monologLevel": "warning"',
    '"monologChannel": "checkout.monolog"',
    '"messageTemplate": "Checkout slow for {region}"',
    '"context.region": "global"',
    '"context.attempt": 2',
    '"extra.requestId": "req_123"',
    '"exceptionType": "RuntimeException"',
    '"exceptionMessage": "payment failed"',
] as $needle) {
    assertTrue(str_contains($preview, $needle), "missing Monolog handler payload: {$needle}");
}
assertTrue(!str_contains($preview, 'exceptionTrace'), 'expected Monolog handler trace text to be opt-in');
assertTrue(!str_contains($preview, 'ignoredBase'), 'expected Monolog handler to skip non-primitive base metadata');
assertTrue(!str_contains($preview, 'ignoredContext'), 'expected Monolog handler to skip non-primitive context metadata');
assertTrue(!str_contains($preview, 'ignoredExtra'), 'expected Monolog handler to skip non-primitive extra metadata');
$response = $client->flush($transport);
assertTrue($response->statusCode === 202, 'expected Monolog handler flush');
assertTrue(count($transport->sentBodies) === 1, 'expected Monolog handler transport body');

$client = sampleClient();
$transport = RecordingTransport::alwaysAccept();
$monolog = new MonologLogger('checkout.flush');
$monolog->pushHandler(new LogBrewMonologHandler(
    client: $client,
    transport: $transport,
    flushOnLog: true,
    timestampProvider: static fn (): DateTimeImmutable => new DateTimeImmutable('2026-06-02T10:00:09+00:00')
));
$monolog->notice('notice becomes info');
assertTrue($client->pendingEvents() === 0, 'expected Monolog flush-on-log to clear queue');
assertTrue(count($transport->sentBodies) === 1, 'expected Monolog flush-on-log transport body');

$client = sampleClient();
$client->shutdown(RecordingTransport::alwaysAccept());
$capturedErrors = [];
$monolog = new MonologLogger('checkout.safe');
$monolog->pushHandler(new LogBrewMonologHandler(
    client: $client,
    onError: static function (Throwable $error) use (&$capturedErrors): void {
        $capturedErrors[] = $error->getMessage();
    }
));
$monolog->warning('this should not interrupt app logging');
assertTrue(count($capturedErrors) === 1, 'expected Monolog handler to report capture failure');
assertTrue(str_contains($capturedErrors[0], 'client is already shut down'), 'expected Monolog handler capture failure message');

$packageRoot = realpath(__DIR__ . '/..');
if ($packageRoot === false) {
    fwrite(STDERR, 'expected package root' . PHP_EOL);
    exit(1);
}

$readmeExample = runCommand($packageRoot, [PHP_BINARY, 'examples/readme_example.php']);
assertTrue(str_contains($readmeExample['stdout'], '"type":"release"') || str_contains($readmeExample['stdout'], '"type": "release"'), 'expected release event in PHP README example output');
assertTrue(str_contains($readmeExample['stdout'], '"type":"environment"') || str_contains($readmeExample['stdout'], '"type": "environment"'), 'expected environment event in PHP README example output');
assertTrue(str_contains($readmeExample['stdout'], '"type":"issue"') || str_contains($readmeExample['stdout'], '"type": "issue"'), 'expected issue event in PHP README example output');
assertTrue(str_contains($readmeExample['stdout'], '"type":"log"') || str_contains($readmeExample['stdout'], '"type": "log"'), 'expected log event in PHP README example output');
assertTrue(str_contains($readmeExample['stdout'], '"type":"span"') || str_contains($readmeExample['stdout'], '"type": "span"'), 'expected span event in PHP README example output');
assertTrue(str_contains($readmeExample['stdout'], '"type":"action"') || str_contains($readmeExample['stdout'], '"type": "action"'), 'expected action event in PHP README example output');
assertTrue(str_contains($readmeExample['stderr'], '"ok":true') || str_contains($readmeExample['stderr'], '"ok": true'), 'expected success status in PHP README example stderr');
assertTrue(str_contains($readmeExample['stderr'], '"events":6') || str_contains($readmeExample['stderr'], '"events": 6'), 'expected event count in PHP README example stderr');

$realUserSmoke = runCommand($packageRoot, [PHP_BINARY, 'examples/real_user_smoke.php']);
assertTrue(str_contains($realUserSmoke['stdout'], '"type":"release"') || str_contains($realUserSmoke['stdout'], '"type": "release"'), 'expected release event in PHP real-user smoke output');
assertTrue(str_contains($realUserSmoke['stdout'], '"type":"environment"') || str_contains($realUserSmoke['stdout'], '"type": "environment"'), 'expected environment event in PHP real-user smoke output');
assertTrue(str_contains($realUserSmoke['stdout'], '"type":"issue"') || str_contains($realUserSmoke['stdout'], '"type": "issue"'), 'expected issue event in PHP real-user smoke output');
assertTrue(str_contains($realUserSmoke['stdout'], '"type":"log"') || str_contains($realUserSmoke['stdout'], '"type": "log"'), 'expected log event in PHP real-user smoke output');
assertTrue(str_contains($realUserSmoke['stdout'], '"type":"span"') || str_contains($realUserSmoke['stdout'], '"type": "span"'), 'expected span event in PHP real-user smoke output');
assertTrue(str_contains($realUserSmoke['stdout'], '"type":"action"') || str_contains($realUserSmoke['stdout'], '"type": "action"'), 'expected action event in PHP real-user smoke output');
assertTrue(str_contains($realUserSmoke['stderr'], '"ok":true') || str_contains($realUserSmoke['stderr'], '"ok": true'), 'expected success status in PHP real-user smoke stderr');
assertTrue(str_contains($realUserSmoke['stderr'], '"events":6') || str_contains($realUserSmoke['stderr'], '"events": 6'), 'expected event count in PHP real-user smoke stderr');

$examplesDir = $packageRoot . '/examples';
$makeHelp = runCommand($examplesDir, ['make']);
$helpLines = preg_split('/\R/', trim($makeHelp['stdout']));
assertTrue($helpLines === [
    'run-readme-example -> make run-readme-example',
    'run (real-user-smoke) -> make run',
    'run-real-user-smoke -> make run-real-user-smoke',
    'run-first-useful-telemetry -> make run-first-useful-telemetry',
    'run-http-trace-correlation -> make run-http-trace-correlation',
    'run-worker-lifecycle -> make run-worker-lifecycle',
    'run-persistent-worker-delivery -> make run-persistent-worker-delivery',
], 'unexpected PHP examples make output');
assertTrue($makeHelp['stderr'] === '', 'expected empty stderr from PHP examples make help');

$makeRun = runCommand($examplesDir, ['make', 'run']);
assertTrue(str_contains($makeRun['stdout'], '"type":"release"') || str_contains($makeRun['stdout'], '"type": "release"'), 'expected release event in PHP make run output');
assertTrue(str_contains($makeRun['stdout'], '"type":"environment"') || str_contains($makeRun['stdout'], '"type": "environment"'), 'expected environment event in PHP make run output');
assertTrue(str_contains($makeRun['stdout'], '"type":"issue"') || str_contains($makeRun['stdout'], '"type": "issue"'), 'expected issue event in PHP make run output');
assertTrue(str_contains($makeRun['stdout'], '"type":"log"') || str_contains($makeRun['stdout'], '"type": "log"'), 'expected log event in PHP make run output');
assertTrue(str_contains($makeRun['stdout'], '"type":"span"') || str_contains($makeRun['stdout'], '"type": "span"'), 'expected span event in PHP make run output');
assertTrue(str_contains($makeRun['stdout'], '"type":"action"') || str_contains($makeRun['stdout'], '"type": "action"'), 'expected action event in PHP make run output');
assertTrue(str_contains($makeRun['stderr'], '"ok":true') || str_contains($makeRun['stderr'], '"ok": true'), 'expected success status in PHP make run stderr');
assertTrue(str_contains($makeRun['stderr'], '"events":6') || str_contains($makeRun['stderr'], '"events": 6'), 'expected event count in PHP make run stderr');

$makeReadme = runCommand($examplesDir, ['make', 'run-readme-example']);
assertTrue(str_contains($makeReadme['stdout'], '"type":"release"') || str_contains($makeReadme['stdout'], '"type": "release"'), 'expected release event in PHP make run-readme-example output');
assertTrue(str_contains($makeReadme['stdout'], '"type":"environment"') || str_contains($makeReadme['stdout'], '"type": "environment"'), 'expected environment event in PHP make run-readme-example output');
assertTrue(str_contains($makeReadme['stdout'], '"type":"issue"') || str_contains($makeReadme['stdout'], '"type": "issue"'), 'expected issue event in PHP make run-readme-example output');
assertTrue(str_contains($makeReadme['stdout'], '"type":"log"') || str_contains($makeReadme['stdout'], '"type": "log"'), 'expected log event in PHP make run-readme-example output');
assertTrue(str_contains($makeReadme['stdout'], '"type":"span"') || str_contains($makeReadme['stdout'], '"type": "span"'), 'expected span event in PHP make run-readme-example output');
assertTrue(str_contains($makeReadme['stdout'], '"type":"action"') || str_contains($makeReadme['stdout'], '"type": "action"'), 'expected action event in PHP make run-readme-example output');
assertTrue(str_contains($makeReadme['stderr'], '"ok":true') || str_contains($makeReadme['stderr'], '"ok": true'), 'expected success status in PHP make run-readme-example stderr');
assertTrue(str_contains($makeReadme['stderr'], '"events":6') || str_contains($makeReadme['stderr'], '"events": 6'), 'expected event count in PHP make run-readme-example stderr');

$makeRealUser = runCommand($examplesDir, ['make', 'run-real-user-smoke']);
assertTrue(str_contains($makeRealUser['stdout'], '"type":"release"') || str_contains($makeRealUser['stdout'], '"type": "release"'), 'expected release event in PHP make run-real-user-smoke output');
assertTrue(str_contains($makeRealUser['stdout'], '"type":"environment"') || str_contains($makeRealUser['stdout'], '"type": "environment"'), 'expected environment event in PHP make run-real-user-smoke output');
assertTrue(str_contains($makeRealUser['stdout'], '"type":"issue"') || str_contains($makeRealUser['stdout'], '"type": "issue"'), 'expected issue event in PHP make run-real-user-smoke output');
assertTrue(str_contains($makeRealUser['stdout'], '"type":"log"') || str_contains($makeRealUser['stdout'], '"type": "log"'), 'expected log event in PHP make run-real-user-smoke output');
assertTrue(str_contains($makeRealUser['stdout'], '"type":"span"') || str_contains($makeRealUser['stdout'], '"type": "span"'), 'expected span event in PHP make run-real-user-smoke output');
assertTrue(str_contains($makeRealUser['stdout'], '"type":"action"') || str_contains($makeRealUser['stdout'], '"type": "action"'), 'expected action event in PHP make run-real-user-smoke output');
assertTrue(str_contains($makeRealUser['stderr'], '"ok":true') || str_contains($makeRealUser['stderr'], '"ok": true'), 'expected success status in PHP make run-real-user-smoke stderr');
assertTrue(str_contains($makeRealUser['stderr'], '"events":6') || str_contains($makeRealUser['stderr'], '"events": 6'), 'expected event count in PHP make run-real-user-smoke stderr');

$firstUseful = runCommand($packageRoot, [PHP_BINARY, 'examples/first_useful_telemetry.php']);
foreach (['"type":"release"', '"type":"environment"', '"type":"log"', '"type":"action"', '"type":"metric"', '"type":"span"'] as $needle) {
    $prettyNeedle = str_replace('":"', '": "', $needle);
    assertTrue(str_contains($firstUseful['stdout'], $needle) || str_contains($firstUseful['stdout'], $prettyNeedle), "expected first-useful output to contain {$needle}");
}
assertTrue(str_contains($firstUseful['stdout'], '"traceId":"4bf92f3577b34da6a3ce929d0e0e4736"') || str_contains($firstUseful['stdout'], '"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"'), 'expected first-useful trace correlation');
assertTrue(!str_contains($firstUseful['stdout'], 'coupon=sample'), 'expected first-useful product query text to be omitted');
assertTrue(!str_contains($firstUseful['stdout'], 'card=sample'), 'expected first-useful network query text to be omitted');
assertTrue(str_contains($firstUseful['stderr'], '"events":7') || str_contains($firstUseful['stderr'], '"events": 7'), 'expected first-useful event count');
assertTrue(str_contains($firstUseful['stderr'], '"outgoingTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"') || str_contains($firstUseful['stderr'], '"outgoingTraceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"'), 'expected first-useful outgoing traceparent');

$makeFirstUseful = runCommand($examplesDir, ['make', 'run-first-useful-telemetry']);
assertTrue(str_contains($makeFirstUseful['stdout'], '"type":"metric"') || str_contains($makeFirstUseful['stdout'], '"type": "metric"'), 'expected metric event in PHP make run-first-useful-telemetry output');
assertTrue(str_contains($makeFirstUseful['stderr'], '"events":7') || str_contains($makeFirstUseful['stderr'], '"events": 7'), 'expected first-useful make event count');

$workerLifecycle = runCommand($packageRoot, [PHP_BINARY, 'examples/worker_lifecycle.php']);
assertTrue(str_contains($workerLifecycle['stdout'], '"workResult":"job-result"'), 'expected worker lifecycle app result');
assertTrue(str_contains($workerLifecycle['stdout'], '"requests":1'), 'expected worker lifecycle work-boundary request');
assertTrue(str_contains($workerLifecycle['stdout'], '"deliveryFailureCodes":[]'), 'expected no worker lifecycle failures');
assertTrue(str_contains($workerLifecycle['stdout'], '"shutdownStatus":204'), 'expected idempotent empty shutdown status');
assertTrue($workerLifecycle['stderr'] === '', 'expected empty worker lifecycle stderr');

$makeWorkerLifecycle = runCommand($examplesDir, ['make', 'run-worker-lifecycle']);
assertTrue(str_contains($makeWorkerLifecycle['stdout'], '"workResult":"job-result"'), 'expected make worker lifecycle app result');
assertTrue(str_contains($makeWorkerLifecycle['stdout'], '"requests":1'), 'expected make worker lifecycle request');
assertTrue($makeWorkerLifecycle['stderr'] === '', 'expected empty make worker lifecycle stderr');

$persistentWorkerDelivery = runCommand($packageRoot, [PHP_BINARY, 'examples/persistent_worker_delivery.php']);
assertTrue(str_contains($persistentWorkerDelivery['stdout'], '"recoveredEvents":1'), 'expected persistent example restart recovery');
assertTrue(str_contains($persistentWorkerDelivery['stdout'], '"deliveredEvents":1'), 'expected persistent example delivery count');
assertTrue(str_contains($persistentWorkerDelivery['stdout'], '"pendingEvents":0'), 'expected persistent example empty queue');
assertTrue($persistentWorkerDelivery['stderr'] === '', 'expected empty persistent example stderr');

$makePersistentWorkerDelivery = runCommand($examplesDir, ['make', 'run-persistent-worker-delivery']);
assertTrue(str_contains($makePersistentWorkerDelivery['stdout'], '"recoveredEvents":1'), 'expected make persistent example recovery');
assertTrue(str_contains($makePersistentWorkerDelivery['stdout'], '"pendingEvents":0'), 'expected make persistent example empty queue');
assertTrue($makePersistentWorkerDelivery['stderr'] === '', 'expected empty make persistent example stderr');

$persistentDeliveryContract = runCommand($packageRoot, [PHP_BINARY, 'tests/persistent_delivery_contract.php']);
assertTrue(
    str_contains($persistentDeliveryContract['stdout'], 'php persistent delivery contract checks passed (10)'),
    'expected focused persistent delivery contract checks'
);

require __DIR__ . '/trace_correlation.php';
require __DIR__ . '/http_client_tracing.php';
require __DIR__ . '/worker_lifecycle.php';
require __DIR__ . '/persistent_delivery.php';

fwrite(STDOUT, "php sdk checks passed\n");
