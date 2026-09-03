#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

export COMPOSER_HOME="$tmp_dir/composer-home"
export COMPOSER_CACHE_DIR="$tmp_dir/composer-cache"

cd "$tmp_dir"

assert_installed_package() {
  local package_file
  for package_file in \
    README.md \
    composer.json \
    src/HttpTransport.php \
    src/IssueDiagnostics.php \
    src/ProductTimeline.php \
    src/Traceparent.php \
    src/TraceparentContext.php \
    src/TraceparentSpanInput.php \
    src/LogBrewTraceContext.php \
    src/LogBrewTraceScope.php \
    src/LogBrewTrace.php \
    src/LogBrewOperationTracing.php \
    src/LogBrewHttpRequestTelemetry.php \
    src/LogBrewMonologHandler.php \
    src/LaravelLoggerFactory.php \
    src/LogBrewLaravelQueueTelemetry.php \
    src/LogBrewPsrLogger.php \
    src/SupportTicketDraft.php \
    examples/readme_example.php \
    examples/real_user_smoke.php \
    examples/first_useful_telemetry.php \
    examples/issue_diagnostics.php \
    examples/http_trace_correlation.php \
    examples/worker_lifecycle.php \
    examples/persistent_worker_delivery.php \
    examples/Makefile; do
    test -f "vendor/logbrew/sdk/$package_file"
  done
  php -l vendor/logbrew/sdk/examples/worker_lifecycle.php >/dev/null
  php -l vendor/logbrew/sdk/examples/persistent_worker_delivery.php >/dev/null
  php -l vendor/logbrew/sdk/examples/issue_diagnostics.php >/dev/null
  test -f vendor/composer/installed.json
  test -f vendor/composer/autoload_psr4.php
}

assert_event_types() {
  local output_file="$1" event_type
  shift
  for event_type in "$@"; do
    grep -q "\"type\": \"$event_type\"" "$output_file"
  done
}

mkdir -p artifacts "$COMPOSER_HOME" "$COMPOSER_CACHE_DIR"
archive_src="$tmp_dir/logbrew-php"
cp -R "$repo_root/php/logbrew-php" "$archive_src"
rm -rf "$archive_src/vendor" "$archive_src/composer.lock"
php -r '
$path = $argv[1];
$data = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
$data["version"] = "0.1.0";
file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL);
' "$archive_src/composer.json"
(cd "$archive_src" && composer archive --format=zip --dir "$tmp_dir/artifacts" --file logbrew-sdk --quiet)
archive_path="$tmp_dir/artifacts/logbrew-sdk.zip"
test -f "$archive_path"
php -r '
$zip = new ZipArchive();
if ($zip->open($argv[1]) !== true) {
    fwrite(STDERR, "failed to open composer archive\n");
    exit(1);
}
$paths = [
    "composerJson" => "composer.json",
    "readme" => "README.md",
    "readmeExample" => "examples/readme_example.php",
    "example" => "examples/real_user_smoke.php",
    "firstUsefulExample" => "examples/first_useful_telemetry.php",
    "issueDiagnosticsExample" => "examples/issue_diagnostics.php",
    "httpTraceExample" => "examples/http_trace_correlation.php",
    "workerLifecycleExample" => "examples/worker_lifecycle.php",
    "persistentWorkerDeliveryExample" => "examples/persistent_worker_delivery.php",
    "exampleMakefile" => "examples/Makefile",
    "httpTransport" => "src/HttpTransport.php",
    "issueDiagnostics" => "src/IssueDiagnostics.php",
    "productTimeline" => "src/ProductTimeline.php",
    "traceparent" => "src/Traceparent.php",
    "traceparentContext" => "src/TraceparentContext.php",
    "traceparentSpanInput" => "src/TraceparentSpanInput.php",
    "traceContext" => "src/LogBrewTraceContext.php",
    "traceScope" => "src/LogBrewTraceScope.php",
    "trace" => "src/LogBrewTrace.php",
    "operationTracing" => "src/LogBrewOperationTracing.php",
    "httpRequestTelemetry" => "src/LogBrewHttpRequestTelemetry.php",
    "psrLogger" => "src/LogBrewPsrLogger.php",
    "monologHandler" => "src/LogBrewMonologHandler.php",
    "laravelLoggerFactory" => "src/LaravelLoggerFactory.php",
    "laravelQueueTelemetry" => "src/LogBrewLaravelQueueTelemetry.php",
    "supportTicketDraft" => "src/SupportTicketDraft.php",
];
$contents = array_fill_keys(array_keys($paths), null);
for ($i = 0; $i < $zip->numFiles; $i++) {
    $name = $zip->getNameIndex($i);
    if ($name === false) {
        continue;
    }
    foreach ($paths as $key => $path) {
        if ($name === $path || str_ends_with($name, "/{$path}")) {
            $contents[$key] = $zip->getFromIndex($i);
        }
    }
}
$zip->close();
foreach ($contents as $key => $content) {
    if (!is_string($content)) {
        fwrite(STDERR, "missing {$paths[$key]} in composer archive\n");
        exit(1);
    }
}
extract($contents, EXTR_SKIP);
$manifest = json_decode($composerJson, true, 512, JSON_THROW_ON_ERROR);
if (($manifest["name"] ?? null) !== "logbrew/sdk") {
    fwrite(STDERR, "unexpected composer archive package name\n");
    exit(1);
}
if (($manifest["require"]["php"] ?? null) !== "^8.2") {
    fwrite(STDERR, "unexpected composer archive php constraint\n");
    exit(1);
}
if (($manifest["require"]["psr/log"] ?? null) !== "^3.0") {
    fwrite(STDERR, "unexpected composer archive psr/log constraint\n");
    exit(1);
}
if (($manifest["require-dev"]["monolog/monolog"] ?? null) !== "^3.0") {
    fwrite(STDERR, "unexpected composer archive monolog dev constraint\n");
    exit(1);
}
if (($manifest["suggest"]["monolog/monolog"] ?? null) !== "Required for Monolog and Laravel logging channels."
    || ($manifest["suggest"]["laravel/framework"] ?? null) !== "Required for Laravel queue job tracing.") {
    fwrite(STDERR, "unexpected composer archive monolog suggestion\n");
    exit(1);
}
if (($manifest["autoload"]["psr-4"]["LogBrew\\"] ?? null) !== "src/") {
    fwrite(STDERR, "unexpected composer archive psr-4 mapping\n");
    exit(1);
}
foreach ([
    "composer require logbrew/sdk" => "missing composer archive README install command\n",
    "LOGBREW_API_KEY" => "missing composer archive fake API key placeholder\n",
    "previewJson()" => "missing composer archive previewJson guidance\n",
    "IssueDiagnostics::fromThrowable" => "missing composer archive typed issue diagnostics guidance\n",
    "make run-issue-diagnostics" => "missing composer archive issue diagnostics example guidance\n",
    "never copies raw trace text, arguments, locals, source text, or absolute source paths" => "missing composer archive issue diagnostics privacy guidance\n",
    "MetricAttributes" => "missing composer archive metric guidance\n",
    "Metrics answer aggregate questions" => "missing composer archive metric purpose guidance\n",
    "The runtime identity described above is context, not a runtime measurement" => "missing composer archive context-versus-metric guidance\n",
    "does not automatically collect PHP memory, CPU, FPM, framework, or database metrics yet." => "missing composer archive metric auto-capture guidance\n",
    "ProductTimeline" => "missing composer archive timeline guidance\n",
    "without visual replay, HTTP client patching, request/response payload capture, or header capture" => "missing composer archive timeline privacy guidance\n",
    "Traceparent" => "missing composer archive traceparent guidance\n",
    "LogBrewHttpRequestTelemetry" => "missing composer archive HTTP request trace guidance\n",
    "LogBrewTrace::current()" => "missing composer archive active trace guidance\n",
    "metadataWithCurrentTrace" => "missing composer archive trace metadata guidance\n",
    "run-http-trace-correlation" => "missing composer archive HTTP trace example guidance\n",
    "LogBrewOperationTracing" => "missing composer archive operation tracing guidance\n",
    "Dependency Spans" => "missing composer archive dependency spans heading\n",
    "databaseOperation" => "missing composer archive database operation guidance\n",
    "cacheOperation" => "missing composer archive cache operation guidance\n",
    "queueOperation" => "missing composer archive queue operation guidance\n",
    "they avoid SQL text, connection strings, network locations, login fields, cache identifiers" => "missing composer archive operation privacy guidance\n",
    "first useful PHP service telemetry" => "missing composer archive first useful telemetry guidance\n",
    "HttpTransport" => "missing composer archive HTTP transport guidance\n",
    "HTTP Delivery" => "missing composer archive HTTP delivery heading\n",
    "HttpTransport::DEFAULT_ENDPOINT" => "missing composer archive HTTP endpoint guidance\n",
    "LogBrewPsrLogger" => "missing composer archive PSR logger guidance\n",
    "PSR-3 Logger" => "missing composer archive PSR logger heading\n",
    "LogBrewMonologHandler" => "missing composer archive Monolog handler guidance\n",
    "LaravelLoggerFactory" => "missing composer archive Laravel factory guidance\n",
    "registerQueueTelemetry" => "missing composer archive Laravel queue guidance\n",
    "laravel.queue" => "missing composer archive Laravel queue privacy guidance\n",
    "Laravel Quick Start" => "missing composer archive Laravel heading\n",
    "config:cache" => "missing composer archive Laravel config-cache guidance\n",
    "LOGBREW_SERVER_API_KEY" => "missing composer archive canonical Laravel server-key guidance\n",
    "immediately flushes every accepted record" => "missing composer archive Laravel delivery-boundary guidance\n",
    "SupportTicketDraft" => "missing composer archive support ticket draft guidance\n",
    "does not open a ticket, call backend support routes, send telemetry, or use account/session API credentials" => "missing composer archive support ticket boundary guidance\n",
    "token-free diagnostics" => "missing composer archive support ticket diagnostics guidance\n",
    "config/logging.php" => "missing composer archive Laravel logging config guidance\n",
    "Log::channel" => "missing composer archive Laravel channel guidance\n",
    "warning(...)" => "missing composer archive Laravel warning guidance\n",
    "copyable examples for PHP services" => "missing composer archive copyable examples guidance\n",
    "keep the real key in app configuration" => "missing composer archive app configuration guidance\n",
    "before sending" => "missing composer archive local preview guidance\n",
] as $needle => $message) {
    if (!str_contains($readme, $needle)) {
        fwrite(STDERR, $message);
        exit(1);
    }
}
if (!str_contains($readmeExample, "../vendor/autoload.php") || !str_contains($readmeExample, "../../../autoload.php")) {
    fwrite(STDERR, "missing composer archive dual-context autoload support in shipped README example\n");
    exit(1);
}
if (!str_contains($example, "../vendor/autoload.php") || !str_contains($example, "../../../autoload.php")) {
    fwrite(STDERR, "missing composer archive dual-context autoload support in shipped example\n");
    exit(1);
}
if (!str_contains($firstUsefulExample, "../vendor/autoload.php") || !str_contains($firstUsefulExample, "../../../autoload.php")) {
    fwrite(STDERR, "missing composer archive dual-context autoload support in first-useful example\n");
    exit(1);
}
if (!str_contains($issueDiagnosticsExample, "../vendor/autoload.php") || !str_contains($issueDiagnosticsExample, "../../../autoload.php")) {
    fwrite(STDERR, "missing composer archive dual-context autoload support in issue diagnostics example\n");
    exit(1);
}
if (!str_contains($httpTraceExample, "../vendor/autoload.php") || !str_contains($httpTraceExample, "../../../autoload.php")) {
    fwrite(STDERR, "missing composer archive dual-context autoload support in HTTP trace example\n");
    exit(1);
}
if (!str_contains($exampleMakefile, ".PHONY: help run run-readme-example run-real-user-smoke run-first-useful-telemetry run-issue-diagnostics run-http-trace-correlation run-worker-lifecycle run-persistent-worker-delivery")
    || !str_contains($exampleMakefile, "help:")
    || !str_contains($exampleMakefile, "run: run-real-user-smoke")
    || !str_contains($exampleMakefile, "run-readme-example:")
    || !str_contains($exampleMakefile, "@php readme_example.php")
    || !str_contains($exampleMakefile, "run-real-user-smoke:")
    || !str_contains($exampleMakefile, "@php real_user_smoke.php")
    || !str_contains($exampleMakefile, "run-first-useful-telemetry:")
    || !str_contains($exampleMakefile, "@php first_useful_telemetry.php")
    || !str_contains($exampleMakefile, "run-issue-diagnostics:")
    || !str_contains($exampleMakefile, "@php issue_diagnostics.php")
    || !str_contains($exampleMakefile, "run-http-trace-correlation:")
    || !str_contains($exampleMakefile, "@php http_trace_correlation.php")
    || !str_contains($exampleMakefile, "run-worker-lifecycle:")
    || !str_contains($exampleMakefile, "@php worker_lifecycle.php")
    || !str_contains($exampleMakefile, "run-persistent-worker-delivery:")
    || !str_contains($exampleMakefile, "@php persistent_worker_delivery.php")
    || !str_contains($exampleMakefile, "run-readme-example -> make run-readme-example")
    || !str_contains($exampleMakefile, "run (real-user-smoke) -> make run")
    || !str_contains($exampleMakefile, "run-real-user-smoke -> make run-real-user-smoke")
    || !str_contains($exampleMakefile, "run-first-useful-telemetry -> make run-first-useful-telemetry")
    || !str_contains($exampleMakefile, "run-issue-diagnostics -> make run-issue-diagnostics")
    || !str_contains($exampleMakefile, "run-http-trace-correlation -> make run-http-trace-correlation")
    || !str_contains($exampleMakefile, "run-worker-lifecycle -> make run-worker-lifecycle")
    || !str_contains($exampleMakefile, "run-persistent-worker-delivery -> make run-persistent-worker-delivery")) {
    fwrite(STDERR, "missing composer archive example Makefile helper\n");
    exit(1);
}
' "$archive_path"

composer init --name=smoke/app --type=project --stability=stable --license=proprietary --no-interaction --quiet
composer config version 0.1.0 --no-interaction
composer config prefer-stable true --no-interaction
composer config repositories.artifacts artifact "$tmp_dir/artifacts" --no-interaction

composer require logbrew/sdk:0.1.0 --no-interaction --quiet
composer validate --no-check-publish --no-check-version --strict >/dev/null
test -f composer.lock
composer show logbrew/sdk > composer-show-plain.txt
grep -q '^name     : logbrew/sdk$' composer-show-plain.txt
grep -q '^descrip\. : Public LogBrew PHP SDK for building, validating, and flushing event batches\.$' composer-show-plain.txt
grep -q '^versions : \* 0\.1\.0$' composer-show-plain.txt
grep -q '^type     : library$' composer-show-plain.txt
grep -q '^license  : MIT License (MIT) (OSI approved) https://spdx\.org/licenses/MIT\.html#licenseText$' composer-show-plain.txt
grep -q '^dist     : \[zip\] .*/artifacts/logbrew-sdk\.zip $' composer-show-plain.txt
grep -q '^path     : .*/vendor/logbrew/sdk$' composer-show-plain.txt
grep -q '^names    : logbrew/sdk$' composer-show-plain.txt
grep -q '^autoload$' composer-show-plain.txt
grep -q '^psr-4$' composer-show-plain.txt
grep -q '^LogBrew\\ => src/$' composer-show-plain.txt
grep -q '^requires$' composer-show-plain.txt
grep -q '^php \^8\.2$' composer-show-plain.txt
grep -q '^psr/log \^3\.0$' composer-show-plain.txt
composer show logbrew/sdk --format=json > composer-show.json
composer why logbrew/sdk > composer-why.txt
grep -q '^smoke/app 0.1.0 requires logbrew/sdk (0.1.0)' composer-why.txt
composer why logbrew/sdk --tree > composer-why-tree.txt
grep -q '^logbrew/sdk 0.1.0 ' composer-why-tree.txt
grep -q '^`--smoke/app 0.1.0 (requires logbrew/sdk 0.1.0)' composer-why-tree.txt
composer licenses --format=json > composer-licenses.json
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($data["name"] ?? null) !== "smoke/app") {
    fwrite(STDERR, "unexpected composer licenses root project name\n");
    exit(1);
}
$deps = $data["dependencies"] ?? [];
$package = $deps["logbrew/sdk"] ?? null;
if (!is_array($package)) {
    fwrite(STDERR, "missing composer licenses dependency entry\n");
    exit(1);
}
if (($package["version"] ?? null) !== "0.1.0") {
    fwrite(STDERR, "unexpected composer licenses dependency version\n");
    exit(1);
}
$licenses = $package["license"] ?? [];
if ($licenses !== ["MIT"]) {
    fwrite(STDERR, "unexpected composer licenses dependency license\n");
    exit(1);
}
' composer-licenses.json
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($data["require"]["logbrew/sdk"] ?? null) !== "0.1.0") {
    fwrite(STDERR, "unexpected root composer require entry\n");
    exit(1);
}
' composer.json
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($data["name"] ?? null) !== "logbrew/sdk") {
    fwrite(STDERR, "unexpected composer package name\n");
    exit(1);
}
if (($data["description"] ?? null) !== "Public LogBrew PHP SDK for building, validating, and flushing event batches.") {
    fwrite(STDERR, "unexpected composer package description\n");
    exit(1);
}
if (($data["type"] ?? null) !== "library") {
    fwrite(STDERR, "unexpected composer package type\n");
    exit(1);
}
if (($data["versions"][0] ?? null) !== "0.1.0") {
    fwrite(STDERR, "unexpected composer package version\n");
    exit(1);
}
$licenses = $data["licenses"] ?? [];
if (($licenses[0]["osi"] ?? null) !== "MIT") {
    fwrite(STDERR, "unexpected composer package license metadata\n");
    exit(1);
}
if (($data["dist"]["type"] ?? null) !== "zip") {
    fwrite(STDERR, "unexpected composer package dist type\n");
    exit(1);
}
$distUrl = (string) ($data["dist"]["url"] ?? "");
if (basename($distUrl) !== "logbrew-sdk.zip") {
    fwrite(STDERR, "unexpected composer package dist url\n");
    exit(1);
}
$path = str_replace("\\", "/", (string) ($data["path"] ?? ""));
if (!str_ends_with($path, "/vendor/logbrew/sdk")) {
    fwrite(STDERR, "unexpected composer package install path\n");
    exit(1);
}
if (($data["autoload"]["psr-4"]["LogBrew\\"] ?? null) !== "src/") {
    fwrite(STDERR, "unexpected composer package autoload mapping\n");
    exit(1);
}
if (($data["requires"]["php"] ?? null) !== "^8.2") {
    fwrite(STDERR, "unexpected composer package php requirement\n");
    exit(1);
}
if (($data["requires"]["psr/log"] ?? null) !== "^3.0") {
    fwrite(STDERR, "unexpected composer package psr/log requirement\n");
    exit(1);
}
' composer-show.json
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
$packages = $data["packages"] ?? [];
$match = null;
foreach ($packages as $package) {
    if (($package["name"] ?? null) === "logbrew/sdk") {
        $match = $package;
        break;
    }
}
if (!is_array($match)) {
    fwrite(STDERR, "missing composer.lock package entry\n");
    exit(1);
}
if (($match["version"] ?? null) !== "0.1.0") {
    fwrite(STDERR, "unexpected composer.lock package version\n");
    exit(1);
}
if (($match["dist"]["type"] ?? null) !== "zip") {
    fwrite(STDERR, "unexpected composer.lock dist type\n");
    exit(1);
}
$distUrl = (string) ($match["dist"]["url"] ?? "");
if (basename($distUrl) !== "logbrew-sdk.zip") {
    fwrite(STDERR, "unexpected composer.lock dist url\n");
    exit(1);
}
if (($match["autoload"]["psr-4"]["LogBrew\\"] ?? null) !== "src/") {
    fwrite(STDERR, "unexpected composer.lock psr-4 mapping\n");
    exit(1);
}
if (($match["require"]["psr/log"] ?? null) !== "^3.0") {
    fwrite(STDERR, "unexpected composer.lock psr/log requirement\n");
    exit(1);
}
$psrLog = null;
foreach ($packages as $package) {
    if (($package["name"] ?? null) === "psr/log") {
        $psrLog = $package;
        break;
    }
}
if (!is_array($psrLog)) {
    fwrite(STDERR, "missing composer.lock psr/log package entry\n");
    exit(1);
}
' composer.lock
assert_installed_package
(cd vendor/logbrew/sdk/examples && make) > vendor-example-make-help.txt
grep -qx 'run-readme-example -> make run-readme-example' <(sed -n '1p' vendor-example-make-help.txt)
grep -qx 'run (real-user-smoke) -> make run' <(sed -n '2p' vendor-example-make-help.txt)
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' <(sed -n '3p' vendor-example-make-help.txt)
grep -qx 'run-first-useful-telemetry -> make run-first-useful-telemetry' <(sed -n '4p' vendor-example-make-help.txt)
grep -qx 'run-issue-diagnostics -> make run-issue-diagnostics' <(sed -n '5p' vendor-example-make-help.txt)
grep -qx 'run-http-trace-correlation -> make run-http-trace-correlation' <(sed -n '6p' vendor-example-make-help.txt)
grep -qx 'run-worker-lifecycle -> make run-worker-lifecycle' <(sed -n '7p' vendor-example-make-help.txt)
grep -qx 'run-persistent-worker-delivery -> make run-persistent-worker-delivery' <(sed -n '8p' vendor-example-make-help.txt)
test "$(wc -l < vendor-example-make-help.txt | tr -d ' ')" = "8"
php -r '
$readme = file_get_contents($argv[1]);
if ($readme === false) {
    fwrite(STDERR, "failed to read installed README\n");
    exit(1);
}
foreach ([
    "composer require logbrew/sdk" => "missing installed README composer install command\n",
    "LOGBREW_API_KEY" => "missing installed README fake API key placeholder\n",
    "previewJson()" => "missing installed README previewJson guidance\n",
    "IssueDiagnostics::fromThrowable" => "missing installed README typed issue diagnostics guidance\n",
    "make run-issue-diagnostics" => "missing installed README issue diagnostics example guidance\n",
    "never copies raw trace text, arguments, locals, source text, or absolute source paths" => "missing installed README issue diagnostics privacy guidance\n",
    "MetricAttributes" => "missing installed README metric guidance\n",
    "Metrics answer aggregate questions" => "missing installed README metric purpose guidance\n",
    "The runtime identity described above is context, not a runtime measurement" => "missing installed README context-versus-metric guidance\n",
    "does not automatically collect PHP memory, CPU, FPM, framework, or database metrics yet." => "missing installed README metric auto-capture guidance\n",
    "ProductTimeline" => "missing installed README timeline guidance\n",
    "without visual replay, HTTP client patching, request/response payload capture, or header capture" => "missing installed README timeline privacy guidance\n",
    "Traceparent" => "missing installed README traceparent guidance\n",
    "LogBrewHttpRequestTelemetry" => "missing installed README HTTP request trace guidance\n",
    "LogBrewTrace::current()" => "missing installed README active trace guidance\n",
    "metadataWithCurrentTrace" => "missing installed README trace metadata guidance\n",
    "run-http-trace-correlation" => "missing installed README HTTP trace example guidance\n",
    "LogBrewOperationTracing" => "missing installed README operation tracing guidance\n",
    "Dependency Spans" => "missing installed README dependency spans heading\n",
    "databaseOperation" => "missing installed README database operation guidance\n",
    "cacheOperation" => "missing installed README cache operation guidance\n",
    "queueOperation" => "missing installed README queue operation guidance\n",
    "they avoid SQL text, connection strings, network locations, login fields, cache identifiers" => "missing installed README operation privacy guidance\n",
    "first useful PHP service telemetry" => "missing installed README first useful telemetry guidance\n",
    "HttpTransport" => "missing installed README HTTP transport guidance\n",
    "HTTP Delivery" => "missing installed README HTTP delivery heading\n",
    "HttpTransport::DEFAULT_ENDPOINT" => "missing installed README HTTP endpoint guidance\n",
    "LogBrewPsrLogger" => "missing installed README PSR logger guidance\n",
    "PSR-3 Logger" => "missing installed README PSR logger heading\n",
    "LogBrewMonologHandler" => "missing installed README Monolog handler guidance\n",
    "LaravelLoggerFactory" => "missing installed README Laravel factory guidance\n",
    "registerQueueTelemetry" => "missing installed README Laravel queue guidance\n",
    "laravel.queue" => "missing installed README Laravel queue privacy guidance\n",
    "Laravel Quick Start" => "missing installed README Laravel heading\n",
    "config:cache" => "missing installed README Laravel config-cache guidance\n",
    "LOGBREW_SERVER_API_KEY" => "missing installed README canonical Laravel server-key guidance\n",
    "immediately flushes every accepted record" => "missing installed README Laravel delivery-boundary guidance\n",
    "SupportTicketDraft" => "missing installed README support ticket draft guidance\n",
    "does not open a ticket, call backend support routes, send telemetry, or use account/session API credentials" => "missing installed README support ticket boundary guidance\n",
    "token-free diagnostics" => "missing installed README support ticket diagnostics guidance\n",
    "config/logging.php" => "missing installed README Laravel logging config guidance\n",
    "Log::channel" => "missing installed README Laravel channel guidance\n",
    "warning(...)" => "missing installed README Laravel warning guidance\n",
    "copyable examples for PHP services" => "missing installed README copyable examples guidance\n",
    "keep the real key in app configuration" => "missing installed README app configuration guidance\n",
    "before sending" => "missing installed README local preview guidance\n",
] as $needle => $message) {
    if (!str_contains($readme, $needle)) {
        fwrite(STDERR, $message);
        exit(1);
    }
}
' vendor/logbrew/sdk/README.md
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($data["name"] ?? null) !== "logbrew/sdk") {
    fwrite(STDERR, "unexpected installed composer manifest name\n");
    exit(1);
}
if (($data["require"]["php"] ?? null) !== "^8.2") {
    fwrite(STDERR, "unexpected installed php constraint\n");
    exit(1);
}
if (($data["require"]["psr/log"] ?? null) !== "^3.0") {
    fwrite(STDERR, "unexpected installed psr/log constraint\n");
    exit(1);
}
if (($data["require-dev"]["monolog/monolog"] ?? null) !== "^3.0") {
    fwrite(STDERR, "unexpected installed monolog dev constraint\n");
    exit(1);
}
if (($data["suggest"]["monolog/monolog"] ?? null) !== "Required for Monolog and Laravel logging channels."
    || ($data["suggest"]["laravel/framework"] ?? null) !== "Required for Laravel queue job tracing.") {
    fwrite(STDERR, "unexpected installed monolog suggestion\n");
    exit(1);
}
if (($data["autoload"]["psr-4"]["LogBrew\\"] ?? null) !== "src/") {
    fwrite(STDERR, "unexpected installed psr-4 mapping\n");
    exit(1);
}
' vendor/logbrew/sdk/composer.json
php vendor/logbrew/sdk/examples/readme_example.php > vendor-readme-example.stdout.json 2> vendor-readme-example.stderr.json
assert_event_types vendor-readme-example.stdout.json release environment issue log span action
python3 "$repo_root/scripts/validate_fixtures.py" vendor-readme-example.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" vendor-readme-example.stdout.json >/dev/null
grep -q '"events":6' vendor-readme-example.stderr.json
grep -q '"ok":true' vendor-readme-example.stderr.json
(cd vendor/logbrew/sdk/examples && make run-readme-example) > vendor-readme-example-make.stdout.json 2> vendor-readme-example-make.stderr.json
assert_event_types vendor-readme-example-make.stdout.json release environment issue log span action
python3 "$repo_root/scripts/validate_fixtures.py" vendor-readme-example-make.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" vendor-readme-example-make.stdout.json >/dev/null
grep -q '"events":6' vendor-readme-example-make.stderr.json
grep -q '"ok":true' vendor-readme-example-make.stderr.json
php vendor/logbrew/sdk/examples/real_user_smoke.php > vendor-example.stdout.json 2> vendor-example.stderr.json
assert_event_types vendor-example.stdout.json release environment issue log span action
python3 "$repo_root/scripts/validate_fixtures.py" vendor-example.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" vendor-example.stdout.json >/dev/null
grep -q '"events":6' vendor-example.stderr.json
grep -q '"ok":true' vendor-example.stderr.json
grep -q '"supportDraftRedacted":true' vendor-example.stderr.json
grep -q '"supportDraftTrace":"4bf92f3577b34da6a3ce929d0e0e4736"' vendor-example.stderr.json
(cd vendor/logbrew/sdk/examples && make run-real-user-smoke) > vendor-example-make.stdout.json 2> vendor-example-make.stderr.json
grep -q '"type": "release"' vendor-example-make.stdout.json
grep -q '"events":6' vendor-example-make.stderr.json
grep -q '"supportDraftRedacted":true' vendor-example-make.stderr.json
grep -q '"supportDraftTrace":"4bf92f3577b34da6a3ce929d0e0e4736"' vendor-example-make.stderr.json
(cd vendor/logbrew/sdk/examples && make run) > vendor-example-make-run.stdout.json 2> vendor-example-make-run.stderr.json
grep -q '"type": "release"' vendor-example-make-run.stdout.json
grep -q '"events":6' vendor-example-make-run.stderr.json
grep -q '"supportDraftRedacted":true' vendor-example-make-run.stderr.json
grep -q '"supportDraftTrace":"4bf92f3577b34da6a3ce929d0e0e4736"' vendor-example-make-run.stderr.json
assert_event_types vendor-example-make.stdout.json release environment issue log span action
python3 "$repo_root/scripts/validate_fixtures.py" vendor-example-make.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" vendor-example-make.stdout.json >/dev/null
grep -q '"events":6' vendor-example-make.stderr.json
grep -q '"ok":true' vendor-example-make.stderr.json
php vendor/logbrew/sdk/examples/first_useful_telemetry.php > vendor-first-useful.stdout.json 2> vendor-first-useful.stderr.json
grep -q '"type": "metric"' vendor-first-useful.stdout.json
grep -q '"type": "span"' vendor-first-useful.stdout.json
grep -q '"events":7' vendor-first-useful.stderr.json
grep -q '"outgoingTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"' vendor-first-useful.stderr.json
python3 "$repo_root/scripts/validate_fixtures.py" vendor-first-useful.stdout.json >/dev/null
python3 "$repo_root/scripts/check_php_first_useful_payload.py" vendor-first-useful.stdout.json vendor-first-useful.stderr.json >/dev/null
(cd vendor/logbrew/sdk/examples && make run-first-useful-telemetry) > vendor-first-useful-make.stdout.json 2> vendor-first-useful-make.stderr.json
grep -q '"type": "metric"' vendor-first-useful-make.stdout.json
grep -q '"events":7' vendor-first-useful-make.stderr.json
python3 "$repo_root/scripts/check_php_first_useful_payload.py" vendor-first-useful-make.stdout.json vendor-first-useful-make.stderr.json >/dev/null
php vendor/logbrew/sdk/examples/issue_diagnostics.php > vendor-issue-diagnostics.stdout.json 2> vendor-issue-diagnostics.stderr.json
grep -q '"type": "issue"' vendor-issue-diagnostics.stdout.json
grep -q '"events":1' vendor-issue-diagnostics.stderr.json
python3 "$repo_root/scripts/validate_fixtures.py" vendor-issue-diagnostics.stdout.json >/dev/null
python3 "$repo_root/scripts/check_php_issue_diagnostics_payload.py" vendor-issue-diagnostics.stdout.json vendor-issue-diagnostics.stderr.json >/dev/null
(cd vendor/logbrew/sdk/examples && make run-issue-diagnostics) > vendor-issue-diagnostics-make.stdout.json 2> vendor-issue-diagnostics-make.stderr.json
grep -q '"type": "issue"' vendor-issue-diagnostics-make.stdout.json
grep -q '"events":1' vendor-issue-diagnostics-make.stderr.json
python3 "$repo_root/scripts/check_php_issue_diagnostics_payload.py" vendor-issue-diagnostics-make.stdout.json vendor-issue-diagnostics-make.stderr.json >/dev/null
php vendor/logbrew/sdk/examples/http_trace_correlation.php > vendor-http-trace.stdout.json 2> vendor-http-trace.stderr.json
grep -q '"type": "metric"' vendor-http-trace.stdout.json
grep -q '"type": "span"' vendor-http-trace.stdout.json
grep -q '"events":7' vendor-http-trace.stderr.json
python3 "$repo_root/scripts/check_php_http_trace_payload.py" vendor-http-trace.stdout.json vendor-http-trace.stderr.json >/dev/null
(cd vendor/logbrew/sdk/examples && make run-http-trace-correlation) > vendor-http-trace-make.stdout.json 2> vendor-http-trace-make.stderr.json
grep -q '"type": "metric"' vendor-http-trace-make.stdout.json
grep -q '"events":7' vendor-http-trace-make.stderr.json
python3 "$repo_root/scripts/check_php_http_trace_payload.py" vendor-http-trace-make.stdout.json vendor-http-trace-make.stderr.json >/dev/null
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
$packages = $data["packages"] ?? $data;
$match = null;
foreach ($packages as $package) {
    if (($package["name"] ?? null) === "logbrew/sdk") {
        $match = $package;
        break;
    }
}
if (!is_array($match)) {
    fwrite(STDERR, "missing installed Composer metadata entry\n");
    exit(1);
}
$version = (string) ($match["version"] ?? "");
$normalizedVersion = (string) ($match["version_normalized"] ?? "");
if ($version !== "0.1.0") {
    fwrite(STDERR, "unexpected installed Composer pretty version\n");
    exit(1);
}
if ($normalizedVersion !== "" && $normalizedVersion !== "0.1.0.0") {
    fwrite(STDERR, "unexpected installed Composer normalized version\n");
    exit(1);
}
$installPath = (string) ($match["install-path"] ?? $match["install_path"] ?? "");
if ($installPath !== "../logbrew/sdk") {
    fwrite(STDERR, "unexpected installed Composer install path\n");
    exit(1);
}
if (($match["installation-source"] ?? null) !== "dist") {
    fwrite(STDERR, "unexpected installed Composer installation source\n");
    exit(1);
}
' vendor/composer/installed.json
php <<'PHP'
<?php

$map = require 'vendor/composer/autoload_psr4.php';
$paths = $map['LogBrew\\'] ?? null;
if (!is_array($paths) || count($paths) !== 1) {
    fwrite(STDERR, "unexpected installed Composer PSR-4 map\n");
    exit(1);
}
$path = str_replace('\\', '/', (string) $paths[0]);
if (!str_ends_with($path, '/vendor/logbrew/sdk/src')) {
    fwrite(STDERR, "unexpected installed Composer PSR-4 target\n");
    exit(1);
}

require 'vendor/autoload.php';

$prettyVersion = Composer\InstalledVersions::getPrettyVersion('logbrew/sdk');
if ($prettyVersion !== '0.1.0') {
    fwrite(STDERR, "unexpected InstalledVersions pretty version\n");
    exit(1);
}

$installPath = realpath((string) Composer\InstalledVersions::getInstallPath('logbrew/sdk'));
if ($installPath === false) {
    fwrite(STDERR, "failed to resolve InstalledVersions install path\n");
    exit(1);
}
$installPath = str_replace('\\', '/', $installPath);
if (!str_ends_with($installPath, '/vendor/logbrew/sdk')) {
    fwrite(STDERR, "unexpected InstalledVersions install path\n");
    exit(1);
}
PHP

composer remove logbrew/sdk --no-interaction --quiet
composer validate --no-check-publish --no-check-version --strict >/dev/null
if composer show logbrew/sdk >/dev/null 2>&1; then
    echo "expected composer show logbrew/sdk to fail after composer remove" >&2
    exit 1
fi
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (isset($data["require"]["logbrew/sdk"])) {
    fwrite(STDERR, "expected root composer require entry to be removed\n");
    exit(1);
}
' composer.json
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
$packages = $data["packages"] ?? [];
foreach ($packages as $package) {
    if (($package["name"] ?? null) === "logbrew/sdk") {
        fwrite(STDERR, "expected composer.lock package entry to be removed\n");
        exit(1);
    }
}
' composer.lock
if [ -d vendor/logbrew/sdk ]; then
    echo "expected installed vendor package directory to be removed" >&2
    exit 1
fi
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
$packages = $data["packages"] ?? $data;
foreach ($packages as $package) {
    if (($package["name"] ?? null) === "logbrew/sdk") {
        fwrite(STDERR, "expected installed Composer metadata entry to be removed\n");
        exit(1);
    }
}
' vendor/composer/installed.json
php <<'PHP'
<?php

$map = require 'vendor/composer/autoload_psr4.php';
if (isset($map['LogBrew\\'])) {
    fwrite(STDERR, "expected LogBrew PSR-4 map to be removed\n");
    exit(1);
}

require 'vendor/autoload.php';

if (Composer\InstalledVersions::isInstalled('logbrew/sdk')) {
    fwrite(STDERR, "expected InstalledVersions to remove logbrew/sdk\n");
    exit(1);
}
PHP
composer show > composer-show-removed.txt
if grep -q '^logbrew/sdk ' composer-show-removed.txt; then
    echo "expected composer show package list to omit logbrew/sdk after removal" >&2
    exit 1
fi

composer require logbrew/sdk:0.1.0 --no-interaction --quiet
composer validate --no-check-publish --no-check-version --strict >/dev/null
assert_installed_package
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($data["require-dev"]["monolog/monolog"] ?? null) !== "^3.0") {
    fwrite(STDERR, "unexpected rerequired monolog dev constraint\n");
    exit(1);
}
if (($data["suggest"]["monolog/monolog"] ?? null) !== "Required for Monolog and Laravel logging channels."
    || ($data["suggest"]["laravel/framework"] ?? null) !== "Required for Laravel queue job tracing.") {
    fwrite(STDERR, "unexpected rerequired monolog suggestion\n");
    exit(1);
}
' vendor/logbrew/sdk/composer.json
composer show logbrew/sdk > composer-show-rerequired.txt
grep -q '^name     : logbrew/sdk$' composer-show-rerequired.txt
grep -q '^versions : \* 0\.1\.0$' composer-show-rerequired.txt
composer why logbrew/sdk > composer-why-rerequired.txt
grep -q '^smoke/app 0.1.0 requires logbrew/sdk (0.1.0)' composer-why-rerequired.txt

composer dump-autoload --no-interaction --quiet --optimize
test -f vendor/composer/autoload_psr4.php
php <<'PHP'
<?php

$map = require 'vendor/composer/autoload_psr4.php';
$paths = $map['LogBrew\\'] ?? null;
if (!is_array($paths) || count($paths) !== 1) {
    fwrite(STDERR, "unexpected regenerated Composer PSR-4 map\n");
    exit(1);
}
$path = str_replace('\\', '/', (string) $paths[0]);
if (!str_ends_with($path, '/vendor/logbrew/sdk/src')) {
    fwrite(STDERR, "unexpected regenerated Composer PSR-4 target\n");
    exit(1);
}

require 'vendor/autoload.php';

$client = LogBrew\LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');
$client->release('evt_release_autoload', '2026-06-02T10:00:00Z', ['version' => '1.2.3']);
$preview = $client->previewJson();
if (!str_contains($preview, '"type": "release"')) {
    fwrite(STDERR, "autoloaded client failed after composer dump-autoload\n");
    exit(1);
}
PHP

composer require monolog/monolog:^3.0 --no-interaction --quiet
composer require laravel/framework:^13.0 --no-interaction --quiet

cat > installed-user-test.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

$client = LogBrew\LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app-test', '0.1.0');
$client->release('evt_release_test', '2026-06-02T10:00:00Z', ['version' => '1.2.3']);
$trace = LogBrew\LogBrewTraceContext::fromTraceparent(
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    '1111111111111111'
);
$scope = LogBrew\LogBrewTrace::activate($trace);
try {
    $result = LogBrew\LogBrewOperationTracing::databaseOperation(
        $client,
        'db.select checkout_cart',
        static fn (): string => 'cart_123',
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
                'query' => 'select * from carts',
            ],
        ]
    );
} finally {
    $scope->close();
}
if ($result !== 'cart_123') {
    fwrite(STDERR, "installed-user dependency wrapper changed result\n");
    exit(1);
}
$preview = $client->previewJson();

if (!str_contains($preview, '"type": "release"')) {
    fwrite(STDERR, "installed-user test preview missing release event\n");
    exit(1);
}
foreach ([
    '"id": "evt_dependency_db"',
    '"source": "database.operation"',
    '"system": "mysql"',
    '"operation": "select"',
    '"target": "checkout.cart"',
    '"table": "carts"',
    '"rowCount": 1',
    '"parentSpanId": "1111111111111111"',
] as $needle) {
    if (!str_contains($preview, $needle)) {
        fwrite(STDERR, "installed-user dependency span missing: {$needle}\n");
        exit(1);
    }
}
foreach ([
    'db.internal.example',
    'select * from carts',
] as $needle) {
    if (str_contains($preview, $needle)) {
        fwrite(STDERR, "installed-user dependency span leaked sensitive metadata: {$needle}\n");
        exit(1);
    }
}

$draft = LogBrew\SupportTicketDraft::create(
    source: 'sdk',
    category: 'ingest_failure',
    title: '  PHP ingest failed  ',
    description: '  Local support draft for explicit user handoff.  ',
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
        'authorization' => 'Bearer sample', // support ticket fixture
        'endpoint' => 'https://api.example.com/v1/events?token=secret#fragment',
        'localPath' => '/home/example/project/.env',
        'debugNote' => 'failed at https://api.example.com/v1/events?token=secret from /home/example/project/.env', // support ticket fixture
        'exception' => new RuntimeException('do not include this message'),
        'safe' => 'kept',
    ]
);

if (($draft['title'] ?? '') !== 'PHP ingest failed') {
    fwrite(STDERR, "installed-user support draft did not trim title\n");
    exit(1);
}
if (($draft['trace_id'] ?? '') !== '4bf92f3577b34da6a3ce929d0e0e4736') {
    fwrite(STDERR, "installed-user support draft did not normalize trace id\n");
    exit(1);
}
if (($draft['diagnostics']['authorization'] ?? null) !== '[redacted]') {
    fwrite(STDERR, "installed-user support draft did not redact authorization\n");
    exit(1);
}
if (($draft['diagnostics']['endpoint'] ?? null) !== '[redacted-url]/v1/events') {
    fwrite(STDERR, "installed-user support draft did not redact URL\n");
    exit(1);
}
if (($draft['diagnostics']['localPath'] ?? null) !== '[redacted-path]') {
    fwrite(STDERR, "installed-user support draft did not redact local path\n");
    exit(1);
}
if (($draft['diagnostics']['debugNote'] ?? null) !== 'failed at [redacted-url]/v1/events from [redacted-path]') {
    fwrite(STDERR, "installed-user support draft did not redact embedded URL and path\n");
    exit(1);
}
if (($draft['diagnostics']['exception']['type'] ?? null) !== 'RuntimeException') {
    fwrite(STDERR, "installed-user support draft did not keep exception type only\n");
    exit(1);
}
$draftJson = json_encode($draft, JSON_THROW_ON_ERROR);
foreach ([
    'Bearer sample',
    'api.example.com',
    'token=secret',
    '/home/example/project',
    'do not include this message',
] as $needle) {
    if (str_contains($draftJson, $needle)) {
        fwrite(STDERR, "installed-user support draft leaked diagnostic value: {$needle}\n");
        exit(1);
    }
}
EOF

cat > readme-example.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;

$client = LogBrewClient::create(
    'LOGBREW_API_KEY',
    'logbrew-php',
    '0.1.0',
    captureRuntimeContext: false,
);
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
fwrite(STDERR, json_encode([
    'ok' => true,
    'status' => $response->statusCode,
    'attempts' => $response->attempts,
    'events' => 6,
], JSON_THROW_ON_ERROR) . PHP_EOL);
EOF

cp readme-example.php smoke.php

cat > psr-logger.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\LogBrewPsrLogger;
use LogBrew\RecordingTransport;

function requireNeedle(string $body, string $needle): void
{
    if (!str_contains($body, $needle)) {
        fwrite(STDERR, "missing PSR logger payload: {$needle}\n");
        exit(1);
    }
}

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-psr-logger', '0.1.0');
$transport = RecordingTransport::alwaysAccept();
$logger = new LogBrewPsrLogger(
    client: $client,
    loggerName: 'checkout',
    eventIdPrefix: 'installed_psr',
    metadata: ['service' => 'checkout', 'ignoredBase' => []],
    timestampProvider: static fn (): \DateTimeImmutable => new \DateTimeImmutable('2026-06-02T10:00:06+00:00')
);

$logger->warning('Checkout slow for {region}', [
    'region' => 'global',
    'attempt' => 2,
    'ignoredContext' => [],
]);
$logger->error('Checkout failed for {region}', [
    'region' => 'global',
    'exception' => new \RuntimeException('payment failed'),
]);

$body = $client->previewJson();
foreach ([
    '"id": "installed_psr_1"',
    '"timestamp": "2026-06-02T10:00:06+00:00"',
    '"logger": "checkout"',
    '"level": "warning"',
    '"level": "error"',
    '"message": "Checkout slow for global"',
    '"psrLevel": "warning"',
    '"messageTemplate": "Checkout slow for {region}"',
    '"context.region": "global"',
    '"context.attempt": 2',
    '"exceptionType": "RuntimeException"',
    '"exceptionMessage": "payment failed"',
] as $needle) {
    requireNeedle($body, $needle);
}
if (str_contains($body, 'exceptionTrace') || str_contains($body, 'ignoredBase') || str_contains($body, 'ignoredContext')) {
    fwrite(STDERR, "expected PSR logger to omit trace text and non-primitive metadata\n");
    exit(1);
}

$response = $client->flush($transport);
if ($response->statusCode !== 202 || count($transport->sentBodies) !== 1) {
    fwrite(STDERR, "unexpected PSR logger flush result\n");
    exit(1);
}

echo $body . PHP_EOL;
fwrite(STDERR, json_encode(['psrLogger' => true, 'events' => 2], JSON_THROW_ON_ERROR) . PHP_EOL);
EOF

cat > monolog-handler.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\LogBrewMonologHandler;
use LogBrew\RecordingTransport;
use Monolog\LogRecord;
use Monolog\Logger as MonologLogger;

function requireMonologNeedle(string $body, string $needle): void
{
    if (!str_contains($body, $needle)) {
        fwrite(STDERR, "missing Monolog handler payload: {$needle}\n");
        exit(1);
    }
}

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-monolog-handler', '0.1.0');
$transport = RecordingTransport::alwaysAccept();
$logger = new MonologLogger('checkout.monolog');
$logger->pushProcessor(static function (LogRecord $record): LogRecord {
    return $record->with(extra: ['requestId' => 'req_123', 'ignoredExtra' => []]);
});
$logger->pushHandler(new LogBrewMonologHandler(
    client: $client,
    loggerName: 'fallback-monolog',
    eventIdPrefix: 'installed_monolog',
    metadata: ['service' => 'checkout', 'ignoredBase' => []],
    timestampProvider: static fn (): \DateTimeImmutable => new \DateTimeImmutable('2026-06-02T10:00:08+00:00')
));

$logger->warning('Checkout slow for {region}', [
    'region' => 'global',
    'attempt' => 2,
    'ignoredContext' => [],
]);
$logger->error('Checkout failed for {region}', [
    'region' => 'global',
    'exception' => new \RuntimeException('payment failed'),
]);

$body = $client->previewJson();
foreach ([
    '"id": "installed_monolog_1"',
    '"timestamp": "2026-06-02T10:00:08+00:00"',
    '"logger": "checkout.monolog"',
    '"level": "warning"',
    '"level": "error"',
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
    requireMonologNeedle($body, $needle);
}
if (str_contains($body, 'exceptionTrace') || str_contains($body, 'ignoredBase') || str_contains($body, 'ignoredContext') || str_contains($body, 'ignoredExtra')) {
    fwrite(STDERR, "expected Monolog handler to omit trace text and non-primitive metadata\n");
    exit(1);
}

$response = $client->flush($transport);
if ($response->statusCode !== 202 || count($transport->sentBodies) !== 1) {
    fwrite(STDERR, "unexpected Monolog handler flush result\n");
    exit(1);
}

echo $body . PHP_EOL;
fwrite(STDERR, json_encode(['monologHandler' => true, 'events' => 2], JSON_THROW_ON_ERROR) . PHP_EOL);
EOF

cat > laravel-logger.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LaravelLoggerFactory;
use LogBrew\RecordingTransport;
use LogBrew\TransportError;
use Illuminate\Bus\Dispatcher as BusDispatcher;
use Illuminate\Container\Container;
use Illuminate\Contracts\Bus\Dispatcher as BusDispatcherContract;
use Illuminate\Contracts\Container\Container as ContainerContract;
use Illuminate\Contracts\Events\Dispatcher as EventDispatcherContract;
use Illuminate\Events\Dispatcher as EventDispatcher;
use Illuminate\Queue\QueueManager;
use Illuminate\Queue\SyncQueue;
use Psr\Log\LoggerInterface;

final class InstalledSuccessfulLaravelJob
{
    public static LoggerInterface $logger;

    public function __construct(private readonly string $privatePayload)
    {
    }

    public function handle(): void
    {
        self::$logger->warning('successful queue job running');
    }
}

final class InstalledFailingLaravelJob
{
    public static LoggerInterface $logger;

    public function __construct(private readonly string $privatePayload)
    {
    }

    public function handle(): never
    {
        self::$logger->error('failing queue job running');
        throw new RuntimeException('PRIVATE_LARAVEL_EXCEPTION_MESSAGE');
    }
}

$config = LaravelLoggerFactory::configuration(
    apiKey: 'LOGBREW_SERVER_API_KEY',
    service: 'installed-laravel-app',
    release: '1.2.3',
    environment: 'testing'
);
$config['event_id_prefix'] = 'installed_laravel';
$exported = var_export($config, true);
$encoded = json_encode($config, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
$roundTripped = json_decode($encoded, true, flags: JSON_THROW_ON_ERROR);
if (str_contains($exported, '::__set_state') || $roundTripped !== $config) {
    fwrite(STDERR, "Laravel channel configuration was not config-cache safe\n");
    exit(1);
}

$transport = RecordingTransport::alwaysAccept();
$factory = new LaravelLoggerFactory($transport);
$logger = $factory($config);
$logger->warning('Queue {queue} is delayed.', ['queue' => 'default', 'attempt' => 2]);
if (count($transport->sentBodies) !== 1) {
    fwrite(STDERR, "Laravel logger did not immediately deliver the accepted record\n");
    exit(1);
}

$body = $transport->lastBody();
$payload = json_decode($body, true, flags: JSON_THROW_ON_ERROR);
$event = $payload['events'][0] ?? null;
if (!is_array($event)
    || ($payload['sdk']['name'] ?? null) !== 'logbrew-php-laravel'
    || ($payload['sdk']['version'] ?? null) !== '0.1.0'
    || ($event['id'] ?? null) !== 'installed_laravel_1'
    || ($event['attributes']['logger'] ?? null) !== 'installed-laravel-app'
    || ($event['attributes']['level'] ?? null) !== 'warning'
    || ($event['attributes']['message'] ?? null) !== 'Queue default is delayed.'
    || ($event['attributes']['metadata']['framework'] ?? null) !== 'laravel'
    || ($event['attributes']['metadata']['release'] ?? null) !== '1.2.3'
    || ($event['attributes']['metadata']['environment'] ?? null) !== 'testing'
    || ($event['attributes']['metadata']['context.attempt'] ?? null) !== 2
) {
    fwrite(STDERR, "unexpected installed Laravel logger payload\n");
    exit(1);
}
if (str_contains($body, 'LOGBREW_SERVER_API_KEY')) {
    fwrite(STDERR, "Laravel logger leaked its API key into the payload\n");
    exit(1);
}

$failedTransport = new RecordingTransport([TransportError::network('LogBrew is unavailable.')]);
$failureIsolatedLogger = (new LaravelLoggerFactory($failedTransport))($config);
$failureIsolatedLogger->error('Application logging continues.');
if (count($failedTransport->sentBodies) !== 1) {
    fwrite(STDERR, "Laravel logger did not isolate a delivery failure\n");
    exit(1);
}

InstalledSuccessfulLaravelJob::$logger = $logger;
InstalledFailingLaravelJob::$logger = $logger;
$container = new Container();
$events = new EventDispatcher($container);
$container->instance('events', $events);
$container->instance(ContainerContract::class, $container);
$container->instance(EventDispatcherContract::class, $events);
$container->instance(BusDispatcherContract::class, new BusDispatcher($container));
$factory->registerQueueTelemetry(new QueueManager($container), $config);
$queue = new SyncQueue();
$queue->setContainer($container);
$queue->setConnectionName('sync');
$queue->push(new InstalledSuccessfulLaravelJob('PRIVATE_SUCCESS_PAYLOAD'), queue: 'emails');
try {
    $queue->push(new InstalledFailingLaravelJob('PRIVATE_FAILURE_PAYLOAD'), queue: 'billing');
    throw new RuntimeException('expected Laravel queue failure');
} catch (RuntimeException $error) {
    if ($error->getMessage() !== 'PRIVATE_LARAVEL_EXCEPTION_MESSAGE') {
        throw $error;
    }
}

$traces = [];
$spanFacts = [];
foreach ($transport->sentBodies as $sentBody) {
    $batch = json_decode($sentBody, true, 512, JSON_THROW_ON_ERROR);
    foreach ($batch['events'] ?? [] as $event) {
        $attributes = $event['attributes'] ?? [];
        $trace = $attributes['context']['trace'] ?? $attributes;
        if (isset($trace['traceId'], $trace['spanId'])) {
            $traces[$trace['traceId']][] = [$event['type'], $trace['spanId']];
        }
        if (($event['type'] ?? null) === 'span') {
            $spanFacts[] = implode(':', [$attributes['name'] ?? '', $attributes['status'] ?? '', $attributes['metadata']['operation'] ?? '']);
        }
    }
}
if (count($traces) !== 2) {
    fwrite(STDERR, "expected one correlated trace for each Laravel queue job\n");
    exit(1);
}
$traceTypes = [];
foreach ($traces as $traceEvents) {
    if (count(array_unique(array_column($traceEvents, 1))) !== 1) {
        fwrite(STDERR, "Laravel job evidence did not share one span identity\n");
        exit(1);
    }
    $types = array_column($traceEvents, 0);
    sort($types);
    $traceTypes[] = implode(',', $types);
}
sort($traceTypes);
if ($traceTypes !== ['issue,log,span', 'log,span']) {
    fwrite(STDERR, "unexpected Laravel queue evidence types\n");
    exit(1);
}
sort($spanFacts);
if ($spanFacts !== ['InstalledFailingLaravelJob:error:job.execute', 'InstalledSuccessfulLaravelJob:ok:job.execute']) {
    fwrite(STDERR, "unexpected Laravel queue span identity\n");
    exit(1);
}
$allBodies = implode('', $transport->sentBodies);
foreach (['PRIVATE_SUCCESS_PAYLOAD', 'PRIVATE_FAILURE_PAYLOAD', 'PRIVATE_LARAVEL_EXCEPTION_MESSAGE'] as $privateValue) {
    if (str_contains($allBodies, $privateValue)) {
        fwrite(STDERR, "Laravel queue telemetry leaked a private value\n");
        exit(1);
    }
}

echo $body . PHP_EOL;
fwrite(STDERR, json_encode(['laravelLoggerFactory' => true, 'events' => 6, 'queueTraces' => 2], JSON_THROW_ON_ERROR) . PHP_EOL);
EOF

cat > http-transport.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\HttpTransport;
use LogBrew\LogBrewClient;
use LogBrew\SdkError;
use LogBrew\TransportError;

function requireTrue(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, $message . PHP_EOL);
        exit(1);
    }
}

final class LocalHttpIntake
{
    public string $endpoint;
    private string $dir;
    private string $script;
    /** @var resource */
    private $process;
    /** @var array<int, resource> */
    private array $pipes;

    /** @param list<int> $statuses */
    public function __construct(array $statuses)
    {
        $this->dir = sys_get_temp_dir() . '/logbrew-php-http-' . bin2hex(random_bytes(6));
        mkdir($this->dir);
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
        requireTrue(is_resource($process), 'expected local HTTP intake process');
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
        fwrite(STDERR, $message . PHP_EOL);
        exit(1);
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

$intake = new LocalHttpIntake([202]);
try {
    $transport = new HttpTransport(
        endpoint: $intake->endpoint,
        headers: ['x-logbrew-test' => 'php'],
        timeout: 2.0
    );
    $response = $transport->send('LOGBREW_API_KEY', '{}');
    requireTrue($response->statusCode === 202, 'expected HTTP transport status');
    requireTrue($response->attempts === 1, 'expected HTTP transport attempt count');
    $requests = $intake->requests();
    requireTrue(count($requests) === 1, 'expected one HTTP request');
    requireTrue($requests[0]['method'] === 'POST', 'expected HTTP POST');
    requireTrue($requests[0]['target'] === '/v1/events', 'expected HTTP request path');
    requireTrue($requests[0]['body'] === '{}', 'expected HTTP request body');
    requireTrue(($requests[0]['headers']['authorization'] ?? '') === 'Bearer LOGBREW_API_KEY', 'expected HTTP authorization header');
    requireTrue(($requests[0]['headers']['content-type'] ?? '') === 'application/json', 'expected HTTP content-type header');
    requireTrue(($requests[0]['headers']['x-logbrew-test'] ?? '') === 'php', 'expected custom HTTP header');
} finally {
    $intake->close();
}

$intake = new LocalHttpIntake([503, 202]);
try {
    $client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-http-transport', '0.1.0', 1);
    $client->release('evt_release_http', '2026-06-02T10:00:00Z', ['version' => '1.2.3']);
    $response = $client->flush(new HttpTransport(endpoint: $intake->endpoint, timeout: 2.0));
    requireTrue($response->statusCode === 202, 'expected HTTP retry status');
    requireTrue($response->attempts === 2, 'expected HTTP retry attempts');
    requireTrue($client->pendingEvents() === 0, 'expected HTTP retry queue drain');
    $requests = $intake->requests();
    requireTrue(count($requests) === 2, 'expected two HTTP retry requests');
    requireTrue($requests[0]['body'] === $requests[1]['body'], 'expected unchanged HTTP retry body');
} finally {
    $intake->close();
}

try {
    (new HttpTransport(endpoint: 'http://127.0.0.1:1/v1/events', timeout: 0.2))->send('LOGBREW_API_KEY', '{}');
    fwrite(STDERR, "expected HTTP network failure\n");
    exit(1);
} catch (TransportError $error) {
    requireTrue($error->codeName === 'network_failure', 'expected HTTP network failure code');
    requireTrue($error->retryable, 'expected HTTP network failure retry hint');
}

foreach ([
    static fn (): HttpTransport => new HttpTransport(endpoint: '/v1/events'),
    static fn (): HttpTransport => new HttpTransport(headers: [' ' => 'bad']),
    static fn (): HttpTransport => new HttpTransport(timeout: 0.0),
] as $factory) {
    try {
        $factory();
        fwrite(STDERR, "expected HTTP configuration error\n");
        exit(1);
    } catch (SdkError $error) {
        requireTrue($error->codeName === 'configuration_error', 'expected HTTP configuration error code');
    }
}

fwrite(STDERR, json_encode([
    'httpTransport' => true,
    'httpAttempts' => 2,
    'httpRequests' => 2,
], JSON_THROW_ON_ERROR) . PHP_EOL);
EOF

cat > timeline.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\ProductTimeline;
use LogBrew\SdkError;

function requireTimeline(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, $message . PHP_EOL);
        exit(1);
    }
}

function expectTimelineError(callable $callback, string $needle): void
{
    try {
        $callback();
    } catch (SdkError $error) {
        requireTimeline(str_contains($error->getMessage(), $needle), "expected timeline error containing {$needle}");
        return;
    }

    fwrite(STDERR, "expected timeline error containing {$needle}" . PHP_EOL);
    exit(1);
}

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app-timeline', '0.1.0');
$productMetadata = ['cartTier' => 'gold', 'attempt' => 2, 'routeTemplate' => '/raw?debug=sample'];
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
$client->action('evt_network_timeline', '2026-06-02T10:00:06Z', ProductTimeline::networkMilestone(
    routeTemplate: 'https://api.example/v1/payments/:id?debug=sample#fragment',
    method: 'post',
    statusCode: 503,
    durationMs: 183.4,
    sessionId: 'session_123',
    traceId: 'trace_abc',
    metadata: ['api' => 'payments']
));
$client->action('evt_network_default_timeline', '2026-06-02T10:00:07Z', ProductTimeline::networkMilestone(
    routeTemplate: '/health',
    metadata: ['probe' => true]
));

$body = $client->previewJson();
foreach ([
    '"source": "product_timeline"',
    '"source": "network_timeline"',
    '"name": "checkout.submit"',
    '"name": "network.post \/v1\/payments\/:id"',
    '"name": "network.get \/health"',
    '"status": "failure"',
    '"status": "success"',
    '"routeTemplate": "\/checkout\/:step"',
    '"routeTemplate": "\/v1\/payments\/:id"',
    '"method": "POST"',
    '"statusCode": 503',
    '"durationMs": 183.4',
    '"sessionId": "session_123"',
    '"traceId": "trace_abc"',
    '"cartTier": "gold"',
] as $needle) {
    requireTimeline(str_contains($body, $needle), "missing timeline payload {$needle}");
}
foreach (['cart=sample', 'debug=sample', 'fragment', 'platinum'] as $needle) {
    requireTimeline(!str_contains($body, $needle), "unexpected timeline payload {$needle}");
}
expectTimelineError(static fn () => ProductTimeline::productAction(name: 'checkout.submit', status: 'done'), 'action status must be one of');
expectTimelineError(static fn () => ProductTimeline::networkMilestone(routeTemplate: '/ok', method: 'GET /bad'), 'network milestone method must be a valid HTTP method');
expectTimelineError(static fn () => ProductTimeline::networkMilestone(routeTemplate: '/ok', statusCode: 700), 'network milestone statusCode must be between 100 and 599');
expectTimelineError(static fn () => ProductTimeline::networkMilestone(routeTemplate: '/ok', durationMs: -1), 'network milestone durationMs must be non-negative');
expectTimelineError(static fn () => ProductTimeline::networkMilestone(routeTemplate: '/ok', name: '   '), 'network milestone name must be non-empty');
expectTimelineError(static fn () => ProductTimeline::productAction(name: 'checkout.submit', metadata: ['bad' => []]), 'metadata value for bad must be a string, number, boolean, or null');
expectTimelineError(static fn () => ProductTimeline::productAction(name: 'checkout.submit', metadata: ['source' => []]), 'metadata value for source must be a string, number, boolean, or null');

echo $body . PHP_EOL;
fwrite(STDERR, json_encode(['timelineEvents' => 3], JSON_THROW_ON_ERROR) . PHP_EOL);
EOF

php -r '
$path = $argv[1];
$data = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
$data["scripts"]["smoke-test"] = "php installed-user-test.php";
$data["scripts"]["smoke-readme"] = "php readme-example.php";
$data["scripts"]["smoke-run"] = "php smoke.php";
$data["scripts"]["smoke-timeline"] = "php timeline.php";
$data["scripts"]["smoke-psr-logger"] = "php psr-logger.php";
$data["scripts"]["smoke-monolog-handler"] = "php monolog-handler.php";
$data["scripts"]["smoke-laravel-logger"] = "php laravel-logger.php";
$data["scripts"]["smoke-http-transport"] = "php http-transport.php";
$data["scripts"]["smoke-vendor-example"] = "php vendor/logbrew/sdk/examples/real_user_smoke.php";
$data["scripts"]["smoke-first-useful"] = "php vendor/logbrew/sdk/examples/first_useful_telemetry.php";
$data["scripts"]["smoke-http-trace"] = "php vendor/logbrew/sdk/examples/http_trace_correlation.php";
$data["scripts"]["smoke-types"] = "@php vendor/bin/phpstan analyse phpstan-consumer.php --configuration=phpstan.neon --level=max --memory-limit=512M --no-progress";
file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL);
' composer.json
composer validate --no-check-publish --no-check-version --strict >/dev/null
composer run --no-interaction --quiet smoke-test >/dev/null
composer run --no-interaction --quiet smoke-readme >/dev/null
composer run --no-interaction smoke-timeline > timeline-composer.stdout.json 2> timeline-composer.stderr.json
grep -q '"source": "product_timeline"' timeline-composer.stdout.json
grep -q '"source": "network_timeline"' timeline-composer.stdout.json
grep -q '"timelineEvents":3' timeline-composer.stderr.json
composer run --no-interaction smoke-psr-logger > psr-logger.stdout.json 2> psr-logger.stderr.json
grep -q '"type": "log"' psr-logger.stdout.json
grep -q '"psrLogger":true' psr-logger.stderr.json
composer run --no-interaction smoke-monolog-handler > monolog-handler.stdout.json 2> monolog-handler.stderr.json
grep -q '"type": "log"' monolog-handler.stdout.json
grep -q '"monologHandler":true' monolog-handler.stderr.json
composer run --no-interaction smoke-laravel-logger > laravel-logger.stdout.json 2> laravel-logger.stderr.json
grep -q '"type":"log"' laravel-logger.stdout.json
grep -q '"laravelLoggerFactory":true' laravel-logger.stderr.json
grep -q '"queueTraces":2' laravel-logger.stderr.json
composer run --no-interaction smoke-http-transport > http-transport.stdout.json 2> http-transport.stderr.json
grep -q '"httpTransport":true' http-transport.stderr.json
grep -q '"httpAttempts":2' http-transport.stderr.json
grep -q '"httpRequests":2' http-transport.stderr.json
composer run --no-interaction --quiet smoke-vendor-example >/dev/null
composer run --no-interaction smoke-first-useful > first-useful-composer.stdout.json 2> first-useful-composer.stderr.json
grep -q '"type": "metric"' first-useful-composer.stdout.json
grep -q '"events":7' first-useful-composer.stderr.json
python3 "$repo_root/scripts/check_php_first_useful_payload.py" first-useful-composer.stdout.json first-useful-composer.stderr.json >/dev/null
composer run --no-interaction smoke-http-trace > http-trace-composer.stdout.json 2> http-trace-composer.stderr.json
grep -q '"type": "metric"' http-trace-composer.stdout.json
grep -q '"events":7' http-trace-composer.stderr.json
python3 "$repo_root/scripts/check_php_http_trace_payload.py" http-trace-composer.stdout.json http-trace-composer.stderr.json >/dev/null
php readme-example.php > readme-example.stdout.json 2> readme-example.stderr.json
assert_event_types readme-example.stdout.json release environment issue log span action
python3 "$repo_root/scripts/validate_fixtures.py" readme-example.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" readme-example.stdout.json >/dev/null
grep -q '"events":6' readme-example.stderr.json
grep -q '"ok":true' readme-example.stderr.json

rm -rf vendor
composer install --no-interaction --quiet
composer validate --no-check-publish --no-check-version --strict >/dev/null
assert_installed_package
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($data["require-dev"]["monolog/monolog"] ?? null) !== "^3.0") {
    fwrite(STDERR, "unexpected reinstall monolog dev constraint\n");
    exit(1);
}
if (($data["suggest"]["monolog/monolog"] ?? null) !== "Required for Monolog and Laravel logging channels."
    || ($data["suggest"]["laravel/framework"] ?? null) !== "Required for Laravel queue job tracing.") {
    fwrite(STDERR, "unexpected reinstall monolog suggestion\n");
    exit(1);
}
' vendor/logbrew/sdk/composer.json
composer show logbrew/sdk > composer-show-plain-reinstall.txt
grep -q '^name     : logbrew/sdk$' composer-show-plain-reinstall.txt
grep -q '^descrip\. : Public LogBrew PHP SDK for building, validating, and flushing event batches\.$' composer-show-plain-reinstall.txt
grep -q '^versions : \* 0\.1\.0$' composer-show-plain-reinstall.txt
grep -q '^type     : library$' composer-show-plain-reinstall.txt
grep -q '^license  : MIT License (MIT) (OSI approved) https://spdx\.org/licenses/MIT\.html#licenseText$' composer-show-plain-reinstall.txt
grep -q '^dist     : \[zip\] .*/artifacts/logbrew-sdk\.zip $' composer-show-plain-reinstall.txt
grep -q '^path     : .*/vendor/logbrew/sdk$' composer-show-plain-reinstall.txt
grep -q '^names    : logbrew/sdk$' composer-show-plain-reinstall.txt
grep -q '^autoload$' composer-show-plain-reinstall.txt
grep -q '^psr-4$' composer-show-plain-reinstall.txt
grep -q '^LogBrew\\ => src/$' composer-show-plain-reinstall.txt
grep -q '^requires$' composer-show-plain-reinstall.txt
grep -q '^php \^8\.2$' composer-show-plain-reinstall.txt
grep -q '^psr/log \^3\.0$' composer-show-plain-reinstall.txt
composer show logbrew/sdk --format=json > composer-show-reinstall.json
composer why logbrew/sdk > composer-why-reinstall.txt
grep -q '^smoke/app 0.1.0 requires logbrew/sdk (0.1.0)' composer-why-reinstall.txt
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($data["name"] ?? null) !== "logbrew/sdk") {
    fwrite(STDERR, "unexpected reinstall composer package name\n");
    exit(1);
}
if (($data["description"] ?? null) !== "Public LogBrew PHP SDK for building, validating, and flushing event batches.") {
    fwrite(STDERR, "unexpected reinstall composer package description\n");
    exit(1);
}
if (($data["type"] ?? null) !== "library") {
    fwrite(STDERR, "unexpected reinstall composer package type\n");
    exit(1);
}
if (($data["versions"][0] ?? null) !== "0.1.0") {
    fwrite(STDERR, "unexpected reinstall composer package version\n");
    exit(1);
}
$licenses = $data["licenses"] ?? [];
if (($licenses[0]["osi"] ?? null) !== "MIT") {
    fwrite(STDERR, "unexpected reinstall composer package license metadata\n");
    exit(1);
}
if (($data["dist"]["type"] ?? null) !== "zip") {
    fwrite(STDERR, "unexpected reinstall composer package dist type\n");
    exit(1);
}
$distUrl = (string) ($data["dist"]["url"] ?? "");
if (basename($distUrl) !== "logbrew-sdk.zip") {
    fwrite(STDERR, "unexpected reinstall composer package dist url\n");
    exit(1);
}
$path = str_replace("\\", "/", (string) ($data["path"] ?? ""));
if (!str_ends_with($path, "/vendor/logbrew/sdk")) {
    fwrite(STDERR, "unexpected reinstall composer package install path\n");
    exit(1);
}
if (($data["autoload"]["psr-4"]["LogBrew\\"] ?? null) !== "src/") {
    fwrite(STDERR, "unexpected reinstall composer package autoload mapping\n");
    exit(1);
}
if (($data["requires"]["php"] ?? null) !== "^8.2") {
    fwrite(STDERR, "unexpected reinstall composer package php requirement\n");
    exit(1);
}
if (($data["requires"]["psr/log"] ?? null) !== "^3.0") {
    fwrite(STDERR, "unexpected reinstall composer package psr/log requirement\n");
    exit(1);
}
' composer-show-reinstall.json
composer why logbrew/sdk --tree > composer-why-tree-reinstall.txt
grep -q '^logbrew/sdk 0.1.0 ' composer-why-tree-reinstall.txt
grep -q '^`--smoke/app 0.1.0 (requires logbrew/sdk 0.1.0)' composer-why-tree-reinstall.txt
composer licenses --format=json > composer-licenses-reinstall.json
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($data["name"] ?? null) !== "smoke/app") {
    fwrite(STDERR, "unexpected reinstall composer licenses root project name\n");
    exit(1);
}
$deps = $data["dependencies"] ?? [];
$package = $deps["logbrew/sdk"] ?? null;
if (!is_array($package)) {
    fwrite(STDERR, "missing reinstall composer licenses dependency entry\n");
    exit(1);
}
if (($package["version"] ?? null) !== "0.1.0") {
    fwrite(STDERR, "unexpected reinstall composer licenses dependency version\n");
    exit(1);
}
$licenses = $package["license"] ?? [];
if ($licenses !== ["MIT"]) {
    fwrite(STDERR, "unexpected reinstall composer licenses dependency license\n");
    exit(1);
}
' composer-licenses-reinstall.json
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($data["name"] ?? null) !== "logbrew/sdk") {
    fwrite(STDERR, "unexpected reinstall composer package name\n");
    exit(1);
}
if (($data["versions"][0] ?? null) !== "0.1.0") {
    fwrite(STDERR, "unexpected reinstall composer package version\n");
    exit(1);
}
' composer-show-reinstall.json
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
$packages = $data["packages"] ?? $data;
$match = null;
foreach ($packages as $package) {
    if (($package["name"] ?? null) === "logbrew/sdk") {
        $match = $package;
        break;
    }
}
if (!is_array($match)) {
    fwrite(STDERR, "missing reinstall Composer metadata entry\n");
    exit(1);
}
if (($match["installation-source"] ?? null) !== "dist") {
    fwrite(STDERR, "unexpected reinstall Composer installation source\n");
    exit(1);
}
$installPath = (string) ($match["install-path"] ?? $match["install_path"] ?? "");
if ($installPath !== "../logbrew/sdk") {
    fwrite(STDERR, "unexpected reinstall Composer install path\n");
    exit(1);
}
' vendor/composer/installed.json
php <<'PHP'
<?php

$map = require 'vendor/composer/autoload_psr4.php';
$paths = $map['LogBrew\\'] ?? null;
if (!is_array($paths) || count($paths) !== 1) {
    fwrite(STDERR, "unexpected reinstall Composer PSR-4 map\n");
    exit(1);
}
$path = str_replace('\\', '/', (string) $paths[0]);
if (!str_ends_with($path, '/vendor/logbrew/sdk/src')) {
    fwrite(STDERR, "unexpected reinstall Composer PSR-4 target\n");
    exit(1);
}

require 'vendor/autoload.php';

$prettyVersion = Composer\InstalledVersions::getPrettyVersion('logbrew/sdk');
if ($prettyVersion !== '0.1.0') {
    fwrite(STDERR, "unexpected reinstall InstalledVersions pretty version\n");
    exit(1);
}
PHP

composer dump-autoload --no-interaction --quiet --optimize
test -f vendor/composer/autoload_psr4.php
php <<'PHP'
<?php

$map = require 'vendor/composer/autoload_psr4.php';
$paths = $map['LogBrew\\'] ?? null;
if (!is_array($paths) || count($paths) !== 1) {
    fwrite(STDERR, "unexpected reinstall regenerated Composer PSR-4 map\n");
    exit(1);
}
$path = str_replace('\\', '/', (string) $paths[0]);
if (!str_ends_with($path, '/vendor/logbrew/sdk/src')) {
    fwrite(STDERR, "unexpected reinstall regenerated Composer PSR-4 target\n");
    exit(1);
}

require 'vendor/autoload.php';

$client = LogBrew\LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');
$client->release('evt_release_reinstall_autoload', '2026-06-02T10:00:00Z', ['version' => '1.2.3']);
$preview = $client->previewJson();
if (!str_contains($preview, '"type": "release"')) {
    fwrite(STDERR, "autoloaded client failed after reinstall composer dump-autoload\n");
    exit(1);
}
PHP
composer run --no-interaction --quiet smoke-test >/dev/null
composer run --no-interaction --quiet smoke-readme >/dev/null
composer run --no-interaction smoke-timeline > timeline-reinstall.stdout.json 2> timeline-reinstall.stderr.json
grep -q '"source": "product_timeline"' timeline-reinstall.stdout.json
grep -q '"source": "network_timeline"' timeline-reinstall.stdout.json
grep -q '"timelineEvents":3' timeline-reinstall.stderr.json
composer run --no-interaction smoke-psr-logger > psr-logger-reinstall.stdout.json 2> psr-logger-reinstall.stderr.json
grep -q '"type": "log"' psr-logger-reinstall.stdout.json
grep -q '"psrLogger":true' psr-logger-reinstall.stderr.json
composer run --no-interaction smoke-monolog-handler > monolog-handler-reinstall.stdout.json 2> monolog-handler-reinstall.stderr.json
grep -q '"type": "log"' monolog-handler-reinstall.stdout.json
grep -q '"monologHandler":true' monolog-handler-reinstall.stderr.json
composer run --no-interaction smoke-laravel-logger > laravel-logger-reinstall.stdout.json 2> laravel-logger-reinstall.stderr.json
grep -q '"type":"log"' laravel-logger-reinstall.stdout.json
grep -q '"laravelLoggerFactory":true' laravel-logger-reinstall.stderr.json
grep -q '"queueTraces":2' laravel-logger-reinstall.stderr.json
composer run --no-interaction smoke-http-transport > http-transport-reinstall.stdout.json 2> http-transport-reinstall.stderr.json
grep -q '"httpTransport":true' http-transport-reinstall.stderr.json
grep -q '"httpAttempts":2' http-transport-reinstall.stderr.json
grep -q '"httpRequests":2' http-transport-reinstall.stderr.json
composer run --no-interaction --quiet smoke-vendor-example >/dev/null
php readme-example.php > readme-example-reinstall.stdout.json 2> readme-example-reinstall.stderr.json
assert_event_types readme-example-reinstall.stdout.json release environment issue log span action
python3 "$repo_root/scripts/validate_fixtures.py" readme-example-reinstall.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" readme-example-reinstall.stdout.json >/dev/null
grep -q '"events":6' readme-example-reinstall.stderr.json
grep -q '"ok":true' readme-example-reinstall.stderr.json
php vendor/logbrew/sdk/examples/readme_example.php > vendor-readme-example-reinstall.stdout.json 2> vendor-readme-example-reinstall.stderr.json
assert_event_types vendor-readme-example-reinstall.stdout.json release environment issue log span action
python3 "$repo_root/scripts/validate_fixtures.py" vendor-readme-example-reinstall.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" vendor-readme-example-reinstall.stdout.json >/dev/null
grep -q '"events":6' vendor-readme-example-reinstall.stderr.json
grep -q '"ok":true' vendor-readme-example-reinstall.stderr.json
php vendor/logbrew/sdk/examples/real_user_smoke.php > vendor-example-reinstall.stdout.json 2> vendor-example-reinstall.stderr.json
assert_event_types vendor-example-reinstall.stdout.json release environment issue log span action
python3 "$repo_root/scripts/validate_fixtures.py" vendor-example-reinstall.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" vendor-example-reinstall.stdout.json >/dev/null
grep -q '"events":6' vendor-example-reinstall.stderr.json
grep -q '"ok":true' vendor-example-reinstall.stderr.json
grep -q '"supportDraftRedacted":true' vendor-example-reinstall.stderr.json
grep -q '"supportDraftTrace":"4bf92f3577b34da6a3ce929d0e0e4736"' vendor-example-reinstall.stderr.json
(cd vendor/logbrew/sdk/examples && make) > vendor-example-make-reinstall-help.txt
grep -qx 'run-readme-example -> make run-readme-example' <(sed -n '1p' vendor-example-make-reinstall-help.txt)
grep -qx 'run (real-user-smoke) -> make run' <(sed -n '2p' vendor-example-make-reinstall-help.txt)
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' <(sed -n '3p' vendor-example-make-reinstall-help.txt)
grep -qx 'run-first-useful-telemetry -> make run-first-useful-telemetry' <(sed -n '4p' vendor-example-make-reinstall-help.txt)
grep -qx 'run-issue-diagnostics -> make run-issue-diagnostics' <(sed -n '5p' vendor-example-make-reinstall-help.txt)
grep -qx 'run-http-trace-correlation -> make run-http-trace-correlation' <(sed -n '6p' vendor-example-make-reinstall-help.txt)
grep -qx 'run-worker-lifecycle -> make run-worker-lifecycle' <(sed -n '7p' vendor-example-make-reinstall-help.txt)
grep -qx 'run-persistent-worker-delivery -> make run-persistent-worker-delivery' <(sed -n '8p' vendor-example-make-reinstall-help.txt)
test "$(wc -l < vendor-example-make-reinstall-help.txt | tr -d ' ')" = "8"
(cd vendor/logbrew/sdk/examples && make run-readme-example) > vendor-readme-example-make-reinstall.stdout.json 2> vendor-readme-example-make-reinstall.stderr.json
assert_event_types vendor-readme-example-make-reinstall.stdout.json release environment issue log span action
python3 "$repo_root/scripts/validate_fixtures.py" vendor-readme-example-make-reinstall.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" vendor-readme-example-make-reinstall.stdout.json >/dev/null
grep -q '"events":6' vendor-readme-example-make-reinstall.stderr.json
grep -q '"ok":true' vendor-readme-example-make-reinstall.stderr.json
(cd vendor/logbrew/sdk/examples && make run-real-user-smoke) > vendor-example-make-reinstall.stdout.json 2> vendor-example-make-reinstall.stderr.json
grep -q '"type": "release"' vendor-example-make-reinstall.stdout.json
grep -q '"events":6' vendor-example-make-reinstall.stderr.json
grep -q '"supportDraftRedacted":true' vendor-example-make-reinstall.stderr.json
grep -q '"supportDraftTrace":"4bf92f3577b34da6a3ce929d0e0e4736"' vendor-example-make-reinstall.stderr.json
(cd vendor/logbrew/sdk/examples && make run) > vendor-example-make-reinstall-run.stdout.json 2> vendor-example-make-reinstall-run.stderr.json
grep -q '"type": "release"' vendor-example-make-reinstall-run.stdout.json
grep -q '"events":6' vendor-example-make-reinstall-run.stderr.json
grep -q '"supportDraftRedacted":true' vendor-example-make-reinstall-run.stderr.json
grep -q '"supportDraftTrace":"4bf92f3577b34da6a3ce929d0e0e4736"' vendor-example-make-reinstall-run.stderr.json
assert_event_types vendor-example-make-reinstall.stdout.json release environment issue log span action
python3 "$repo_root/scripts/validate_fixtures.py" vendor-example-make-reinstall.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" vendor-example-make-reinstall.stdout.json >/dev/null
grep -q '"events":6' vendor-example-make-reinstall.stderr.json
grep -q '"ok":true' vendor-example-make-reinstall.stderr.json
grep -q '"supportDraftRedacted":true' vendor-example-make-reinstall.stderr.json
php vendor/logbrew/sdk/examples/first_useful_telemetry.php > vendor-first-useful-reinstall.stdout.json 2> vendor-first-useful-reinstall.stderr.json
grep -q '"type": "metric"' vendor-first-useful-reinstall.stdout.json
grep -q '"type": "span"' vendor-first-useful-reinstall.stdout.json
grep -q '"events":7' vendor-first-useful-reinstall.stderr.json
python3 "$repo_root/scripts/validate_fixtures.py" vendor-first-useful-reinstall.stdout.json >/dev/null
python3 "$repo_root/scripts/check_php_first_useful_payload.py" vendor-first-useful-reinstall.stdout.json vendor-first-useful-reinstall.stderr.json >/dev/null
(cd vendor/logbrew/sdk/examples && make run-first-useful-telemetry) > vendor-first-useful-make-reinstall.stdout.json 2> vendor-first-useful-make-reinstall.stderr.json
grep -q '"type": "metric"' vendor-first-useful-make-reinstall.stdout.json
grep -q '"events":7' vendor-first-useful-make-reinstall.stderr.json
python3 "$repo_root/scripts/check_php_first_useful_payload.py" vendor-first-useful-make-reinstall.stdout.json vendor-first-useful-make-reinstall.stderr.json >/dev/null
php vendor/logbrew/sdk/examples/issue_diagnostics.php > vendor-issue-diagnostics-reinstall.stdout.json 2> vendor-issue-diagnostics-reinstall.stderr.json
grep -q '"type": "issue"' vendor-issue-diagnostics-reinstall.stdout.json
grep -q '"events":1' vendor-issue-diagnostics-reinstall.stderr.json
python3 "$repo_root/scripts/validate_fixtures.py" vendor-issue-diagnostics-reinstall.stdout.json >/dev/null
python3 "$repo_root/scripts/check_php_issue_diagnostics_payload.py" vendor-issue-diagnostics-reinstall.stdout.json vendor-issue-diagnostics-reinstall.stderr.json >/dev/null
(cd vendor/logbrew/sdk/examples && make run-issue-diagnostics) > vendor-issue-diagnostics-make-reinstall.stdout.json 2> vendor-issue-diagnostics-make-reinstall.stderr.json
grep -q '"type": "issue"' vendor-issue-diagnostics-make-reinstall.stdout.json
grep -q '"events":1' vendor-issue-diagnostics-make-reinstall.stderr.json
python3 "$repo_root/scripts/check_php_issue_diagnostics_payload.py" vendor-issue-diagnostics-make-reinstall.stdout.json vendor-issue-diagnostics-make-reinstall.stderr.json >/dev/null
php vendor/logbrew/sdk/examples/http_trace_correlation.php > vendor-http-trace-reinstall.stdout.json 2> vendor-http-trace-reinstall.stderr.json
grep -q '"type": "metric"' vendor-http-trace-reinstall.stdout.json
grep -q '"type": "span"' vendor-http-trace-reinstall.stdout.json
grep -q '"events":7' vendor-http-trace-reinstall.stderr.json
python3 "$repo_root/scripts/check_php_http_trace_payload.py" vendor-http-trace-reinstall.stdout.json vendor-http-trace-reinstall.stderr.json >/dev/null
(cd vendor/logbrew/sdk/examples && make run-http-trace-correlation) > vendor-http-trace-make-reinstall.stdout.json 2> vendor-http-trace-make-reinstall.stderr.json
grep -q '"type": "metric"' vendor-http-trace-make-reinstall.stdout.json
grep -q '"events":7' vendor-http-trace-make-reinstall.stderr.json
python3 "$repo_root/scripts/check_php_http_trace_payload.py" vendor-http-trace-make-reinstall.stdout.json vendor-http-trace-make-reinstall.stderr.json >/dev/null
composer run --no-interaction --quiet smoke-run >/dev/null
cat > reflection-docs.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

$class = new ReflectionClass(\LogBrew\LogBrewClient::class);
$classDoc = $class->getDocComment() ?: '';
if (!str_contains($classDoc, 'Public PHP client for building, validating, previewing, and flushing LogBrew event batches.')) {
    fwrite(STDERR, "missing class doc summary\n");
    exit(1);
}
if (!str_contains($classDoc, 'ReleaseAttributes describes the public payload fields for a release event.')) {
    fwrite(STDERR, "missing ReleaseAttributes class doc summary\n");
    exit(1);
}
if (!str_contains($classDoc, 'EnvironmentAttributes describes the public payload fields for an environment event.')) {
    fwrite(STDERR, "missing EnvironmentAttributes class doc summary\n");
    exit(1);
}
if (!str_contains($classDoc, 'IssueAttributes describes the public payload fields for an issue event.')) {
    fwrite(STDERR, "missing IssueAttributes class doc summary\n");
    exit(1);
}
if (!str_contains($classDoc, 'LogAttributes describes the public payload fields for a log event.')) {
    fwrite(STDERR, "missing LogAttributes class doc summary\n");
    exit(1);
}
if (!str_contains($classDoc, 'SpanAttributes describes the public payload fields for a span event.')) {
    fwrite(STDERR, "missing SpanAttributes class doc summary\n");
    exit(1);
}
if (!str_contains($classDoc, 'MetricAttributes describes the public payload fields for an explicit metric event.')) {
    fwrite(STDERR, "missing MetricAttributes class doc summary\n");
    exit(1);
}
if (!str_contains($classDoc, 'ActionAttributes describes the public payload fields for an action event.')) {
    fwrite(STDERR, "missing ActionAttributes class doc summary\n");
    exit(1);
}
if (!str_contains($classDoc, '@phpstan-type ReleaseAttributes array{')) {
    fwrite(STDERR, "missing ReleaseAttributes alias definition\n");
    exit(1);
}
if (!str_contains($classDoc, '@phpstan-type EnvironmentAttributes array{')) {
    fwrite(STDERR, "missing EnvironmentAttributes alias definition\n");
    exit(1);
}
if (!str_contains($classDoc, '@phpstan-type IssueAttributes array{')) {
    fwrite(STDERR, "missing IssueAttributes alias definition\n");
    exit(1);
}
if (!str_contains($classDoc, '@phpstan-type LogAttributes array{')) {
    fwrite(STDERR, "missing LogAttributes alias definition\n");
    exit(1);
}
if (!str_contains($classDoc, '@phpstan-type SpanAttributes array{')) {
    fwrite(STDERR, "missing SpanAttributes alias definition\n");
    exit(1);
}
if (!str_contains($classDoc, '@phpstan-type MetricAttributes array{')) {
    fwrite(STDERR, "missing MetricAttributes alias definition\n");
    exit(1);
}
if (!str_contains($classDoc, '@phpstan-type ActionAttributes array{')) {
    fwrite(STDERR, "missing ActionAttributes alias definition\n");
    exit(1);
}

$issueDiagnostics = new ReflectionClass(\LogBrew\IssueDiagnostics::class);
$issueDiagnosticsDoc = $issueDiagnostics->getDocComment() ?: '';
if (!str_contains($issueDiagnosticsDoc, 'Typed, privacy-bounded issue diagnostics for explicit and framework capture.')) {
    fwrite(STDERR, "missing IssueDiagnostics class doc summary\n");
    exit(1);
}
if (!str_contains($issueDiagnosticsDoc, '@phpstan-type IssueStackFrame array{')) {
    fwrite(STDERR, "missing IssueStackFrame alias definition\n");
    exit(1);
}
if (!str_contains($issueDiagnosticsDoc, '@phpstan-type IssueBreadcrumb array{')) {
    fwrite(STDERR, "missing IssueBreadcrumb alias definition\n");
    exit(1);
}
$fromThrowable = $issueDiagnostics->getMethod('fromThrowable')->getDocComment() ?: '';
if (!str_contains($fromThrowable, 'Build complete issue attributes from a throwable without copying sensitive content.')) {
    fwrite(STDERR, "missing IssueDiagnostics::fromThrowable doc summary\n");
    exit(1);
}
if (!str_contains($fromThrowable, '@return IssueAttributes')) {
    fwrite(STDERR, "missing IssueDiagnostics::fromThrowable return docblock\n");
    exit(1);
}

$productTimeline = new ReflectionClass(\LogBrew\ProductTimeline::class);
$productTimelineDoc = $productTimeline->getDocComment() ?: '';
if (!str_contains($productTimelineDoc, 'App-owned product and network timeline helpers.')) {
    fwrite(STDERR, "missing ProductTimeline class doc summary\n");
    exit(1);
}

$productAction = $productTimeline->getMethod('productAction')->getDocComment() ?: '';
if (!str_contains($productAction, 'Create an action attribute payload for a product step already known by the application.')) {
    fwrite(STDERR, "missing ProductTimeline::productAction doc summary\n");
    exit(1);
}
if (!str_contains($productAction, '@return ActionAttributes')) {
    fwrite(STDERR, "missing ProductTimeline::productAction return docblock\n");
    exit(1);
}

$networkMilestone = $productTimeline->getMethod('networkMilestone')->getDocComment() ?: '';
if (!str_contains($networkMilestone, 'Create an action attribute payload for an app-owned API or network milestone.')) {
    fwrite(STDERR, "missing ProductTimeline::networkMilestone doc summary\n");
    exit(1);
}
if (!str_contains($networkMilestone, '@return ActionAttributes')) {
    fwrite(STDERR, "missing ProductTimeline::networkMilestone return docblock\n");
    exit(1);
}

$traceparent = new ReflectionClass(\LogBrew\Traceparent::class);
$traceparentDoc = $traceparent->getDocComment() ?: '';
if (!str_contains($traceparentDoc, 'Dependency-free W3C traceparent helpers for explicit app-owned propagation.')) {
    fwrite(STDERR, "missing Traceparent class doc summary\n");
    exit(1);
}
if (!str_contains($traceparentDoc, '@phpstan-import-type SpanAttributes from LogBrewClient')) {
    fwrite(STDERR, "missing Traceparent span attributes import\n");
    exit(1);
}
$traceparentParse = $traceparent->getMethod('parse')->getDocComment() ?: '';
if (!str_contains($traceparentParse, 'Parse and validate one W3C traceparent header.')) {
    fwrite(STDERR, "missing Traceparent::parse doc summary\n");
    exit(1);
}
$traceparentHeaders = $traceparent->getMethod('createHeaders')->getDocComment() ?: '';
if (!str_contains($traceparentHeaders, '@return array{traceparent:string}')) {
    fwrite(STDERR, "missing Traceparent::createHeaders return docblock\n");
    exit(1);
}
$traceparentSpan = $traceparent->getMethod('spanAttributesFromTraceparent')->getDocComment() ?: '';
if (!str_contains($traceparentSpan, '@return SpanAttributes')) {
    fwrite(STDERR, "missing Traceparent::spanAttributesFromTraceparent return docblock\n");
    exit(1);
}

$traceparentContext = new ReflectionClass(\LogBrew\TraceparentContext::class);
$traceparentContextDoc = $traceparentContext->getDocComment() ?: '';
if (!str_contains($traceparentContextDoc, 'Parsed W3C traceparent context with normalized lowercase identifiers.')) {
    fwrite(STDERR, "missing TraceparentContext class doc summary\n");
    exit(1);
}

$traceparentSpanInput = new ReflectionClass(\LogBrew\TraceparentSpanInput::class);
$traceparentSpanInputDoc = $traceparentSpanInput->getDocComment() ?: '';
if (!str_contains($traceparentSpanInputDoc, 'App-owned child span fields derived from an incoming traceparent.')) {
    fwrite(STDERR, "missing TraceparentSpanInput class doc summary\n");
    exit(1);
}
$traceparentSpanInputCreate = $traceparentSpanInput->getMethod('create')->getDocComment() ?: '';
if (!str_contains($traceparentSpanInputCreate, 'Create a child span input that can be converted into LogBrew span attributes.')) {
    fwrite(STDERR, "missing TraceparentSpanInput::create doc summary\n");
    exit(1);
}

$release = $class->getMethod('release')->getDocComment() ?: '';
if (!str_contains($release, '@param ReleaseAttributes $attributes')) {
    fwrite(STDERR, "missing release method docblock\n");
    exit(1);
}

$metric = $class->getMethod('metric')->getDocComment() ?: '';
if (!str_contains($metric, '@param MetricAttributes $attributes')) {
    fwrite(STDERR, "missing metric method docblock\n");
    exit(1);
}

$create = $class->getMethod('create')->getDocComment() ?: '';
if (!str_contains($create, 'Create a client from public SDK identity, retry, and API key settings.')) {
    fwrite(STDERR, "missing create method doc summary\n");
    exit(1);
}

$preview = $class->getMethod('previewJson')->getDocComment() ?: '';
if (!str_contains($preview, 'Return the queued event batch as stable, pretty-printed JSON.')) {
    fwrite(STDERR, "missing previewJson method doc summary\n");
    exit(1);
}

$pending = $class->getMethod('pendingEvents')->getDocComment() ?: '';
if (!str_contains($pending, 'Return the queued event count currently buffered in memory.')) {
    fwrite(STDERR, "missing pendingEvents method doc summary\n");
    exit(1);
}

$flush = $class->getMethod('flush')->getDocComment() ?: '';
if (!str_contains($flush, 'Flush queued events through a transport while preserving retry semantics.')) {
    fwrite(STDERR, "missing flush method doc summary\n");
    exit(1);
}

$shutdown = $class->getMethod('shutdown')->getDocComment() ?: '';
if (!str_contains($shutdown, 'Flush queued events, then mark the client closed so later writes fail.')) {
    fwrite(STDERR, "missing shutdown method doc summary\n");
    exit(1);
}

$psrLogger = new ReflectionClass(\LogBrew\LogBrewPsrLogger::class);
$psrLoggerDoc = $psrLogger->getDocComment() ?: '';
if (!str_contains($psrLoggerDoc, 'PSR-3 logger implementation that queues LogBrew log events.')) {
    fwrite(STDERR, "missing LogBrewPsrLogger class doc summary\n");
    exit(1);
}
if (!str_contains($psrLoggerDoc, '@phpstan-type MetadataValue string|int|float|bool|null')) {
    fwrite(STDERR, "missing LogBrewPsrLogger metadata value alias\n");
    exit(1);
}
if (!$psrLogger->implementsInterface(\Psr\Log\LoggerInterface::class)) {
    fwrite(STDERR, "expected LogBrewPsrLogger to implement PSR logger interface\n");
    exit(1);
}

$monologHandler = new ReflectionClass(\LogBrew\LogBrewMonologHandler::class);
$monologHandlerDoc = $monologHandler->getDocComment() ?: '';
if (!str_contains($monologHandlerDoc, 'Optional Monolog handler for Laravel and other Monolog-based PHP apps.')) {
    fwrite(STDERR, "missing LogBrewMonologHandler class doc summary\n");
    exit(1);
}
if (!str_contains($monologHandlerDoc, '@phpstan-type MetadataValue string|int|float|bool|null')) {
    fwrite(STDERR, "missing LogBrewMonologHandler metadata value alias\n");
    exit(1);
}
if (!$monologHandler->isSubclassOf(\Monolog\Handler\AbstractProcessingHandler::class)) {
    fwrite(STDERR, "expected LogBrewMonologHandler to extend Monolog processing handler\n");
    exit(1);
}

$laravelLoggerFactory = new ReflectionClass(\LogBrew\LaravelLoggerFactory::class);
$laravelLoggerFactoryDoc = $laravelLoggerFactory->getDocComment() ?: '';
if (!str_contains($laravelLoggerFactoryDoc, 'Config-cache-safe Laravel custom-channel factory with bounded immediate delivery.')) {
    fwrite(STDERR, "missing LaravelLoggerFactory class doc summary\n");
    exit(1);
}
if (!str_contains($laravelLoggerFactoryDoc, '@phpstan-type LaravelChannelConfig array{')) {
    fwrite(STDERR, "missing LaravelLoggerFactory channel config alias\n");
    exit(1);
}
if (!$laravelLoggerFactory->isFinal()
    || !$laravelLoggerFactory->hasMethod('configuration')
    || !$laravelLoggerFactory->hasMethod('__invoke')
    || !$laravelLoggerFactory->hasMethod('registerQueueTelemetry')
) {
    fwrite(STDERR, "missing LaravelLoggerFactory public surface\n");
    exit(1);
}

$supportTicketDraft = new ReflectionClass(\LogBrew\SupportTicketDraft::class);
$supportTicketDraftDoc = $supportTicketDraft->getDocComment() ?: '';
if (!str_contains($supportTicketDraftDoc, 'Local-only support-ticket draft helper for explicit user or agent handoff.')) {
    fwrite(STDERR, "missing SupportTicketDraft class doc summary\n");
    exit(1);
}
if (!str_contains($supportTicketDraftDoc, 'It does not open a ticket, call backend routes, or send telemetry.')) {
    fwrite(STDERR, "missing SupportTicketDraft backend boundary doc\n");
    exit(1);
}
if (!$supportTicketDraft->hasMethod('create')) {
    fwrite(STDERR, "missing SupportTicketDraft create method\n");
    exit(1);
}

$httpTransport = new ReflectionClass(\LogBrew\HttpTransport::class);
$httpTransportDoc = $httpTransport->getDocComment() ?: '';
if (!str_contains($httpTransportDoc, 'Dependency-free HTTP transport for sending queued event batches to LogBrew.')) {
    fwrite(STDERR, "missing HttpTransport class doc summary\n");
    exit(1);
}
if (!$httpTransport->implementsInterface(\LogBrew\Transport::class)) {
    fwrite(STDERR, "expected HttpTransport to implement transport interface\n");
    exit(1);
}
if ($httpTransport->getConstant('DEFAULT_ENDPOINT') !== 'https://api.logbrew.co/v1/events') {
    fwrite(STDERR, "unexpected HttpTransport default endpoint\n");
    exit(1);
}
if ($httpTransport->getConstant('DEFAULT_TIMEOUT') !== 10.0) {
    fwrite(STDERR, "unexpected HttpTransport default timeout\n");
    exit(1);
}
$httpSend = $httpTransport->getMethod('send')->getDocComment() ?: '';
if (!str_contains($httpSend, 'POST one serialized event batch and return the HTTP status.')) {
    fwrite(STDERR, "missing HttpTransport::send doc summary\n");
    exit(1);
}

$transport = new ReflectionClass(\LogBrew\RecordingTransport::class);
$transportDoc = $transport->getDocComment() ?: '';
if (!str_contains($transportDoc, 'Scripted transport for previewing, accepting, or failing queued event flushes.')) {
    fwrite(STDERR, "missing RecordingTransport class doc summary\n");
    exit(1);
}

$transportInterface = new ReflectionClass(\LogBrew\Transport::class);
$transportInterfaceDoc = $transportInterface->getDocComment() ?: '';
if (!str_contains($transportInterfaceDoc, 'Public transport contract used by flush and shutdown operations.')) {
    fwrite(STDERR, "missing Transport interface doc summary\n");
    exit(1);
}

$transportSend = $transportInterface->getMethod('send')->getDocComment() ?: '';
if (!str_contains($transportSend, 'Send a queued request body through the transport and return its response.')) {
    fwrite(STDERR, "missing Transport::send doc summary\n");
    exit(1);
}

$alwaysAccept = $transport->getMethod('alwaysAccept')->getDocComment() ?: '';
if (!str_contains($alwaysAccept, 'Create a transport that accepts queued flushes with a 202 response.')) {
    fwrite(STDERR, "missing alwaysAccept method doc summary\n");
    exit(1);
}

$lastBody = $transport->getMethod('lastBody')->getDocComment() ?: '';
if (!str_contains($lastBody, 'Return the most recent request body sent through this transport.')) {
    fwrite(STDERR, "missing lastBody method doc summary\n");
    exit(1);
}

$recordingSend = $transport->getMethod('send')->getDocComment() ?: '';
if (!str_contains($recordingSend, 'Send a queued request body through the scripted transport sequence.')) {
    fwrite(STDERR, "missing RecordingTransport::send doc summary\n");
    exit(1);
}

$sentBodies = $transport->getProperty('sentBodies')->getDocComment() ?: '';
if (!str_contains($sentBodies, 'Every request body sent through this transport instance.')) {
    fwrite(STDERR, "missing RecordingTransport::\$sentBodies doc summary\n");
    exit(1);
}

$transportResponse = new ReflectionClass(\LogBrew\TransportResponse::class);
$transportResponseDoc = $transportResponse->getDocComment() ?: '';
if (!str_contains($transportResponseDoc, 'Stable transport response returned from flush and shutdown operations.')) {
    fwrite(STDERR, "missing TransportResponse class doc summary\n");
    exit(1);
}

$statusCode = $transportResponse->getProperty('statusCode')->getDocComment() ?: '';
if (!str_contains($statusCode, 'Final HTTP-like status returned by the transport.')) {
    fwrite(STDERR, "missing TransportResponse::\$statusCode doc summary\n");
    exit(1);
}

$attempts = $transportResponse->getProperty('attempts')->getDocComment() ?: '';
if (!str_contains($attempts, 'Number of transport attempts used for the flush.')) {
    fwrite(STDERR, "missing TransportResponse::\$attempts doc summary\n");
    exit(1);
}

$sdkError = new ReflectionClass(\LogBrew\SdkError::class);
$sdkErrorDoc = $sdkError->getDocComment() ?: '';
if (!str_contains($sdkErrorDoc, 'Stable public SDK error with a parseable code and message.')) {
    fwrite(STDERR, "missing SdkError class doc summary\n");
    exit(1);
}

$sdkErrorConstruct = $sdkError->getMethod('__construct')->getDocComment() ?: '';
if (!str_contains($sdkErrorConstruct, 'Create a public SDK error with a stable code name and message.')) {
    fwrite(STDERR, "missing SdkError constructor doc summary\n");
    exit(1);
}

$transportError = new ReflectionClass(\LogBrew\TransportError::class);
$transportErrorDoc = $transportError->getDocComment() ?: '';
if (!str_contains($transportErrorDoc, 'Transport failure with a stable public code and retry hint.')) {
    fwrite(STDERR, "missing TransportError class doc summary\n");
    exit(1);
}

$network = $transportError->getMethod('network')->getDocComment() ?: '';
if (!str_contains($network, 'Create a retryable network failure that preserves queued events.')) {
    fwrite(STDERR, "missing TransportError::network doc summary\n");
    exit(1);
}
EOF
php reflection-docs.php >/dev/null
composer require --dev phpstan/phpstan --no-interaction --quiet
mkdir -p "$tmp_dir/phpstan-cache"
cat > phpstan.neon <<EOF
parameters:
  tmpDir: $tmp_dir/phpstan-cache
EOF

cat > phpstan-consumer.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LaravelLoggerFactory;
use LogBrew\IssueDiagnostics;
use LogBrew\LogBrewClient;
use LogBrew\LogBrewMonologHandler;
use LogBrew\LogBrewPsrLogger;
use LogBrew\HttpTransport;
use LogBrew\ProductTimeline;
use LogBrew\RecordingTransport;
use Monolog\Logger as MonologLogger;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app-types', '0.1.0');
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
$diagnosticError = new RuntimeException('message remains local');
$client->issue(
    'evt_issue_diagnostics',
    '2026-06-02T10:00:02Z',
    IssueDiagnostics::fromThrowable(
        $diagnosticError,
        breadcrumbs: [IssueDiagnostics::breadcrumb(
            '2026-06-02T09:59:59Z',
            'checkout.request',
            level: 'warn',
            data: ['attempt' => 2]
        )]
    )
);
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
$client->metric('evt_metric_001', '2026-06-02T10:00:06Z', [
    'name' => 'queue.depth',
    'kind' => 'gauge',
    'value' => 42,
    'unit' => '{items}',
    'temporality' => 'instant',
    'metadata' => ['queue' => 'default'],
]);
$client->action('evt_action_001', '2026-06-02T10:00:05Z', [
    'name' => 'deploy',
    'status' => 'success',
]);
$client->action('evt_product_timeline_001', '2026-06-02T10:00:06Z', ProductTimeline::productAction(
    name: 'checkout.submit',
    routeTemplate: '/checkout/:step?cart=sample#review',
    sessionId: 'session_123',
    traceId: 'trace_abc',
    metadata: ['cartTier' => 'gold']
));
$client->action('evt_network_timeline_001', '2026-06-02T10:00:07Z', ProductTimeline::networkMilestone(
    routeTemplate: '/api/payments/:id?debug=sample',
    method: 'POST',
    statusCode: 202,
    durationMs: 42.0,
    metadata: ['api' => 'payments']
));

$response = $client->flush(RecordingTransport::alwaysAccept());
if ($response->statusCode !== 202) {
    throw new RuntimeException('unexpected status code');
}

$loggerClient = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app-types', '0.1.0');
$logger = new LogBrewPsrLogger(
    client: $loggerClient,
    loggerName: 'checkout',
    metadata: ['service' => 'checkout']
);
$logger->warning('Checkout slow for {region}', ['region' => 'global', 'attempt' => 2]);

$monologClient = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app-types', '0.1.0');
$monolog = new MonologLogger('checkout.monolog');
$monolog->pushHandler(new LogBrewMonologHandler(
    client: $monologClient,
    metadata: ['service' => 'checkout']
));
$monolog->warning('Checkout slow for {region}', ['region' => 'global', 'attempt' => 2]);

$laravelLogger = (new LaravelLoggerFactory(RecordingTransport::alwaysAccept()))(
    LaravelLoggerFactory::configuration(
        apiKey: 'LOGBREW_SERVER_API_KEY',
        service: 'smoke-laravel-types',
        release: '1.0.0',
        environment: 'testing'
    )
);
$laravelLogger->warning('Queue {queue} is delayed.', ['queue' => 'default']);

$httpClient = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app-types', '0.1.0');
$httpClient->release('evt_release_http', '2026-06-02T10:00:00Z', ['version' => '1.2.3']);
$httpResponse = $httpClient->flush(new HttpTransport(
    endpoint: HttpTransport::DEFAULT_ENDPOINT,
    headers: ['x-logbrew-test' => 'php'],
    requester: static function (string $endpoint, mixed $context): int {
        if ($endpoint === '') {
            throw new RuntimeException('missing endpoint');
        }
        if (!is_resource($context)) {
            throw new RuntimeException('missing stream context');
        }

        return 202;
    }
));
if ($httpResponse->statusCode !== 202) {
    throw new RuntimeException('unexpected HTTP status code');
}
EOF

composer run --no-interaction smoke-types
rm -rf vendor
composer install --no-interaction --quiet
composer run --no-interaction smoke-types

php smoke.php > smoke.stdout.json 2> smoke.stderr.json
grep -q '"type": "release"' smoke.stdout.json
grep -q '"type": "environment"' smoke.stdout.json
grep -q '"type": "issue"' smoke.stdout.json
grep -q '"type": "log"' smoke.stdout.json
grep -q '"type": "span"' smoke.stdout.json
grep -q '"type": "action"' smoke.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" smoke.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" smoke.stdout.json >/dev/null
grep -q '"events":6' smoke.stderr.json
grep -q '"ok":true' smoke.stderr.json
composer run --no-interaction --quiet smoke-run >/dev/null

cat > metric.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\SdkError;

function requireMetric(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, $message . PHP_EOL);
        exit(1);
    }
}

function expectMetricError(callable $callback, string $needle): void
{
    try {
        $callback();
    } catch (SdkError $error) {
        requireMetric(str_contains($error->getMessage(), $needle), "expected metric error containing {$needle}");
        return;
    }

    fwrite(STDERR, "expected metric error containing {$needle}" . PHP_EOL);
    exit(1);
}

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app-metrics', '0.1.0');
$client->metric('evt_metric_queue_depth', '2026-06-02T10:00:06Z', [
    'name' => 'queue.depth',
    'kind' => 'gauge',
    'value' => -2.0,
    'unit' => '{items}',
    'temporality' => 'instant',
    'metadata' => ['service' => 'worker', 'queue' => 'default'],
]);
$preview = $client->previewJson();
requireMetric($client->pendingEvents() === 1, 'expected metric event to queue');
foreach ([
    '"type": "metric"',
    '"name": "queue.depth"',
    '"kind": "gauge"',
    '"value": -2',
    '"unit": "{items}"',
    '"temporality": "instant"',
    '"queue": "default"',
] as $needle) {
    requireMetric(str_contains($preview, $needle), "missing metric payload {$needle}");
}
expectMetricError(static fn () => LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app-metrics', '0.1.0')->metric('evt_metric_invalid_value', '2026-06-02T10:00:06Z', [
    'name' => 'queue.depth',
    'kind' => 'gauge',
    'value' => NAN,
    'unit' => '{items}',
    'temporality' => 'instant',
]), 'metric value must be a finite number');
expectMetricError(static fn () => LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app-metrics', '0.1.0')->metric('evt_metric_invalid_counter', '2026-06-02T10:00:06Z', [
    'name' => 'jobs.completed',
    'kind' => 'counter',
    'value' => -1,
    'unit' => '1',
    'temporality' => 'delta',
]), 'metric counter value must be non-negative');
expectMetricError(static fn () => LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app-metrics', '0.1.0')->metric('evt_metric_invalid_temporality', '2026-06-02T10:00:06Z', [
    'name' => 'queue.depth',
    'kind' => 'gauge',
    'value' => 2,
    'unit' => '{items}',
    'temporality' => 'delta',
]), 'metric temporality for gauge must be one of');
fwrite(STDERR, json_encode(['metricEvents' => 1], JSON_THROW_ON_ERROR) . PHP_EOL);
EOF

php metric.php > metric.stdout.txt 2> metric.stderr.json
test ! -s metric.stdout.txt
grep -q '"metricEvents":1' metric.stderr.json

php timeline.php > timeline.stdout.json 2> timeline.stderr.json
grep -q '"source": "product_timeline"' timeline.stdout.json
grep -q '"source": "network_timeline"' timeline.stdout.json
grep -q '"name": "network.post \\/v1\\/payments\\/:id"' timeline.stdout.json
grep -q '"timelineEvents":3' timeline.stderr.json

cat > transport-contracts.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\SdkError;
use LogBrew\TransportError;

function clientWithRelease(string $id): LogBrewClient
{
    $client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');
    $client->release("evt_release_{$id}", '2026-06-02T10:00:00Z', ['version' => '1.2.3']);
    return $client;
}

function expectSdkError(LogBrewClient $client, callable $operation, string $code, string $message, int $pending): void
{
    try {
        $operation();
    } catch (SdkError $error) {
        if ($error->codeName === $code && $error->getMessage() === $message && $client->pendingEvents() === $pending) {
            return;
        }
        throw $error;
    }
    throw new RuntimeException("expected {$code}");
}

$client = clientWithRelease('unauth');
expectSdkError($client, fn () => $client->flush(new RecordingTransport([401])), 'unauthenticated', 'transport rejected the API key', 1);

$client = clientWithRelease('retry');
$response = $client->flush(new RecordingTransport([TransportError::network('temporary outage'), 202]));
if ($response->statusCode !== 202 || $response->attempts !== 2 || $client->pendingEvents() !== 0) {
    throw new RuntimeException('unexpected retry result');
}

$client = clientWithRelease('shutdown');
$client->shutdown(RecordingTransport::alwaysAccept());
expectSdkError(
    $client,
    fn () => $client->log('evt_log_shutdown', '2026-06-02T10:00:01Z', ['message' => 'should fail', 'level' => 'info']),
    'shutdown_error',
    'client is already shut down',
    0
);

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');
$response = $client->flush(RecordingTransport::alwaysAccept());
if ($response->statusCode !== 204 || $response->attempts !== 0 || $client->pendingEvents() !== 0) {
    throw new RuntimeException('unexpected empty flush result');
}
expectSdkError(
    $client,
    fn () => $client->log('evt_log_invalid', '2026-06-02T10:00:03', ['message' => 'should fail', 'level' => 'info']),
    'validation_error',
    'timestamp must be a valid RFC3339 date-time: 2026-06-02T10:00:03',
    0
);

$client = clientWithRelease('retry_budget');
expectSdkError(
    $client,
    fn () => $client->flush(new RecordingTransport(array_fill(0, 3, TransportError::network('temporary outage')))),
    'network_failure',
    'transport network request failed',
    1
);
$client = clientWithRelease('transport_status');
expectSdkError($client, fn () => $client->flush(new RecordingTransport([400])), 'transport_error', 'unexpected transport status 400', 1);

echo json_encode(['ok' => true, 'contracts' => 7], JSON_THROW_ON_ERROR) . PHP_EOL;
EOF

php transport-contracts.php > transport-contracts.stdout.json
grep -q '"ok":true' transport-contracts.stdout.json
grep -q '"contracts":7' transport-contracts.stdout.json
