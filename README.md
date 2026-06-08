# LogBrew SDKs

LogBrew SDKs help applications send logs, errors, traces, releases, environments, actions, and explicit metrics to LogBrew with small, dependency-light clients.

This repository contains the public SDK packages, framework integrations, event contract, examples, and shared guidance used to keep the developer experience consistent across ecosystems.

## What You Can Capture

- Releases and environments for deployment context.
- Issues and handled errors without raw stack traces by default.
- Logs from direct calls or app-owned logger integrations.
- Spans and W3C `traceparent` context for request tracing.
- Actions for important user or system events.
- Explicit metrics when your application already knows the measurement name, value, unit, kind, and temporality.

## Packages

Install only the package your application needs. The package names below are registry-specific entry points, not a bundle to install together:

- Use the core package for your runtime first, such as `@logbrew/sdk`, `logbrew-sdk`, `LogBrew`, or `co.logbrew:logbrew-sdk`.
- Add framework packages only when your app uses that framework, such as `@logbrew/react`, `@logbrew/express`, `logbrew-fastapi`, or `logbrew-django`.
- Frontend and mobile packages use public `clientKey` setup. Server packages should use server-side keys from app configuration.
- A change to one ecosystem package should not require developers in other ecosystems to update unless their package also changed.

| Ecosystem | Package | Use it for |
| --- | --- | --- |
| JavaScript | [`@logbrew/sdk`](js/logbrew-js) | Core event client, transports, trace helpers, console/Pino/Winston logger adapters |
| Browser | [`@logbrew/browser`](js/logbrew-browser) | Browser page views, handled errors, lifecycle flushing, fetch delivery, target-scoped trace propagation |
| Node.js | [`@logbrew/node`](js/logbrew-node) | Built-in `node:http` request capture and server delivery |
| Express | [`@logbrew/express`](js/logbrew-express) | Express request/error middleware |
| Fastify | [`@logbrew/fastify`](js/logbrew-fastify) | Fastify plugin and request hooks |
| NestJS | [`@logbrew/nestjs`](js/logbrew-nestjs) | NestJS interceptor capture |
| Angular | [`@logbrew/angular`](js/logbrew-angular) | Angular providers, injection helpers, optional error capture |
| Vue | [`@logbrew/vue`](js/logbrew-vue) | Vue plugin/composable capture |
| Svelte | [`@logbrew/svelte`](js/logbrew-svelte) | Svelte context and error helpers |
| React | [`@logbrew/react`](js/logbrew-react) | Provider, hook, error boundary, handled error helpers |
| React Native | [`@logbrew/react-native`](js/logbrew-react-native) | Mobile screen/app-state context and handled errors |
| Next.js | [`@logbrew/next`](js/logbrew-next) | App Router Route Handler capture |
| Python | [`logbrew-sdk`](python/logbrew_py) | Core Python client, HTTP delivery, logging handler |
| FastAPI | [`logbrew-fastapi`](python/logbrew_fastapi) | FastAPI middleware |
| Django | [`logbrew-django`](python/logbrew_django) | Django middleware |
| Go | [`github.com/LogBrewCo/sdk/go/logbrew`](go/logbrew) | Core Go client, HTTP delivery, trace helpers |
| Java | [`co.logbrew:logbrew-sdk`](java/logbrew-java) | Core Java client, HTTP delivery, JUL and Logback support |
| .NET | [`LogBrew`](dotnet/logbrew-dotnet) | Core .NET client, HTTP delivery, `ILogger` provider |
| PHP | [`logbrew/sdk`](php/logbrew-php) | Core PHP client, HTTP delivery, PSR-3 and Monolog/Laravel support |
| Ruby | [`logbrew-sdk`](ruby/logbrew-ruby) | Core Ruby client, HTTP delivery, stdlib `Logger`, Rack/Rails-compatible helpers |
| Rust | [`logbrew`](rust/logbrew) | Core Rust client and optional blocking HTTP delivery |
| Swift | [`logbrew-swift`](swift/logbrew-swift) | SwiftPM client, Apple-style logger ergonomics, URLSession delivery |
| Kotlin | [`co.logbrew:logbrew-kotlin`](kotlin/logbrew-kotlin) | Kotlin/JVM client, Android-style helper APIs, HTTP delivery |
| Unity | [`co.logbrew.unity`](unity/logbrew-unity) | Unity package with runtime helpers and HTTP delivery |
| C | [`logbrew-c`](c/logbrew-c) | C source/header client |
| C++ | [`logbrew-cpp`](cpp/logbrew-cpp) | C++ RAII source/header client with optional HTTP delivery |
| Objective-C | [`logbrew-objc`](objc/logbrew-objc) | Foundation source/header client with optional HTTP delivery |

## Quick Start

JavaScript:

```bash
npm install @logbrew/sdk
```

```js
import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "checkout-api",
  sdkVersion: "1.0.0"
});

client.log("evt_log_001", "2026-06-02T10:00:03Z", {
  message: "worker started",
  level: "info",
  logger: "job-runner"
});

await client.flush(RecordingTransport.alwaysAccept());
```

Python:

```bash
python3 -m pip install logbrew-sdk
```

```python
from logbrew_sdk import LogBrewClient, RecordingTransport

client = LogBrewClient.create("LOGBREW_API_KEY", "checkout-worker", "1.0.0")
client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    "message": "worker started",
    "level": "info",
    "logger": "job-runner",
})
client.flush(RecordingTransport.always_accept())
```

PHP:

```bash
composer require logbrew/sdk
```

```php
<?php

require __DIR__ . '/vendor/autoload.php';

use LogBrew\LogBrewClient;
use LogBrew\RecordingTransport;

$client = LogBrewClient::create('LOGBREW_API_KEY', 'checkout-worker', '1.0.0');
$client->log('evt_log_001', '2026-06-02T10:00:03Z', [
    'message' => 'worker started',
    'level' => 'info',
    'logger' => 'job-runner',
]);
$client->flush(RecordingTransport::alwaysAccept());
```

Each package README has ecosystem-specific install commands, logger integration examples, framework setup, copyable examples, and transport details. If your app does not use a framework integration, skip that package.

## Metrics

Metrics are explicit: the SDKs do not automatically collect runtime, framework, database, or host metrics yet.

Use metric helpers when your application already has a bounded measurement:

- `counter` and `histogram` values use `delta` or `cumulative` temporality and must be non-negative.
- `gauge` values use `instant` temporality and may go up or down.
- Metadata should be primitive and low-cardinality, such as service, region, route template, queue, or worker name.

## Trace Context

SDK trace helpers follow W3C `traceparent` conventions where supported. They validate IDs, reject all-zero trace/span IDs, preserve sampled flags, and avoid global HTTP client patching by default.

Framework integrations that capture inbound requests omit query strings from automatic request/error metadata by default. Frontend and mobile integrations use `clientKey` wording for public keys and only send tracing headers to configured targets.

## Agent-Readable Sessions

LogBrew is designed for structured analysis across many app sessions, not only one-at-a-time inspection. Capture important product steps as `action` events, connect frontend and backend work with `traceparent`, and use shared low-cardinality metadata such as `sessionId`, `routeTemplate`, `funnel`, `step`, `feature`, and `region`.

For browser and mobile apps, prefer explicit action helpers for clicks, form submits, route changes, funnel steps, and retry decisions that your app already understands. Avoid raw selectors, full URLs, user-entered text, screenshots, and visual replay data unless your team has a clear privacy policy and opt-in path.

If you use an AI coding assistant, ask it to wire LogBrew into your app's logger, request lifecycle, and important product actions so agents can analyze timelines made of logs, issues, spans, actions, and metrics. The assistant should keep keys in app configuration and avoid query strings, stack text, and high-cardinality metadata unless your team opts in.

## Privacy Defaults

LogBrew SDKs favor conservative defaults:

- No query strings or URL hashes in automatic request metadata by default.
- No raw stack text unless explicitly enabled.
- No document title or user agent in browser metadata unless explicitly enabled.
- No global logger, console, fetch, or framework behavior changes unless the integration explicitly documents that opt-in behavior.
- App-owned transports, loggers, and framework versions remain under application control.

## Local Payload Preview

Every core SDK supports local JSON preview or recording transports so you can inspect the queued batch before sending anything to LogBrew. This is useful while deciding which logs, spans, issues, releases, actions, environments, or explicit metrics your application should send.

The canonical schema is [`spec/event-batch.schema.json`](spec/event-batch.schema.json). Public fixtures live in [`fixtures/`](fixtures/).

## Maintainer References

- [`docs/sdk-readiness-checklist.md`](docs/sdk-readiness-checklist.md) describes public SDK quality expectations.
- [`docs/github-actions.md`](docs/github-actions.md) describes the repository Actions layout.
- Package READMEs contain ecosystem-specific examples and install commands.
