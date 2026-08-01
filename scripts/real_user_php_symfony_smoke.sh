#!/usr/bin/env bash
# shellcheck disable=SC2016
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

export COMPOSER_HOME="$tmp_dir/composer-home"
export COMPOSER_CACHE_DIR="$tmp_dir/composer-cache"
export COMPOSER_NO_AUDIT=1
mkdir -p "$COMPOSER_HOME" "$COMPOSER_CACHE_DIR" "$tmp_dir/artifacts" "$tmp_dir/captures"

archive_src="$tmp_dir/logbrew-php"
cp -R "$repo_root/php/logbrew-php" "$archive_src"
rm -rf "$archive_src/vendor" "$archive_src/composer.lock"
php -r '
$path = $argv[1];
$manifest = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
$manifest["version"] = "0.1.0";
file_put_contents($path, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL);
' "$archive_src/composer.json"
(cd "$archive_src" && composer archive --format=zip --dir "$tmp_dir/artifacts" --file logbrew-sdk --quiet)
test -f "$tmp_dir/artifacts/logbrew-sdk.zip"

app_dir="$tmp_dir/symfony-app"
mkdir -p "$app_dir/bin" "$app_dir/config/packages" "$app_dir/src/Controller" "$app_dir/src/EventSubscriber" "$app_dir/var/cache" "$app_dir/var/log"
symfony_constraint="${LOGBREW_SYMFONY_CONSTRAINT:-^6.4 || ^7.0 || ^8.0}"

cat > "$app_dir/composer.json" <<'JSON'
{
  "name": "logbrew/symfony-installed-smoke",
  "type": "project",
  "require": {
    "php": "^8.2",
    "logbrew/sdk": "0.1.0",
    "symfony/console": "^6.4 || ^7.0 || ^8.0",
    "symfony/framework-bundle": "^6.4 || ^7.0 || ^8.0",
    "symfony/monolog-bundle": "^3.10 || ^4.0",
    "symfony/yaml": "^6.4 || ^7.0 || ^8.0"
  },
  "repositories": [
    {"type": "artifact", "url": "../artifacts"}
  ],
  "autoload": {
    "psr-4": {"App\\": "src/"}
  }
}
JSON

php -r '
$path = $argv[1];
$constraint = $argv[2];
$manifest = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
foreach (["symfony/console", "symfony/framework-bundle", "symfony/yaml"] as $package) {
    $manifest["require"][$package] = $constraint;
}
file_put_contents($path, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL);
' "$app_dir/composer.json" "$symfony_constraint"

composer install --working-dir="$app_dir" --no-interaction --no-progress --prefer-dist
test -f "$app_dir/vendor/logbrew/sdk/src/Symfony/LogBrewBundle.php"
test -f "$app_dir/vendor/logbrew/sdk/src/Symfony/SymfonyTelemetry.php"
test -f "$app_dir/vendor/logbrew/sdk/src/Symfony/SymfonyRequestSubscriber.php"
test -f "$app_dir/vendor/logbrew/sdk/src/Symfony/SymfonyStatusCommand.php"

no_monolog_dir="$tmp_dir/symfony-without-monolog"
mkdir -p "$no_monolog_dir/bin" "$no_monolog_dir/config/packages" "$no_monolog_dir/src" "$no_monolog_dir/var/cache" "$no_monolog_dir/var/log"

cat > "$no_monolog_dir/composer.json" <<'JSON'
{
  "name": "logbrew/symfony-without-monolog",
  "type": "project",
  "require": {
    "php": "^8.2",
    "logbrew/sdk": "0.1.0",
    "symfony/console": "^6.4 || ^7.0 || ^8.0",
    "symfony/framework-bundle": "^6.4 || ^7.0 || ^8.0",
    "symfony/yaml": "^6.4 || ^7.0 || ^8.0"
  },
  "repositories": [
    {"type": "artifact", "url": "../artifacts"}
  ],
  "autoload": {
    "psr-4": {"AppWithoutMonolog\\": "src/"}
  }
}
JSON

php -r '
$path = $argv[1];
$constraint = $argv[2];
$manifest = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
foreach (["symfony/console", "symfony/framework-bundle", "symfony/yaml"] as $package) {
    $manifest["require"][$package] = $constraint;
}
file_put_contents($path, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL);
' "$no_monolog_dir/composer.json" "$symfony_constraint"

composer install --working-dir="$no_monolog_dir" --no-interaction --no-progress --prefer-dist
if composer show --working-dir="$no_monolog_dir" monolog/monolog >/dev/null 2>&1; then
  echo "unexpected Monolog package in optional-dependency smoke" >&2
  exit 1
fi

cat > "$no_monolog_dir/config/bundles.php" <<'PHP'
<?php

return [
    Symfony\Bundle\FrameworkBundle\FrameworkBundle::class => ['all' => true],
    LogBrew\Symfony\LogBrewBundle::class => ['all' => true],
];
PHP

cat > "$no_monolog_dir/config/packages/framework.yaml" <<'YAML'
framework:
  router:
    resource: 'kernel::loadRoutes'
YAML

cat > "$no_monolog_dir/src/Kernel.php" <<'PHP'
<?php

declare(strict_types=1);

namespace AppWithoutMonolog;

use Symfony\Bundle\FrameworkBundle\Kernel\MicroKernelTrait;
use Symfony\Component\HttpKernel\Kernel as BaseKernel;

final class Kernel extends BaseKernel
{
    use MicroKernelTrait;
}
PHP

cat > "$no_monolog_dir/bin/console" <<'PHP'
#!/usr/bin/env php
<?php

declare(strict_types=1);

use AppWithoutMonolog\Kernel;
use Symfony\Bundle\FrameworkBundle\Console\Application;

require dirname(__DIR__) . '/vendor/autoload.php';

$application = new Application(new Kernel('test', false));
exit($application->run());
PHP

set +e
php "$no_monolog_dir/bin/console" logbrew:status --json > "$tmp_dir/no-monolog-status.json"
no_monolog_status="$?"
set -e
if [[ "$no_monolog_status" -ne 2 ]]; then
  echo "unexpected no-Monolog Symfony status exit" >&2
  exit 1
fi
php -r '
$status = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($status["reason"] ?? null) !== "missing_api_key" || ($status["active"] ?? null) !== false) {
    fwrite(STDERR, "unexpected no-Monolog Symfony status\n");
    exit(1);
}
' "$tmp_dir/no-monolog-status.json"

cat > "$app_dir/config/bundles.php" <<'PHP'
<?php

return [
    Symfony\Bundle\FrameworkBundle\FrameworkBundle::class => ['all' => true],
    Symfony\Bundle\MonologBundle\MonologBundle::class => ['all' => true],
    LogBrew\Symfony\LogBrewBundle::class => ['all' => true],
];
PHP

cat > "$app_dir/config/packages/framework.yaml" <<'YAML'
framework:
  router:
    resource: 'kernel::loadRoutes'
    utf8: true
YAML

cat > "$app_dir/config/packages/log_brew.yaml" <<'YAML'
log_brew:
  api_key: '%env(LOGBREW_SERVER_API_KEY)%'
  endpoint: '%env(LOGBREW_TEST_ENDPOINT)%'
  service: 'symfony-installed-smoke'
  release: '1.0.0'
  environment: 'test'
  timeout: 2.0
  max_retries: 0
YAML

cat > "$app_dir/config/services.yaml" <<'YAML'
services:
  _defaults:
    autowire: true
    autoconfigure: true

  App\:
    resource: '../src/'
    exclude: '../src/Kernel.php'
YAML

cat > "$app_dir/config/routes.yaml" <<'YAML'
smoke_ok:
  path: /orders/{orderId}
  controller: App\Controller\SmokeController::ok

smoke_failure:
  path: /failures/{failureId}
  controller: App\Controller\SmokeController::failure
YAML

cat > "$app_dir/src/Kernel.php" <<'PHP'
<?php

declare(strict_types=1);

namespace App;

use Symfony\Bundle\FrameworkBundle\Kernel\MicroKernelTrait;
use Symfony\Component\HttpKernel\Kernel as BaseKernel;

final class Kernel extends BaseKernel
{
    use MicroKernelTrait;
}
PHP

cat > "$app_dir/src/Controller/SmokeController.php" <<'PHP'
<?php

declare(strict_types=1);

namespace App\Controller;

use Psr\Log\LoggerInterface;
use RuntimeException;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Attribute\AsController;

#[AsController]
final class SmokeController
{
    public function __construct(private readonly LoggerInterface $logger)
    {
    }

    public function ok(): Response
    {
        $this->logger->warning('Symfony installed smoke warning', ['probe' => 'safe']);
        return new Response('', 204);
    }

    public function failure(): Response
    {
        throw new RuntimeException('sensitive Symfony smoke exception message');
    }
}
PHP

cat > "$app_dir/src/EventSubscriber/SmokeExceptionResponder.php" <<'PHP'
<?php

declare(strict_types=1);

namespace App\EventSubscriber;

use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\ExceptionEvent;
use Symfony\Component\HttpKernel\KernelEvents;

final class SmokeExceptionResponder implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [KernelEvents::EXCEPTION => ['onKernelException', -64]];
    }

    public function onKernelException(ExceptionEvent $event): void
    {
        $event->setResponse(new Response('', 500));
    }
}
PHP

cat > "$app_dir/bin/console" <<'PHP'
#!/usr/bin/env php
<?php

declare(strict_types=1);

use App\Kernel;
use Symfony\Bundle\FrameworkBundle\Console\Application;

require dirname(__DIR__) . '/vendor/autoload.php';

$kernel = new Kernel($_SERVER['APP_ENV'] ?? 'test', (bool) ($_SERVER['APP_DEBUG'] ?? false));
$application = new Application($kernel);
exit($application->run());
PHP

cat > "$app_dir/probe.php" <<'PHP'
<?php

declare(strict_types=1);

use App\Kernel;
use Symfony\Component\HttpFoundation\Request;

require __DIR__ . '/vendor/autoload.php';

$kernel = new Kernel('test', false);
$kernel->boot();

$okRequest = Request::create(
    '/orders/concrete-order-value?query_key=query-value-marker',
    'GET',
    server: ['HTTP_TRACEPARENT' => '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01']
);
$okResponse = $kernel->handle($okRequest);
if ($okResponse->getStatusCode() !== 204) {
    fwrite(STDERR, sprintf(
        "unexpected successful response: %d %s\n",
        $okResponse->getStatusCode(),
        $okResponse->getContent()
    ));
    exit(1);
}
$kernel->terminate($okRequest, $okResponse);

$failureRequest = Request::create('/failures/concrete-failure-value?authorization=query-value-marker', 'POST');
$failureResponse = $kernel->handle($failureRequest);
if ($failureResponse->getStatusCode() !== 500) {
    fwrite(STDERR, sprintf(
        "unexpected failure response: %d %s\n",
        $failureResponse->getStatusCode(),
        $failureResponse->getContent()
    ));
    exit(1);
}
$kernel->terminate($failureRequest, $failureResponse);
$kernel->shutdown();
PHP

cat > "$tmp_dir/intake-router.php" <<'PHP'
<?php

declare(strict_types=1);

if (($_SERVER['REQUEST_URI'] ?? '') === '/health') {
    http_response_code(204);
    exit;
}

$captureDir = getenv('LOGBREW_CAPTURE_DIR');
if (!is_string($captureDir) || $captureDir === '') {
    http_response_code(500);
    exit;
}

$counterPath = $captureDir . '/counter';
$counter = fopen($counterPath, 'c+');
if ($counter === false) {
    http_response_code(500);
    exit;
}
flock($counter, LOCK_EX);
$rawCounter = stream_get_contents($counter);
$number = (int) ($rawCounter === false ? '0' : trim($rawCounter)) + 1;
rewind($counter);
ftruncate($counter, 0);
fwrite($counter, (string) $number);
fflush($counter);
flock($counter, LOCK_UN);
fclose($counter);

$body = file_get_contents('php://input');
$capture = [
    'authorization' => $_SERVER['HTTP_AUTHORIZATION'] ?? null,
    'contentType' => $_SERVER['CONTENT_TYPE'] ?? null,
    'body' => $body === false ? '' : $body,
];
file_put_contents(
    sprintf('%s/request-%02d.json', $captureDir, $number),
    json_encode($capture, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES)
);

http_response_code(202);
header('content-type: application/json');
echo '{"accepted":true}';
PHP

port="$(php -r '
$socket = stream_socket_server("tcp://127.0.0.1:0", $errorCode, $errorMessage);
if ($socket === false) {
    fwrite(STDERR, $errorMessage . PHP_EOL);
    exit(1);
}
$name = stream_socket_get_name($socket, false);
fclose($socket);
echo substr(strrchr((string) $name, ":"), 1);
')"

export LOGBREW_CAPTURE_DIR="$tmp_dir/captures"
export LOGBREW_SERVER_API_KEY="fixture-key"
export LOGBREW_TEST_ENDPOINT="http://127.0.0.1:$port/v1/events"
export APP_ENV=test
export APP_DEBUG=0

php -S "127.0.0.1:$port" "$tmp_dir/intake-router.php" > "$tmp_dir/intake-server.log" 2>&1 &
server_pid="$!"

for _ in $(seq 1 100); do
  if curl --silent --fail "http://127.0.0.1:$port/health" >/dev/null; then
    break
  fi
  sleep 0.05
done
curl --silent --fail "http://127.0.0.1:$port/health" >/dev/null

php "$app_dir/bin/console" logbrew:status --send-probe --json > "$tmp_dir/status.json"
php "$app_dir/probe.php"

php -r '
$status = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($status["reason"] ?? null) !== "ready" || ($status["delivery"] ?? null) !== "accepted" || ($status["statusCode"] ?? null) !== 202) {
    fwrite(STDERR, "unexpected Symfony status output\n");
    exit(1);
}

$files = glob($argv[2] . "/request-*.json") ?: [];
sort($files);
if (count($files) !== 4) {
    fwrite(STDERR, "unexpected Symfony delivery count: " . count($files) . "\n");
    exit(1);
}

$events = [];
$bodies = "";
foreach ($files as $file) {
    $capture = json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
    if (($capture["authorization"] ?? null) !== "Bearer fixture-key") {
        fwrite(STDERR, "unexpected Symfony authorization header\n");
        exit(1);
    }
    $body = $capture["body"] ?? null;
    if (!is_string($body)) {
        fwrite(STDERR, "missing Symfony body\n");
        exit(1);
    }
    $bodies .= $body;
    $payload = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    if (($payload["sdk"]["name"] ?? null) !== "logbrew-php-symfony" || ($payload["sdk"]["version"] ?? null) !== "0.1.0") {
        fwrite(STDERR, "unexpected Symfony SDK identity\n");
        exit(1);
    }
    foreach (($payload["events"] ?? []) as $event) {
        $events[] = $event;
    }
}

if (count($events) !== 5) {
    fwrite(STDERR, "unexpected Symfony event count\n");
    exit(1);
}
$types = array_count_values(array_map(static fn (array $event): string => (string) ($event["type"] ?? ""), $events));
if (($types["log"] ?? 0) !== 2 || ($types["span"] ?? 0) !== 2 || ($types["issue"] ?? 0) !== 1) {
    fwrite(STDERR, "unexpected Symfony event types\n");
    exit(1);
}

$issue = null;
$spanNames = [];
foreach ($events as $event) {
    if (($event["type"] ?? null) === "issue") {
        $issue = $event;
    }
    if (($event["type"] ?? null) === "span") {
        $spanNames[] = $event["attributes"]["name"] ?? null;
    }
}
if (!in_array("GET symfony.route.smoke_ok", $spanNames, true) || !in_array("POST symfony.route.smoke_failure", $spanNames, true)) {
    fwrite(STDERR, "missing Symfony route spans\n");
    exit(1);
}
if (!is_array($issue)) {
    fwrite(STDERR, "missing Symfony exception issue\n");
    exit(1);
}
$metadata = $issue["attributes"]["metadata"] ?? [];
if (
    ($issue["attributes"]["title"] ?? null) !== RuntimeException::class
    || ($metadata["exceptionType"] ?? null) !== RuntimeException::class
    || ($metadata["errorName"] ?? null) !== RuntimeException::class
    || preg_match("/^symfony-exception-[0-9a-f]{64}$/", (string) ($metadata["issueGroupingKey"] ?? "")) !== 1
    || ($metadata["issueGroupingSource"] ?? null) !== "exception_type_route_file"
    || ($metadata["errorFrameFile"] ?? null) !== "SmokeController.php"
    || !is_int($metadata["errorFrameLine"] ?? null)
    || ($metadata["handled"] ?? null) !== false
    || ($metadata["mechanism"] ?? null) !== "symfony.kernel_exception"
) {
    fwrite(STDERR, "unexpected Symfony exception metadata\n");
    exit(1);
}

foreach ([
    "concrete-order-value",
    "query-value-marker",
    "concrete-failure-value",
    "sensitive Symfony smoke exception message",
    "HTTP_TRACEPARENT",
    "00-4bf92",
    $argv[3],
    "LOGBREW_SERVER_API_KEY"
] as $forbidden) {
    if (str_contains($bodies, $forbidden)) {
        fwrite(STDERR, "Symfony payload contained forbidden input\n");
        exit(1);
    }
}

require $argv[3] . "/vendor/autoload.php";
$symfonyVersion = Composer\InstalledVersions::getPrettyVersion("symfony/framework-bundle") ?? "unknown";
echo "PHP Symfony installed-app smoke passed (Symfony {$symfonyVersion}; 4 deliveries, 5 events)\n";
' "$tmp_dir/status.json" "$tmp_dir/captures" "$app_dir"
