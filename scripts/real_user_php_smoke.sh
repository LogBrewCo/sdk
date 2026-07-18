#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

export COMPOSER_HOME="$tmp_dir/composer-home"
export COMPOSER_CACHE_DIR="$tmp_dir/composer-cache"

cd "$tmp_dir"

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
$composerJson = null;
$readme = null;
$readmeExample = null;
$example = null;
$firstUsefulExample = null;
$httpTraceExample = null;
$workerLifecycleExample = null;
$persistentWorkerDeliveryExample = null;
$exampleMakefile = null;
$httpTransport = null;
$productTimeline = null;
$traceparent = null;
$traceparentContext = null;
$traceparentSpanInput = null;
$traceContext = null;
$traceScope = null;
$trace = null;
$operationTracing = null;
$httpRequestTelemetry = null;
$psrLogger = null;
$monologHandler = null;
$supportTicketDraft = null;
for ($i = 0; $i < $zip->numFiles; $i++) {
    $name = $zip->getNameIndex($i);
    if ($name === false) {
        continue;
    }
    if ($name === "composer.json" || str_ends_with($name, "/composer.json")) {
        $composerJson = $zip->getFromIndex($i);
    }
    if ($name === "README.md" || str_ends_with($name, "/README.md")) {
        $readme = $zip->getFromIndex($i);
    }
    if ($name === "examples/readme_example.php" || str_ends_with($name, "/examples/readme_example.php")) {
        $readmeExample = $zip->getFromIndex($i);
    }
    if ($name === "examples/real_user_smoke.php" || str_ends_with($name, "/examples/real_user_smoke.php")) {
        $example = $zip->getFromIndex($i);
    }
    if ($name === "examples/first_useful_telemetry.php" || str_ends_with($name, "/examples/first_useful_telemetry.php")) {
        $firstUsefulExample = $zip->getFromIndex($i);
    }
    if ($name === "examples/http_trace_correlation.php" || str_ends_with($name, "/examples/http_trace_correlation.php")) {
        $httpTraceExample = $zip->getFromIndex($i);
    }
    if ($name === "examples/worker_lifecycle.php" || str_ends_with($name, "/examples/worker_lifecycle.php")) {
        $workerLifecycleExample = $zip->getFromIndex($i);
    }
    if ($name === "examples/persistent_worker_delivery.php" || str_ends_with($name, "/examples/persistent_worker_delivery.php")) {
        $persistentWorkerDeliveryExample = $zip->getFromIndex($i);
    }
    if ($name === "examples/Makefile" || str_ends_with($name, "/examples/Makefile")) {
        $exampleMakefile = $zip->getFromIndex($i);
    }
    if ($name === "src/HttpTransport.php" || str_ends_with($name, "/src/HttpTransport.php")) {
        $httpTransport = $zip->getFromIndex($i);
    }
    if ($name === "src/ProductTimeline.php" || str_ends_with($name, "/src/ProductTimeline.php")) {
        $productTimeline = $zip->getFromIndex($i);
    }
    if ($name === "src/Traceparent.php" || str_ends_with($name, "/src/Traceparent.php")) {
        $traceparent = $zip->getFromIndex($i);
    }
    if ($name === "src/TraceparentContext.php" || str_ends_with($name, "/src/TraceparentContext.php")) {
        $traceparentContext = $zip->getFromIndex($i);
    }
    if ($name === "src/TraceparentSpanInput.php" || str_ends_with($name, "/src/TraceparentSpanInput.php")) {
        $traceparentSpanInput = $zip->getFromIndex($i);
    }
    if ($name === "src/LogBrewTraceContext.php" || str_ends_with($name, "/src/LogBrewTraceContext.php")) {
        $traceContext = $zip->getFromIndex($i);
    }
    if ($name === "src/LogBrewTraceScope.php" || str_ends_with($name, "/src/LogBrewTraceScope.php")) {
        $traceScope = $zip->getFromIndex($i);
    }
    if ($name === "src/LogBrewTrace.php" || str_ends_with($name, "/src/LogBrewTrace.php")) {
        $trace = $zip->getFromIndex($i);
    }
    if ($name === "src/LogBrewOperationTracing.php" || str_ends_with($name, "/src/LogBrewOperationTracing.php")) {
        $operationTracing = $zip->getFromIndex($i);
    }
    if ($name === "src/LogBrewHttpRequestTelemetry.php" || str_ends_with($name, "/src/LogBrewHttpRequestTelemetry.php")) {
        $httpRequestTelemetry = $zip->getFromIndex($i);
    }
    if ($name === "src/LogBrewPsrLogger.php" || str_ends_with($name, "/src/LogBrewPsrLogger.php")) {
        $psrLogger = $zip->getFromIndex($i);
    }
    if ($name === "src/LogBrewMonologHandler.php" || str_ends_with($name, "/src/LogBrewMonologHandler.php")) {
        $monologHandler = $zip->getFromIndex($i);
    }
    if ($name === "src/SupportTicketDraft.php" || str_ends_with($name, "/src/SupportTicketDraft.php")) {
        $supportTicketDraft = $zip->getFromIndex($i);
    }
}
$zip->close();
if (!is_string($composerJson)) {
    fwrite(STDERR, "missing composer.json in composer archive\n");
    exit(1);
}
if (!is_string($readme)) {
    fwrite(STDERR, "missing README.md in composer archive\n");
    exit(1);
}
if (!is_string($readmeExample)) {
    fwrite(STDERR, "missing examples/readme_example.php in composer archive\n");
    exit(1);
}
if (!is_string($example)) {
    fwrite(STDERR, "missing examples/real_user_smoke.php in composer archive\n");
    exit(1);
}
if (!is_string($firstUsefulExample)) {
    fwrite(STDERR, "missing examples/first_useful_telemetry.php in composer archive\n");
    exit(1);
}
if (!is_string($httpTraceExample)) {
    fwrite(STDERR, "missing examples/http_trace_correlation.php in composer archive\n");
    exit(1);
}
if (!is_string($workerLifecycleExample)) {
    fwrite(STDERR, "missing examples/worker_lifecycle.php in composer archive\n");
    exit(1);
}
if (!is_string($persistentWorkerDeliveryExample)) {
    fwrite(STDERR, "missing examples/persistent_worker_delivery.php in composer archive\n");
    exit(1);
}
if (!is_string($exampleMakefile)) {
    fwrite(STDERR, "missing examples/Makefile in composer archive\n");
    exit(1);
}
if (!is_string($httpTransport)) {
    fwrite(STDERR, "missing src/HttpTransport.php in composer archive\n");
    exit(1);
}
if (!is_string($productTimeline)) {
    fwrite(STDERR, "missing src/ProductTimeline.php in composer archive\n");
    exit(1);
}
if (!is_string($traceparent)) {
    fwrite(STDERR, "missing src/Traceparent.php in composer archive\n");
    exit(1);
}
if (!is_string($traceparentContext)) {
    fwrite(STDERR, "missing src/TraceparentContext.php in composer archive\n");
    exit(1);
}
if (!is_string($traceparentSpanInput)) {
    fwrite(STDERR, "missing src/TraceparentSpanInput.php in composer archive\n");
    exit(1);
}
if (!is_string($traceContext)) {
    fwrite(STDERR, "missing src/LogBrewTraceContext.php in composer archive\n");
    exit(1);
}
if (!is_string($traceScope)) {
    fwrite(STDERR, "missing src/LogBrewTraceScope.php in composer archive\n");
    exit(1);
}
if (!is_string($trace)) {
    fwrite(STDERR, "missing src/LogBrewTrace.php in composer archive\n");
    exit(1);
}
if (!is_string($operationTracing)) {
    fwrite(STDERR, "missing src/LogBrewOperationTracing.php in composer archive\n");
    exit(1);
}
if (!is_string($httpRequestTelemetry)) {
    fwrite(STDERR, "missing src/LogBrewHttpRequestTelemetry.php in composer archive\n");
    exit(1);
}
if (!is_string($psrLogger)) {
    fwrite(STDERR, "missing src/LogBrewPsrLogger.php in composer archive\n");
    exit(1);
}
if (!is_string($monologHandler)) {
    fwrite(STDERR, "missing src/LogBrewMonologHandler.php in composer archive\n");
    exit(1);
}
if (!is_string($supportTicketDraft)) {
    fwrite(STDERR, "missing src/SupportTicketDraft.php in composer archive\n");
    exit(1);
}
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
if (($manifest["autoload"]["psr-4"]["LogBrew\\"] ?? null) !== "src/") {
    fwrite(STDERR, "unexpected composer archive psr-4 mapping\n");
    exit(1);
}
foreach ([
    "composer require logbrew/sdk" => "missing composer archive README install command\n",
    "LOGBREW_API_KEY" => "missing composer archive fake API key placeholder\n",
    "previewJson()" => "missing composer archive previewJson guidance\n",
    "MetricAttributes" => "missing composer archive metric guidance\n",
    "This SDK does not automatically collect PHP runtime, FPM, framework, or database metrics yet." => "missing composer archive metric auto-capture guidance\n",
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
    "Monolog And Laravel" => "missing composer archive Laravel heading\n",
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
if (!str_contains($httpTraceExample, "../vendor/autoload.php") || !str_contains($httpTraceExample, "../../../autoload.php")) {
    fwrite(STDERR, "missing composer archive dual-context autoload support in HTTP trace example\n");
    exit(1);
}
if (!str_contains($exampleMakefile, ".PHONY: help run run-readme-example run-real-user-smoke run-first-useful-telemetry run-http-trace-correlation run-worker-lifecycle run-persistent-worker-delivery")
    || !str_contains($exampleMakefile, "help:")
    || !str_contains($exampleMakefile, "run: run-real-user-smoke")
    || !str_contains($exampleMakefile, "run-readme-example:")
    || !str_contains($exampleMakefile, "@php readme_example.php")
    || !str_contains($exampleMakefile, "run-real-user-smoke:")
    || !str_contains($exampleMakefile, "@php real_user_smoke.php")
    || !str_contains($exampleMakefile, "run-first-useful-telemetry:")
    || !str_contains($exampleMakefile, "@php first_useful_telemetry.php")
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
test -f vendor/logbrew/sdk/README.md
test -f vendor/logbrew/sdk/composer.json
test -f vendor/logbrew/sdk/src/HttpTransport.php
test -f vendor/logbrew/sdk/src/ProductTimeline.php
test -f vendor/logbrew/sdk/src/Traceparent.php
test -f vendor/logbrew/sdk/src/TraceparentContext.php
test -f vendor/logbrew/sdk/src/TraceparentSpanInput.php
test -f vendor/logbrew/sdk/src/LogBrewTraceContext.php
test -f vendor/logbrew/sdk/src/LogBrewTraceScope.php
test -f vendor/logbrew/sdk/src/LogBrewTrace.php
test -f vendor/logbrew/sdk/src/LogBrewOperationTracing.php
test -f vendor/logbrew/sdk/src/LogBrewHttpRequestTelemetry.php
test -f vendor/logbrew/sdk/src/LogBrewMonologHandler.php
test -f vendor/logbrew/sdk/src/LogBrewPsrLogger.php
test -f vendor/logbrew/sdk/src/SupportTicketDraft.php
test -f vendor/logbrew/sdk/examples/readme_example.php
test -f vendor/logbrew/sdk/examples/real_user_smoke.php
test -f vendor/logbrew/sdk/examples/first_useful_telemetry.php
test -f vendor/logbrew/sdk/examples/http_trace_correlation.php
test -f vendor/logbrew/sdk/examples/worker_lifecycle.php
test -f vendor/logbrew/sdk/examples/persistent_worker_delivery.php
test -f vendor/logbrew/sdk/examples/Makefile
php -l vendor/logbrew/sdk/examples/worker_lifecycle.php >/dev/null
php -l vendor/logbrew/sdk/examples/persistent_worker_delivery.php >/dev/null
test -f vendor/composer/installed.json
test -f vendor/composer/autoload_psr4.php
(cd vendor/logbrew/sdk/examples && make) > vendor-example-make-help.txt
grep -qx 'run-readme-example -> make run-readme-example' <(sed -n '1p' vendor-example-make-help.txt)
grep -qx 'run (real-user-smoke) -> make run' <(sed -n '2p' vendor-example-make-help.txt)
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' <(sed -n '3p' vendor-example-make-help.txt)
grep -qx 'run-first-useful-telemetry -> make run-first-useful-telemetry' <(sed -n '4p' vendor-example-make-help.txt)
grep -qx 'run-http-trace-correlation -> make run-http-trace-correlation' <(sed -n '5p' vendor-example-make-help.txt)
grep -qx 'run-worker-lifecycle -> make run-worker-lifecycle' <(sed -n '6p' vendor-example-make-help.txt)
grep -qx 'run-persistent-worker-delivery -> make run-persistent-worker-delivery' <(sed -n '7p' vendor-example-make-help.txt)
test "$(wc -l < vendor-example-make-help.txt | tr -d ' ')" = "7"
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
    "MetricAttributes" => "missing installed README metric guidance\n",
    "This SDK does not automatically collect PHP runtime, FPM, framework, or database metrics yet." => "missing installed README metric auto-capture guidance\n",
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
    "Monolog And Laravel" => "missing installed README Laravel heading\n",
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
if (($data["autoload"]["psr-4"]["LogBrew\\"] ?? null) !== "src/") {
    fwrite(STDERR, "unexpected installed psr-4 mapping\n");
    exit(1);
}
' vendor/logbrew/sdk/composer.json
php vendor/logbrew/sdk/examples/readme_example.php > vendor-readme-example.stdout.json 2> vendor-readme-example.stderr.json
grep -q '"type": "release"' vendor-readme-example.stdout.json
grep -q '"type": "environment"' vendor-readme-example.stdout.json
grep -q '"type": "issue"' vendor-readme-example.stdout.json
grep -q '"type": "log"' vendor-readme-example.stdout.json
grep -q '"type": "span"' vendor-readme-example.stdout.json
grep -q '"type": "action"' vendor-readme-example.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" vendor-readme-example.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" vendor-readme-example.stdout.json >/dev/null
grep -q '"events":6' vendor-readme-example.stderr.json
grep -q '"ok":true' vendor-readme-example.stderr.json
(cd vendor/logbrew/sdk/examples && make run-readme-example) > vendor-readme-example-make.stdout.json 2> vendor-readme-example-make.stderr.json
grep -q '"type": "release"' vendor-readme-example-make.stdout.json
grep -q '"type": "environment"' vendor-readme-example-make.stdout.json
grep -q '"type": "issue"' vendor-readme-example-make.stdout.json
grep -q '"type": "log"' vendor-readme-example-make.stdout.json
grep -q '"type": "span"' vendor-readme-example-make.stdout.json
grep -q '"type": "action"' vendor-readme-example-make.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" vendor-readme-example-make.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" vendor-readme-example-make.stdout.json >/dev/null
grep -q '"events":6' vendor-readme-example-make.stderr.json
grep -q '"ok":true' vendor-readme-example-make.stderr.json
php vendor/logbrew/sdk/examples/real_user_smoke.php > vendor-example.stdout.json 2> vendor-example.stderr.json
grep -q '"type": "release"' vendor-example.stdout.json
grep -q '"type": "environment"' vendor-example.stdout.json
grep -q '"type": "issue"' vendor-example.stdout.json
grep -q '"type": "log"' vendor-example.stdout.json
grep -q '"type": "span"' vendor-example.stdout.json
grep -q '"type": "action"' vendor-example.stdout.json
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
grep -q '"type": "release"' vendor-example-make.stdout.json
grep -q '"type": "environment"' vendor-example-make.stdout.json
grep -q '"type": "issue"' vendor-example-make.stdout.json
grep -q '"type": "log"' vendor-example-make.stdout.json
grep -q '"type": "span"' vendor-example-make.stdout.json
grep -q '"type": "action"' vendor-example-make.stdout.json
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
test -f vendor/logbrew/sdk/README.md
test -f vendor/logbrew/sdk/composer.json
test -f vendor/logbrew/sdk/src/HttpTransport.php
test -f vendor/logbrew/sdk/src/ProductTimeline.php
test -f vendor/logbrew/sdk/src/Traceparent.php
test -f vendor/logbrew/sdk/src/TraceparentContext.php
test -f vendor/logbrew/sdk/src/TraceparentSpanInput.php
test -f vendor/logbrew/sdk/src/LogBrewTraceContext.php
test -f vendor/logbrew/sdk/src/LogBrewTraceScope.php
test -f vendor/logbrew/sdk/src/LogBrewTrace.php
test -f vendor/logbrew/sdk/src/LogBrewOperationTracing.php
test -f vendor/logbrew/sdk/src/LogBrewHttpRequestTelemetry.php
test -f vendor/logbrew/sdk/src/LogBrewMonologHandler.php
test -f vendor/logbrew/sdk/src/LogBrewPsrLogger.php
test -f vendor/logbrew/sdk/src/SupportTicketDraft.php
test -f vendor/logbrew/sdk/examples/first_useful_telemetry.php
test -f vendor/logbrew/sdk/examples/http_trace_correlation.php
test -f vendor/logbrew/sdk/examples/worker_lifecycle.php
test -f vendor/logbrew/sdk/examples/persistent_worker_delivery.php
php -l vendor/logbrew/sdk/examples/worker_lifecycle.php >/dev/null
php -l vendor/logbrew/sdk/examples/persistent_worker_delivery.php >/dev/null
test -f vendor/composer/installed.json
test -f vendor/composer/autoload_psr4.php
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($data["require-dev"]["monolog/monolog"] ?? null) !== "^3.0") {
    fwrite(STDERR, "unexpected rerequired monolog dev constraint\n");
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
        'authorization' => 'Bearer lbw_ingest_secret_value',
        'endpoint' => 'https://api.example.com/v1/events?token=secret#fragment',
        'localPath' => '/Users/example/project/.env',
        'debugNote' => 'failed at https://api.example.com/v1/events?token=secret from /Users/example/project/.env',
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
    'lbw_ingest_secret_value',
    'api.example.com',
    'token=secret',
    '/Users/example/project',
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
fwrite(STDERR, json_encode([
    'ok' => true,
    'status' => $response->statusCode,
    'attempts' => $response->attempts,
    'events' => 6,
], JSON_THROW_ON_ERROR) . PHP_EOL);
EOF

cat > smoke.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');
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
$data["scripts"]["smoke-http-transport"] = "php http-transport.php";
$data["scripts"]["smoke-vendor-example"] = "php vendor/logbrew/sdk/examples/real_user_smoke.php";
$data["scripts"]["smoke-first-useful"] = "php vendor/logbrew/sdk/examples/first_useful_telemetry.php";
$data["scripts"]["smoke-http-trace"] = "php vendor/logbrew/sdk/examples/http_trace_correlation.php";
$data["scripts"]["smoke-types"] = "@php vendor/bin/phpstan analyse phpstan-consumer.php --level=max --memory-limit=512M --no-progress";
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
grep -q '"type": "release"' readme-example.stdout.json
grep -q '"type": "environment"' readme-example.stdout.json
grep -q '"type": "issue"' readme-example.stdout.json
grep -q '"type": "log"' readme-example.stdout.json
grep -q '"type": "span"' readme-example.stdout.json
grep -q '"type": "action"' readme-example.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" readme-example.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" readme-example.stdout.json >/dev/null
grep -q '"events":6' readme-example.stderr.json
grep -q '"ok":true' readme-example.stderr.json

rm -rf vendor
composer install --no-interaction --quiet
composer validate --no-check-publish --no-check-version --strict >/dev/null
test -f vendor/logbrew/sdk/README.md
test -f vendor/logbrew/sdk/composer.json
test -f vendor/logbrew/sdk/src/HttpTransport.php
test -f vendor/logbrew/sdk/src/ProductTimeline.php
test -f vendor/logbrew/sdk/src/Traceparent.php
test -f vendor/logbrew/sdk/src/TraceparentContext.php
test -f vendor/logbrew/sdk/src/TraceparentSpanInput.php
test -f vendor/logbrew/sdk/src/LogBrewTraceContext.php
test -f vendor/logbrew/sdk/src/LogBrewTraceScope.php
test -f vendor/logbrew/sdk/src/LogBrewTrace.php
test -f vendor/logbrew/sdk/src/LogBrewOperationTracing.php
test -f vendor/logbrew/sdk/src/LogBrewHttpRequestTelemetry.php
test -f vendor/logbrew/sdk/src/LogBrewMonologHandler.php
test -f vendor/logbrew/sdk/src/LogBrewPsrLogger.php
test -f vendor/logbrew/sdk/src/SupportTicketDraft.php
test -f vendor/logbrew/sdk/examples/first_useful_telemetry.php
test -f vendor/logbrew/sdk/examples/http_trace_correlation.php
test -f vendor/composer/installed.json
test -f vendor/composer/autoload_psr4.php
php -r '
$data = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
if (($data["require-dev"]["monolog/monolog"] ?? null) !== "^3.0") {
    fwrite(STDERR, "unexpected reinstall monolog dev constraint\n");
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
composer run --no-interaction smoke-http-transport > http-transport-reinstall.stdout.json 2> http-transport-reinstall.stderr.json
grep -q '"httpTransport":true' http-transport-reinstall.stderr.json
grep -q '"httpAttempts":2' http-transport-reinstall.stderr.json
grep -q '"httpRequests":2' http-transport-reinstall.stderr.json
composer run --no-interaction --quiet smoke-vendor-example >/dev/null
php readme-example.php > readme-example-reinstall.stdout.json 2> readme-example-reinstall.stderr.json
grep -q '"type": "release"' readme-example-reinstall.stdout.json
grep -q '"type": "environment"' readme-example-reinstall.stdout.json
grep -q '"type": "issue"' readme-example-reinstall.stdout.json
grep -q '"type": "log"' readme-example-reinstall.stdout.json
grep -q '"type": "span"' readme-example-reinstall.stdout.json
grep -q '"type": "action"' readme-example-reinstall.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" readme-example-reinstall.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" readme-example-reinstall.stdout.json >/dev/null
grep -q '"events":6' readme-example-reinstall.stderr.json
grep -q '"ok":true' readme-example-reinstall.stderr.json
php vendor/logbrew/sdk/examples/readme_example.php > vendor-readme-example-reinstall.stdout.json 2> vendor-readme-example-reinstall.stderr.json
grep -q '"type": "release"' vendor-readme-example-reinstall.stdout.json
grep -q '"type": "environment"' vendor-readme-example-reinstall.stdout.json
grep -q '"type": "issue"' vendor-readme-example-reinstall.stdout.json
grep -q '"type": "log"' vendor-readme-example-reinstall.stdout.json
grep -q '"type": "span"' vendor-readme-example-reinstall.stdout.json
grep -q '"type": "action"' vendor-readme-example-reinstall.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" vendor-readme-example-reinstall.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" vendor-readme-example-reinstall.stdout.json >/dev/null
grep -q '"events":6' vendor-readme-example-reinstall.stderr.json
grep -q '"ok":true' vendor-readme-example-reinstall.stderr.json
php vendor/logbrew/sdk/examples/real_user_smoke.php > vendor-example-reinstall.stdout.json 2> vendor-example-reinstall.stderr.json
grep -q '"type": "release"' vendor-example-reinstall.stdout.json
grep -q '"type": "environment"' vendor-example-reinstall.stdout.json
grep -q '"type": "issue"' vendor-example-reinstall.stdout.json
grep -q '"type": "log"' vendor-example-reinstall.stdout.json
grep -q '"type": "span"' vendor-example-reinstall.stdout.json
grep -q '"type": "action"' vendor-example-reinstall.stdout.json
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
grep -qx 'run-http-trace-correlation -> make run-http-trace-correlation' <(sed -n '5p' vendor-example-make-reinstall-help.txt)
grep -qx 'run-worker-lifecycle -> make run-worker-lifecycle' <(sed -n '6p' vendor-example-make-reinstall-help.txt)
grep -qx 'run-persistent-worker-delivery -> make run-persistent-worker-delivery' <(sed -n '7p' vendor-example-make-reinstall-help.txt)
test "$(wc -l < vendor-example-make-reinstall-help.txt | tr -d ' ')" = "7"
(cd vendor/logbrew/sdk/examples && make run-readme-example) > vendor-readme-example-make-reinstall.stdout.json 2> vendor-readme-example-make-reinstall.stderr.json
grep -q '"type": "release"' vendor-readme-example-make-reinstall.stdout.json
grep -q '"type": "environment"' vendor-readme-example-make-reinstall.stdout.json
grep -q '"type": "issue"' vendor-readme-example-make-reinstall.stdout.json
grep -q '"type": "log"' vendor-readme-example-make-reinstall.stdout.json
grep -q '"type": "span"' vendor-readme-example-make-reinstall.stdout.json
grep -q '"type": "action"' vendor-readme-example-make-reinstall.stdout.json
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
grep -q '"type": "release"' vendor-example-make-reinstall.stdout.json
grep -q '"type": "environment"' vendor-example-make-reinstall.stdout.json
grep -q '"type": "issue"' vendor-example-make-reinstall.stdout.json
grep -q '"type": "log"' vendor-example-make-reinstall.stdout.json
grep -q '"type": "span"' vendor-example-make-reinstall.stdout.json
grep -q '"type": "action"' vendor-example-make-reinstall.stdout.json
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

cat > phpstan-consumer.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

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

cat > smoke.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');
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

cat > unauth.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\SdkError;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');
$client->release('evt_release_unauth', '2026-06-02T10:00:00Z', [
    'version' => '1.2.3',
]);

try {
    $client->flush(new RecordingTransport([401]));
    fwrite(STDERR, "expected unauthenticated error\n");
    exit(1);
} catch (SdkError $error) {
    echo json_encode([
        'ok' => true,
        'code' => $error->codeName,
        'message' => $error->getMessage(),
        'pending' => $client->pendingEvents(),
    ], JSON_THROW_ON_ERROR) . PHP_EOL;
}
EOF

php unauth.php > unauth.stdout.json
grep -q '"ok":true' unauth.stdout.json
grep -q '"code":"unauthenticated"' unauth.stdout.json
grep -q '"message":"transport rejected the API key"' unauth.stdout.json
grep -q '"pending":1' unauth.stdout.json

cat > retry.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\TransportError;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');
$client->release('evt_release_retry', '2026-06-02T10:00:00Z', [
    'version' => '1.2.3',
]);

$response = $client->flush(new RecordingTransport([
    TransportError::network('temporary outage'),
    202,
]));

echo json_encode([
    'ok' => true,
    'status' => $response->statusCode,
    'attempts' => $response->attempts,
    'pending' => $client->pendingEvents(),
], JSON_THROW_ON_ERROR) . PHP_EOL;
EOF

php retry.php > retry.stdout.json
grep -q '"ok":true' retry.stdout.json
grep -q '"status":202' retry.stdout.json
grep -q '"attempts":2' retry.stdout.json
grep -q '"pending":0' retry.stdout.json

cat > shutdown.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\SdkError;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');
$client->release('evt_release_shutdown', '2026-06-02T10:00:00Z', [
    'version' => '1.2.3',
]);
$client->shutdown(RecordingTransport::alwaysAccept());

try {
    $client->log('evt_log_shutdown', '2026-06-02T10:00:01Z', [
        'message' => 'should fail',
        'level' => 'info',
    ]);
    fwrite(STDERR, "expected shutdown error\n");
    exit(1);
} catch (SdkError $error) {
    echo json_encode([
        'ok' => true,
        'code' => $error->codeName,
        'message' => $error->getMessage(),
        'pending' => $client->pendingEvents(),
    ], JSON_THROW_ON_ERROR) . PHP_EOL;
}
EOF

php shutdown.php > shutdown.stdout.json
grep -q '"ok":true' shutdown.stdout.json
grep -q '"code":"shutdown_error"' shutdown.stdout.json
grep -q '"message":"client is already shut down"' shutdown.stdout.json
grep -q '"pending":0' shutdown.stdout.json

cat > empty_flush.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');
$response = $client->flush(RecordingTransport::alwaysAccept());

echo json_encode([
    'ok' => true,
    'status' => $response->statusCode,
    'attempts' => $response->attempts,
    'pending' => $client->pendingEvents(),
], JSON_THROW_ON_ERROR) . PHP_EOL;
EOF

php empty_flush.php > empty_flush.stdout.json
grep -q '"ok":true' empty_flush.stdout.json
grep -q '"status":204' empty_flush.stdout.json
grep -q '"attempts":0' empty_flush.stdout.json
grep -q '"pending":0' empty_flush.stdout.json

cat > validation.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\SdkError;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');

try {
    $client->log('evt_log_invalid', '2026-06-02T10:00:03', [
        'message' => 'should fail',
        'level' => 'info',
    ]);
    fwrite(STDERR, "expected validation error\n");
    exit(1);
} catch (SdkError $error) {
    echo json_encode([
        'ok' => true,
        'code' => $error->codeName,
        'message' => $error->getMessage(),
        'pending' => $client->pendingEvents(),
    ], JSON_THROW_ON_ERROR) . PHP_EOL;
}
EOF

php validation.php > validation.stdout.json
grep -q '"ok":true' validation.stdout.json
grep -q '"code":"validation_error"' validation.stdout.json
grep -q '"message":"timestamp must be a valid RFC3339 date-time: 2026-06-02T10:00:03"' validation.stdout.json
grep -q '"pending":0' validation.stdout.json

cat > retry_budget.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\SdkError;
use LogBrew\RecordingTransport;
use LogBrew\TransportError;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');
$client->release('evt_release_retry_budget', '2026-06-02T10:00:00Z', [
    'version' => '1.2.3',
]);

try {
    $client->flush(new RecordingTransport([
        TransportError::network('temporary outage'),
        TransportError::network('temporary outage'),
        TransportError::network('temporary outage'),
    ]));
    fwrite(STDERR, "expected network failure\n");
    exit(1);
} catch (SdkError $error) {
    echo json_encode([
        'ok' => true,
        'code' => $error->codeName,
        'message' => $error->getMessage(),
        'pending' => $client->pendingEvents(),
    ], JSON_THROW_ON_ERROR) . PHP_EOL;
}
EOF

php retry_budget.php > retry_budget.stdout.json
grep -q '"ok":true' retry_budget.stdout.json
grep -q '"code":"network_failure"' retry_budget.stdout.json
grep -q '"message":"temporary outage"' retry_budget.stdout.json
grep -q '"pending":1' retry_budget.stdout.json

cat > transport_status.php <<'EOF'
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;
use LogBrew\SdkError;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'smoke-app', '0.1.0');
$client->release('evt_release_transport_status', '2026-06-02T10:00:00Z', [
    'version' => '1.2.3',
]);

try {
    $client->flush(new RecordingTransport([400]));
    fwrite(STDERR, "expected transport error\n");
    exit(1);
} catch (SdkError $error) {
    echo json_encode([
        'ok' => true,
        'code' => $error->codeName,
        'message' => $error->getMessage(),
        'pending' => $client->pendingEvents(),
    ], JSON_THROW_ON_ERROR) . PHP_EOL;
}
EOF

php transport_status.php > transport-status.stdout.json
grep -q '"ok":true' transport-status.stdout.json
grep -q '"code":"transport_error"' transport-status.stdout.json
grep -q '"message":"unexpected transport status 400"' transport-status.stdout.json
grep -q '"pending":1' transport-status.stdout.json
