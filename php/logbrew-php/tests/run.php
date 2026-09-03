<?php

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use LogBrew\ActionAttributes;
use LogBrew\HttpTransport;
use LogBrew\IssueDiagnostics;
use LogBrew\LaravelLoggerFactory;
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

/** @return array<string, mixed> */
function testStringMap(mixed $value, string $label): array
{
    if (!is_array($value)) {
        throw new RuntimeException("expected {$label} object");
    }
    $copied = [];
    foreach ($value as $key => $item) {
        if (!is_string($key)) {
            throw new RuntimeException("expected {$label} string keys");
        }
        $copied[$key] = $item;
    }
    return $copied;
}

/** @return list<mixed> */
function testList(mixed $value, string $label): array
{
    if (!is_array($value) || !array_is_list($value)) {
        throw new RuntimeException("expected {$label} list");
    }
    return $value;
}

/**
 * @param array<mixed> $value
 * @param non-empty-list<int|string> $path
 */
function testValueAt(array $value, array $path): mixed
{
    $current = $value;
    foreach ($path as $key) {
        if (!is_array($current) || !array_key_exists($key, $current)) {
            throw new RuntimeException('missing test value path');
        }
        $current = $current[$key];
    }
    return $current;
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

$caughtIssue = null;
try {
    (static function (): void {
        (static function (): void {
            throw new RuntimeException('sensitive checkout failure');
        })();
    })();
} catch (Throwable $error) {
    $caughtIssue = $error;
}
assertTrue($caughtIssue instanceof RuntimeException, 'expected throwable fixture');

$firstBreadcrumb = IssueDiagnostics::breadcrumb(
    timestamp: '2026-06-02T09:59:58.125+00:00',
    category: 'checkout.navigation',
    type: 'navigation',
    level: 'warn',
    message: 'User reached payment review',
    data: ['attempt' => 2, 'cached' => false]
);
$secondBreadcrumb = IssueDiagnostics::breadcrumb(
    timestamp: '2026-06-02T09:59:59Z',
    category: 'checkout.request',
    type: 'http',
    level: 'info',
    data: ['method' => 'POST', 'statusCode' => 503]
);
$issueAttributes = IssueDiagnostics::fromThrowable(
    $caughtIssue,
    mechanismType: 'php.exception',
    handled: true,
    breadcrumbs: [$firstBreadcrumb, $secondBreadcrumb],
    breadcrumbsTruncated: true,
    metadata: ['routeTemplate' => '/checkout/:cart_id']
);
$diagnosticClient = sampleClient();
$diagnosticClient->issue('evt_issue_diagnostics', '2026-06-02T10:00:02Z', $issueAttributes);
$issueException = $issueAttributes['exception'] ?? null;
$issueFrames = $issueAttributes['stackFrames'] ?? null;
$issueBreadcrumbs = $issueAttributes['breadcrumbs'] ?? null;
if (!is_array($issueException) || !is_array($issueFrames) || !is_array($issueBreadcrumbs)) {
    throw new RuntimeException('expected complete issue diagnostics fixture');
}
$issueAttributes['exception']['type'] = 'MutatedException';
$issueAttributes['stackFrames'][0]['filename'] = 'mutated.php';
$issueAttributes['breadcrumbs'][0]['data']['attempt'] = 99;
$diagnosticPayload = testStringMap(
    json_decode($diagnosticClient->previewJson(), true, 512, JSON_THROW_ON_ERROR),
    'diagnostic payload'
);
$diagnosticAttributes = testStringMap(
    testValueAt($diagnosticPayload, ['events', 0, 'attributes']),
    'diagnostic attributes'
);
assertTrue($diagnosticAttributes['title'] === RuntimeException::class, 'expected safe PHP exception title');
assertTrue($diagnosticAttributes['level'] === 'error', 'expected PHP exception error level');
assertTrue(!array_key_exists('message', $diagnosticAttributes), 'expected throwable message to remain opt-in');
assertTrue(testValueAt($diagnosticAttributes, ['exception']) === [
    'type' => RuntimeException::class,
    'mechanism' => ['type' => 'php.exception', 'handled' => true],
], 'expected typed PHP exception mechanism');
$diagnosticChain = testStringMap(
    testValueAt($diagnosticAttributes, ['exceptionChain']),
    'diagnostic exception chain'
);
$diagnosticChainEntries = testList($diagnosticChain['entries'] ?? null, 'diagnostic exception chain entries');
$diagnosticReported = testStringMap($diagnosticChainEntries[0] ?? null, 'diagnostic reported exception');
assertTrue(
    count($diagnosticChainEntries) === 1
        && ($diagnosticChain['truncated'] ?? null) === false
        && ($diagnosticReported['relationship'] ?? null) === 'reported'
        && ($diagnosticReported['type'] ?? null) === RuntimeException::class
        && ($diagnosticReported['messageState'] ?? null) === 'redacted'
        && ($diagnosticReported['stackFramesState'] ?? null) === 'captured'
        && ($diagnosticReported['stackFrames'] ?? null) === ($diagnosticAttributes['stackFrames'] ?? null),
    'expected matching PHP reported exception-chain evidence'
);
$diagnosticFrames = testList(testValueAt($diagnosticAttributes, ['stackFrames']), 'diagnostic stack frames');
assertTrue(
    count($diagnosticFrames) >= 1 && count($diagnosticFrames) <= 32,
    'expected bounded PHP stack frame projection'
);
$diagnosticFrame = testStringMap($diagnosticFrames[0], 'diagnostic stack frame');
assertTrue(
    $diagnosticFrame['filename'] === basename(__FILE__)
        && is_int($diagnosticFrame['line'])
        && $diagnosticFrame['line'] > 0
        && $diagnosticFrame['column'] === 1,
    'expected newest-first basename-only PHP throw frame'
);
$diagnosticBreadcrumbs = testList(testValueAt($diagnosticAttributes, ['breadcrumbs']), 'diagnostic breadcrumbs');
assertTrue(
    testValueAt($diagnosticBreadcrumbs, [0, 'level']) === 'warning'
        && testValueAt($diagnosticBreadcrumbs, [0, 'data', 'attempt']) === 2
        && testValueAt($diagnosticBreadcrumbs, [1, 'category']) === 'checkout.request',
    'expected detached oldest-first PHP breadcrumbs'
);
assertTrue($diagnosticAttributes['breadcrumbsTruncated'] === true, 'expected PHP breadcrumb truncation signal');
$encodedDiagnostics = json_encode($diagnosticPayload, JSON_THROW_ON_ERROR);
assertTrue(!str_contains($encodedDiagnostics, 'sensitive checkout failure'), 'expected PHP throwable message exclusion');
assertTrue(!str_contains($encodedDiagnostics, dirname(__DIR__)), 'expected PHP absolute source path exclusion');
assertTrue(!str_contains($encodedDiagnostics, 'MutatedException'), 'expected detached PHP issue diagnostics');

$previousError = new InvalidArgumentException('private previous exception message');
$wrappedError = new RuntimeException('private wrapper exception message', previous: $previousError);
$wrappedAttributes = IssueDiagnostics::fromThrowable($wrappedError, mechanismType: 'php.exception', handled: true);
$wrappedClient = sampleClient();
$wrappedClient->issue('evt_issue_exception_chain', '2026-06-02T10:00:02Z', $wrappedAttributes);
$wrappedPayload = testStringMap(
    json_decode($wrappedClient->previewJson(), true, 512, JSON_THROW_ON_ERROR),
    'wrapped exception payload'
);
$wrappedEventAttributes = testStringMap(
    testValueAt($wrappedPayload, ['events', 0, 'attributes']),
    'wrapped exception attributes'
);
$wrappedChain = testStringMap($wrappedEventAttributes['exceptionChain'] ?? null, 'wrapped exception chain');
$wrappedEntries = testList($wrappedChain['entries'] ?? null, 'wrapped exception chain entries');
assertTrue(count($wrappedEntries) === 2, 'expected reported and previous PHP exceptions');
$wrappedCause = testStringMap($wrappedEntries[1] ?? null, 'wrapped exception cause');
assertTrue(
    ($wrappedCause['id'] ?? null) === 1
        && ($wrappedCause['parentId'] ?? null) === 0
        && ($wrappedCause['relationship'] ?? null) === 'cause'
        && ($wrappedCause['type'] ?? null) === InvalidArgumentException::class
        && ($wrappedCause['messageState'] ?? null) === 'redacted'
        && ($wrappedCause['stackFramesState'] ?? null) === 'captured'
        && testValueAt($wrappedCause, ['mechanism', 'type']) === 'php.previous',
    'expected typed previous-exception evidence'
);
$encodedWrapped = json_encode($wrappedPayload, JSON_THROW_ON_ERROR);
assertTrue(
    !str_contains($encodedWrapped, 'private previous exception message')
        && !str_contains($encodedWrapped, 'private wrapper exception message'),
    'expected PHP exception-chain messages to remain redacted'
);

$deepError = new RuntimeException('private depth 9');
for ($depth = 8; $depth >= 0; --$depth) {
    $deepError = new RuntimeException("private depth {$depth}", previous: $deepError);
}
$deepAttributes = IssueDiagnostics::fromThrowable($deepError);
$deepChain = testStringMap($deepAttributes['exceptionChain'] ?? null, 'deep exception chain');
assertTrue(
    count(testList($deepChain['entries'] ?? null, 'deep exception entries')) === 8
        && ($deepChain['truncated'] ?? null) === true
        && !str_contains(json_encode($deepAttributes, JSON_THROW_ON_ERROR), 'private depth'),
    'expected bounded redacted PHP exception chain'
);

$manualFrame = IssueDiagnostics::stackFrame('Checkout.php', 41, 1, 'submit');
$manualChainAttributes = IssueDiagnostics::validateIssueAttributes([
    'title' => 'Checkout failed',
    'level' => 'error',
    'exception' => ['type' => 'CheckoutFailure', 'mechanism' => ['type' => 'php.manual', 'handled' => true]],
    'exceptionChain' => [
        'entries' => [
            [
                'id' => 0,
                'relationship' => 'reported',
                'type' => 'CheckoutFailure',
                'message' => 'approved summary',
                'messageState' => 'truncated',
                'mechanism' => ['type' => 'php.manual', 'handled' => true],
                'stackFrames' => [$manualFrame],
                'stackFramesState' => 'captured',
            ],
            [
                'id' => 1,
                'parentId' => 0,
                'relationship' => 'context',
                'type' => 'RequestContextFailure',
                'messageState' => 'redacted',
                'stackFramesState' => 'not_captured',
            ],
        ],
        'truncated' => true,
    ],
    'stackFrames' => [$manualFrame],
]);
assertTrue(
    testValueAt($manualChainAttributes, ['exceptionChain', 'entries', 0, 'messageState']) === 'truncated'
        && testValueAt($manualChainAttributes, ['exceptionChain', 'entries', 1, 'relationship']) === 'context'
        && testValueAt($manualChainAttributes, ['exceptionChain', 'truncated']) === true,
    'expected explicit PHP exception-chain states'
);
expectThrows(
    fn () => IssueDiagnostics::validateIssueAttributes([
        'title' => 'Bad chain',
        'level' => 'error',
        'exception' => ['type' => 'CheckoutFailure'],
        'exceptionChain' => [
            'entries' => [[
                'id' => 0,
                'relationship' => 'cause',
                'type' => 'CheckoutFailure',
                'messageState' => 'not_captured',
                'stackFramesState' => 'not_captured',
            ]],
            'truncated' => false,
        ],
    ]),
    'issue exceptionChain entry 0 must be the parentless reported exception'
);

$explicitFrame = IssueDiagnostics::stackFrame(
    '/opt/example/src/CheckoutService.php?debug=fixture#payment',
    41,
    7,
    'capturePayment',
    'App\\CheckoutService',
    true,
    '123E4567-E89B-12D3-A456-426614174000'
);
assertTrue(
    $explicitFrame['filename'] === 'CheckoutService.php'
        && ($explicitFrame['debugId'] ?? null) === '123e4567-e89b-12d3-a456-426614174000'
        && ($explicitFrame['inApp'] ?? null) === true,
    'expected sanitized explicit PHP stack frame'
);

$anonymousIssue = new class('anonymous detail') extends RuntimeException {
};
$anonymousAttributes = IssueDiagnostics::fromThrowable($anonymousIssue, includeStackFrames: false);
assertTrue(
    $anonymousAttributes['title'] === 'anonymous_exception'
        && testValueAt($anonymousAttributes, ['exception', 'type']) === 'anonymous_exception'
        && !array_key_exists('stackFrames', $anonymousAttributes),
    'expected privacy-safe anonymous PHP exception identity'
);
assertTrue(
    testValueAt($anonymousAttributes, ['exceptionChain', 'entries', 0, 'stackFramesState']) === 'not_captured',
    'expected explicit PHP omitted-stack state'
);

expectThrows(
    fn () => IssueDiagnostics::fromThrowable(
        $caughtIssue,
        breadcrumbs: array_fill(0, 65, $firstBreadcrumb)
    ),
    'issue breadcrumbs must contain 1-64 entries'
);
expectThrows(
    fn () => IssueDiagnostics::breadcrumb(
        '2026-06-02T09:59:58',
        'checkout.request'
    ),
    'issue breadcrumb timestamp must be RFC 3339 with an explicit timezone'
);
expectThrows(
    fn () => IssueDiagnostics::breadcrumb(
        '2026-06-02T09:59:58Z',
        'checkout.request',
        data: ['duration' => NAN]
    ),
    'issue breadcrumb data value for duration must be a finite primitive'
);
expectThrows(
    fn () => sampleClient()->issue('evt_bad_diagnostics', '2026-06-02T10:00:02Z', [
        'title' => 'Bad diagnostics',
        'level' => 'error',
        'exception' => ['type' => 'RuntimeException', 'value' => 'must not pass'],
    ]),
    'issue exception has unsupported fields: value'
);
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
require __DIR__ . '/laravel_queue.php';
require __DIR__ . '/support_ticket.php';
require __DIR__ . '/bounded_queue.php';
require __DIR__ . '/bounded_batching.php';

$client = sampleClient();
$client->metric('evt_metric_001', '2026-06-02T10:00:06Z', [
    'name' => 'queue.depth',
    'description' => '  Number of items waiting in the checkout queue.  ',
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
    '"description": "Number of items waiting in the checkout queue."',
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
foreach (['   ', str_repeat('M', 1_025), "request\u{0085}count", "request\u{2028}count"] as $description) {
    expectThrows(
        fn () => sampleClient()->metric('evt_metric_invalid_description', '2026-06-02T10:00:06Z', [
            'name' => 'queue.depth',
            'description' => $description,
            'kind' => 'gauge',
            'value' => 2,
            'unit' => '{items}',
            'temporality' => 'instant',
        ]),
        'metric description must be a non-blank string of at most 1024 non-control characters'
    );
}

$productMetadata = [
    'cartTier' => 'gold',
    'attempt' => 2,
    'routeTemplate' => '/raw?debug=sample',
    'analyticsSchemaVersion' => 99,
    'analyticsKind' => 'page_view',
    'analyticsSurface' => '/spoofed',
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
    '"analyticsSchemaVersion": 1',
    '"analyticsKind": "interaction"',
    '"analyticsSurface": "\/checkout\/:step"',
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

$laravelConfig = LaravelLoggerFactory::configuration(
    apiKey: 'LOGBREW_SERVER_API_KEY',
    service: 'pterodactyl-panel',
    release: '1.11.0',
    environment: 'testing'
);
assertTrue($laravelConfig['driver'] === 'custom', 'expected Laravel custom log driver');
assertTrue($laravelConfig['via'] === LaravelLoggerFactory::class, 'expected SDK-owned Laravel logger factory');
assertTrue($laravelConfig['timeout'] === 2.0, 'expected bounded Laravel timeout');
assertTrue($laravelConfig['max_retries'] === 0, 'expected no Laravel delivery retries by default');
assertTrue($laravelConfig['level'] === 'warning', 'expected warning Laravel level by default');
$exportedLaravelConfig = var_export($laravelConfig, true);
$encodedLaravelConfig = json_encode($laravelConfig, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
$roundTrippedLaravelConfig = json_decode($encodedLaravelConfig, true, flags: JSON_THROW_ON_ERROR);
assertTrue(!str_contains($exportedLaravelConfig, '::__set_state'), 'expected no object state in Laravel channel values');
assertTrue($roundTrippedLaravelConfig === $laravelConfig, 'expected config-cache-safe Laravel channel values');

$transport = RecordingTransport::alwaysAccept();
$laravelLogger = (new LaravelLoggerFactory($transport))($laravelConfig + [
    'event_id_prefix' => 'laravel_test',
]);
$laravelLogger->warning('Server {server} could not start.', [
    'server' => 'srv_123',
    'attempt' => 2,
]);
assertTrue(count($transport->sentBodies) === 1, 'expected Laravel logger to deliver each accepted record');
$laravelBody = $transport->lastBody();
if ($laravelBody === null) {
    fwrite(STDERR, 'expected Laravel logger transport body' . PHP_EOL);
    exit(1);
}
foreach ([
    '"id":"laravel_test_1"',
    '"logger":"pterodactyl-panel"',
    '"level":"warning"',
    '"message":"Server srv_123 could not start."',
    '"context.server":"srv_123"',
    '"context.attempt":2',
    '"framework":"laravel"',
    '"service":"pterodactyl-panel"',
    '"release":"1.11.0"',
    '"environment":"testing"',
    '"context":{"schemaVersion":1',
    '"service":{"name":"pterodactyl-panel"}',
    '"deployment":{"environment":"testing","release":"1.11.0"}',
    '"framework":{"name":"laravel"}',
    '"runtime":{"name":"php"',
] as $needle) {
    assertTrue(str_contains($laravelBody, $needle), "missing Laravel logger payload: {$needle}");
}
assertTrue(!str_contains($laravelBody, 'LOGBREW_SERVER_API_KEY'), 'expected Laravel API key to stay out of payload');
$laravelPayload = testStringMap(json_decode($laravelBody, true, flags: JSON_THROW_ON_ERROR), 'Laravel payload');
$laravelSdk = testStringMap($laravelPayload['sdk'] ?? null, 'Laravel SDK');
assertTrue(($laravelSdk['name'] ?? null) === 'logbrew-php-laravel', 'expected Laravel integration identity');
assertTrue(is_string($laravelSdk['version'] ?? null) && $laravelSdk['version'] !== '1.11.0', 'expected SDK version independent of app release');

$transport = RecordingTransport::alwaysAccept();
$errorOnlyLogger = (new LaravelLoggerFactory($transport))(LaravelLoggerFactory::configuration(
    apiKey: 'LOGBREW_SERVER_API_KEY',
    level: 'error'
));
$errorOnlyLogger->warning('below the configured threshold');
assertTrue(count($transport->sentBodies) === 0, 'expected Laravel logger to honor configured level');
$errorOnlyLogger->error('accepted at the configured threshold');
assertTrue(count($transport->sentBodies) === 1, 'expected Laravel logger error delivery');

$failedTransport = new RecordingTransport([TransportError::network('LogBrew is unavailable.')]);
$failureIsolatedLogger = (new LaravelLoggerFactory($failedTransport))($laravelConfig);
$failureIsolatedLogger->error('application logging must continue');
assertTrue(count($failedTransport->sentBodies) === 1, 'expected Laravel delivery attempt without app failure');

expectThrows(
    fn () => (new LaravelLoggerFactory())(LaravelLoggerFactory::configuration(apiKey: null)),
    'LOGBREW_SERVER_API_KEY must be configured'
);

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
    'run-issue-diagnostics -> make run-issue-diagnostics',
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

$issueDiagnosticsExample = runCommand($packageRoot, [PHP_BINARY, 'examples/issue_diagnostics.php']);
$issueDiagnosticsPayload = testStringMap(
    json_decode($issueDiagnosticsExample['stdout'], true, 512, JSON_THROW_ON_ERROR),
    'issue diagnostics example payload'
);
$issueDiagnosticsAttributes = testStringMap(
    testValueAt($issueDiagnosticsPayload, ['events', 0, 'attributes']),
    'issue diagnostics example attributes'
);
assertTrue(
    testValueAt($issueDiagnosticsAttributes, ['exception', 'mechanism']) === [
        'type' => 'php.exception',
        'handled' => true,
    ],
    'expected issue diagnostics example mechanism'
);
assertTrue(
    testValueAt($issueDiagnosticsAttributes, ['stackFrames', 0, 'filename']) === 'issue_diagnostics.php'
        && testValueAt($issueDiagnosticsAttributes, ['stackFrames', 0, 'function']) === 'fail'
        && testValueAt($issueDiagnosticsAttributes, ['stackFrames', 0, 'module']) === 'CheckoutFailureFixture',
    'expected useful issue diagnostics example frame identity'
);
assertTrue(
    testValueAt($issueDiagnosticsAttributes, ['breadcrumbs', 0, 'category']) === 'checkout.navigation'
        && testValueAt($issueDiagnosticsAttributes, ['breadcrumbs', 1, 'level']) === 'warning',
    'expected oldest-first normalized issue diagnostics breadcrumbs'
);
assertTrue(!str_contains($issueDiagnosticsExample['stdout'], 'sensitive provider response fixture'), 'expected issue diagnostics example message exclusion');
assertTrue(!str_contains($issueDiagnosticsExample['stdout'], dirname($packageRoot)), 'expected issue diagnostics example absolute path exclusion');
assertTrue(str_contains($issueDiagnosticsExample['stderr'], '"events":1'), 'expected issue diagnostics example event count');

$makeIssueDiagnostics = runCommand($examplesDir, ['make', 'run-issue-diagnostics']);
assertTrue(str_contains($makeIssueDiagnostics['stdout'], '"type":"issue"') || str_contains($makeIssueDiagnostics['stdout'], '"type": "issue"'), 'expected issue event in PHP make run-issue-diagnostics output');
assertTrue(str_contains($makeIssueDiagnostics['stderr'], '"events":1') || str_contains($makeIssueDiagnostics['stderr'], '"events": 1'), 'expected issue diagnostics make event count');
assertTrue(!str_contains($makeIssueDiagnostics['stdout'], 'sensitive provider response fixture'), 'expected make issue diagnostics message exclusion');

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
require __DIR__ . '/symfony_integration.php';
require __DIR__ . '/telemetry_context.php';

fwrite(STDOUT, "php sdk checks passed\n");
