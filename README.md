# LogBrew SDKs

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

LogBrew SDKs help applications send logs, errors, traces, releases, environments, actions, and explicit metrics to LogBrew with small, dependency-light clients.

This repository contains the public SDK packages, framework integrations, event contract, examples, and shared guidance used to keep the developer experience consistent across ecosystems.

## What You Can Capture

- Releases and environments for deployment context.
- Issues and handled errors with a bounded parent-first exception graph, typed mechanism and handled state, explicit message/stack evidence states, structured frames, breadcrumbs, and optional [application-reported diagnostic evidence](#diagnostic-evidence) without raw stack text by default.
- Logs from direct calls or app-owned logger integrations.
- Spans and W3C `traceparent` context for request tracing.
- Actions for important user or system events.
- Explicit metrics when your application already knows the measurement name, stable purpose, value, unit, kind, and temporality.
- A shared, versioned context for privacy-bounded resource, deployment, trace, session, opaque subject, and low-cardinality tag correlation across every signal.

User-facing severity categories are `info`, `warning`, `error`, and `critical`. SDKs keep accepting common runtime aliases where they are idiomatic, such as `trace`, `debug`, `warn`, and `fatal`, but queued payloads normalize those aliases to the canonical categories before they are sent:

| Runtime alias | Sent as |
| --- | --- |
| `trace`, `debug`, `info` | `info` |
| `warn`, `warning` | `warning` |
| `error` | `error` |
| `fatal`, `critical` | `critical` |

Use `info` for normal progress and details useful in an investigation, `warning` for recoverable or degraded behavior, `error` for failed work and handled exceptions, and `critical` for fatal, outage-level, data-loss, or user-blocking failures.

## Packages

Install only the package your application needs. The package names below are registry-specific entry points, not a bundle to install together:

- Use the core package for your runtime first, such as `@logbrew/sdk`, `logbrew-sdk`, `LogBrew`, or `co.logbrew:logbrew-sdk`.
- Add framework packages only when your app uses that framework, such as `@logbrew/react`, `@logbrew/express`, `logbrew-fastapi`, `logbrew-flask`, or `logbrew-django`.
- Frontend and mobile packages use public `clientKey` setup. Server packages should use server-side keys from app configuration.
- A change to one ecosystem package should not require developers in other ecosystems to update unless their package also changed.
- For Apple apps, start with the Swift package. Use Objective-C only for Objective-C or mixed codebases.

Node queue integrations are published as separate npm packages. For BullMQ,
KafkaJS, RabbitMQ/amqplib, and Amazon SQS, install the matching `@logbrew/*`
integration alongside `@logbrew/sdk`, `@logbrew/node`, and the broker or client
library your app already uses.

Node framework adapters also require the Node delivery package. Use the exact
stack for the framework your app already owns:

```bash
npm install @logbrew/sdk @logbrew/node @logbrew/express express
npm install @logbrew/sdk @logbrew/node @logbrew/fastify fastify
npm install @logbrew/sdk @logbrew/node @logbrew/nestjs @nestjs/common @nestjs/core @nestjs/platform-express reflect-metadata rxjs
npm install @logbrew/sdk @logbrew/node @logbrew/next next react react-dom
```

| Ecosystem | Package | Use it for |
| --- | --- | --- |
| JavaScript | [`@logbrew/sdk`](js/logbrew-js) | Core event client, transports, trace helpers, console/Pino/Winston logger adapters |
| Browser | [`@logbrew/browser`](js/logbrew-browser) | Browser page views, handled errors, lifecycle flushing, fetch delivery, target-scoped trace propagation |
| Node.js | [`@logbrew/node`](js/logbrew-node) | Built-in `node:http` request capture, server delivery, and reversible existing-Pino instrumentation |
| BullMQ | [`@logbrew/bullmq`](js/logbrew-bullmq) | Explicit BullMQ producer/worker trace correlation |
| KafkaJS | [`@logbrew/kafkajs`](js/logbrew-kafkajs) | Explicit KafkaJS producer/consumer trace correlation |
| RabbitMQ / amqplib | [`@logbrew/amqplib`](js/logbrew-amqplib) | Explicit RabbitMQ publish/consume trace correlation |
| Amazon SQS | [`@logbrew/aws-sqs`](js/logbrew-aws-sqs) | Explicit SQS send/receive/process trace correlation |
| Express | [`@logbrew/express`](js/logbrew-express) | Express request/error middleware |
| Fastify | [`@logbrew/fastify`](js/logbrew-fastify) | Fastify request/error hooks and opt-in existing application-log capture |
| NestJS | [`@logbrew/nestjs`](js/logbrew-nestjs) | NestJS interceptor capture |
| Angular | [`@logbrew/angular`](js/logbrew-angular) | Angular providers, injection helpers, optional error capture |
| Vue | [`@logbrew/vue`](js/logbrew-vue) | Vue plugin/composable capture |
| Svelte | [`@logbrew/svelte`](js/logbrew-svelte) | Svelte context and error helpers |
| React | [`@logbrew/react`](js/logbrew-react) | Provider, hook, error boundary, handled error helpers |
| React Native | [`@logbrew/react-native`](js/logbrew-react-native) | Hosted fetch delivery, app-private offline/restart queueing, mobile context, handled errors, and app-owned Promise rejection reports |
| Next.js | [`@logbrew/next`](js/logbrew-next) | App Router request-error instrumentation, Route Handler capture, and release artifacts |
| Python | [`logbrew-sdk`](python/logbrew_py) | Core client, delivery, logging, shared telemetry context, and typed exception/stack/breadcrumb diagnostics |
| Python / Celery | [`logbrew-sdk[celery]`](python/logbrew_py#automatic-celery-spans) | App-scoped producer/worker spans and typed privacy-bounded unexpected-failure issues |
| Python / RQ | [`logbrew-sdk[rq]`](python/logbrew_py#automatic-rq-spans) | Instance-scoped producer/worker correlation, linked application logs, and final-failure issues |
| Python / Dramatiq | [`logbrew-sdk[dramatiq]`](python/logbrew_py#automatic-dramatiq-spans) | Broker-scoped producer/worker correlation, retry chains, linked logs, and terminal-failure issues |
| Python / ARQ | [`logbrew-sdk[arq]`](python/logbrew_py#automatic-arq-spans) | Async producer/worker correlation, linked application logs, retries, and terminal-failure issues |
| FastAPI | [`logbrew-fastapi`](python/logbrew_fastapi) | Request spans plus typed unhandled-exception diagnostics |
| Flask | [`logbrew-flask`](python/logbrew_flask) | Request spans plus typed unhandled-exception diagnostics |
| Django | [`logbrew-django`](python/logbrew_django) | Request spans plus typed unhandled-exception diagnostics |
| Go | [`github.com/LogBrewCo/sdk/go/logbrew`](go/logbrew) | Core client, shared runtime/resource/session/subject context, delivery, tracing, and typed exception/stack/breadcrumb diagnostics |
| Go / Asynq | [`github.com/LogBrewCo/sdk/go/logbrew/asynq`](go/logbrew/asynq) | Producer-to-worker trace propagation, enqueue/process spans, and correlated job issues |
| Go / Gin | [`github.com/LogBrewCo/sdk/go/logbrew/gin`](go/logbrew/gin) | Gin request spans, typed panic diagnostics, and optional request metrics |
| Java | [`co.logbrew:logbrew-sdk`](java/logbrew-java) | Core client, shared runtime/resource/session/subject context, typed issue diagnostics, servlet/Spring correlation, HTTP delivery, JUL, and Logback support |
| .NET | [`LogBrew`](dotnet/logbrew-dotnet) | Core .NET client, typed exception/stack/breadcrumb diagnostics, HTTP delivery, and `ILogger` provider |
| ASP.NET Core | [`LogBrew.AspNetCore`](dotnet/logbrew-dotnet/src/LogBrew.AspNetCore) | Optional request telemetry and typed unhandled-exception capture middleware |
| Entity Framework Core | [`LogBrew.EntityFrameworkCore`](dotnet/logbrew-dotnet/src/LogBrew.EntityFrameworkCore) | Optional EF Core command span interceptor |
| StackExchange.Redis | [`LogBrew.StackExchangeRedis`](dotnet/logbrew-dotnet/src/LogBrew.StackExchangeRedis) | Optional Redis command spans without key/value capture |
| PHP | [`logbrew/sdk`](php/logbrew-php) | Core PHP client, typed exception/stack/breadcrumb diagnostics, HTTP delivery, PSR-3/Monolog, Symfony request and Messenger correlation, and Laravel logging with queue-job tracing |
| Ruby / Rails | [`logbrew-sdk`](ruby/logbrew-ruby) | Shared context, typed exception evidence, automatic request/error/ActiveJob/outbound HTTP correlation and delivery, stdlib `Logger`, and manual Rack helpers |
| Rust | [`logbrew`](rust/logbrew) | Shared runtime/resource/trace/session/subject context, typed diagnostics, HTTP/Tower correlation, `tracing` Logs/Spans and opt-in Issues, OpenTelemetry export, and delivery |
| Apple apps | [`logbrew-swift`](swift/logbrew-swift) primary; [`logbrew-objc`](objc/logbrew-objc) advanced variant (SwiftPM `LogBrewObjC` product or source) | SwiftPM `LogBrew` product with automatic and task-local typed context, handled-error/frame/breadcrumb diagnostics, app-owned background-operation and URLSession tracing, span milestones/links, Apple-style logging, delivery, and opt-in bounded native crash replay; Objective-C vendoring with schema-v1 shared context, structured NSError evidence, breadcrumbs, and span evidence for mixed or Objective-C-only apps |
| Kotlin | [`co.logbrew:logbrew-kotlin`](kotlin/logbrew-kotlin) | Kotlin/JVM client with shared runtime/resource/session/subject context, structured issue diagnostics, Android helpers, tracing, and HTTP delivery |
| Kotlin OkHttp | [`co.logbrew:logbrew-kotlin-okhttp`](kotlin/logbrew-kotlin-okhttp) | Optional OkHttp request tracing, phase timings, and W3C trace propagation |
| Unity | [`co.logbrew.unity`](unity/logbrew-unity) | Unity package with runtime helpers and HTTP delivery |
| C | [`logbrew-c`](c/logbrew-c) | C source/header client |
| C++ | [`logbrew-cpp`](cpp/logbrew-cpp) | C++17 RAII source/header client with typed context, rich issue/span evidence, and optional HTTP delivery |

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
  sdkVersion: "1.0.0",
  context: {
    schemaVersion: 1,
    resource: {
      service: { name: "checkout-api" },
      deployment: { environment: "production", release: "checkout@1.0.0" }
    }
  }
});

client.log("evt_log_001", "2026-06-02T10:00:03Z", {
  message: "worker started",
  level: "info",
  logger: "job-runner"
});

await client.flush(RecordingTransport.alwaysAccept());
```

The JavaScript core and framework clients merge this bounded context into every event. Session and subject identifiers are explicit, app-owned, and opaque; LogBrew does not automatically collect profile fields or personal data. See the [`@logbrew/sdk` shared telemetry context guide](js/logbrew-js#shared-telemetry-context) for the complete shape and privacy rules.

`RecordingTransport` is local-only: its synthetic HTTP `202` makes no network
request and does not indicate hosted delivery or event visibility. Use the
released runtime package's HTTP transport and then read the event through the
authenticated CLI or API for end-to-end confirmation.
A project read key does that read without account sign-in, for example from
CI or a coding agent. See
[Read your events back](https://docs.logbrew.co/guides/verify-setup).

Python:

```bash
python3 -m pip install logbrew-sdk
```

Framework applications should use the released adapter so request lifecycle,
trace context, and exception capture are installed once: `logbrew-flask` for
Flask, `logbrew-fastapi` for FastAPI, or `logbrew-django` for Django. Each
adapter installs a compatible core dependency; do not reconstruct framework
middleware from the core example.

```python
from logbrew_sdk import LogBrewClient, RecordingTransport

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    context={
        "schemaVersion": 1,
        "resource": {
            "service": {"name": "checkout-worker"},
            "deployment": {
                "environment": "production",
                "release": "checkout@1.0.0",
            },
        },
    },
)
client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    "message": "worker started",
    "level": "info",
    "logger": "job-runner",
})
client.flush(RecordingTransport.always_accept())
```

The Python core and framework clients merge this bounded context into every
event. The core client also adds conservative Python runtime, operating-system,
and architecture context by default, with an explicit opt-out. Session and
subject identifiers remain explicit, app-owned, and opaque. See the
[`logbrew-sdk` shared telemetry context guide](python/logbrew_py#shared-telemetry-context)
for the complete shape and privacy rules.

Python DB-API spans are explicit and app-owned. Trace the connect callable your
app already controls, then keep using normal cursor methods:

```python
import sqlite3

from logbrew_sdk import connect_dbapi_connection_with_logbrew_spans

connection = connect_dbapi_connection_with_logbrew_spans(
    sqlite3.connect,
    connect_args=("checkout.db",),
    client=client,
    system="sqlite",
    db_name="checkout",
    trace_fetch_methods=True,  # opt in only when fetch timing is worth the extra spans
)

cursor = connection.execute(
    "SELECT id, status FROM checkout_order WHERE id = ?",
    (order_id,),
)
rows = cursor.fetchall()
connection.commit()
```

The wrapper records operation labels such as `SELECT`, `FETCHALL`, and `COMMIT`,
duration, row counts when the driver exposes them, trace/span correlation, and
type-only failures. It does not capture SQL values, bind parameters, result
rows, connection strings, baggage, tracestate, stacks, or exception messages.

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

Automatic issue helpers preserve native cause, context, aggregate, and
suppressed relationships when their runtime exposes them. The root remains
compatible with the existing `exception` and `stackFrames` fields; every
missing, redacted, or truncated message/stack state is explicit and no SDK
invents historical evidence. See [Exception Chains](#exception-chains).

## Exception Chains

The reported exception is often only a wrapper. The failure that matters can be
an earlier cause, a context exception, one member of an aggregate, or a
suppressed exception, so issue events can carry a bounded `exceptionChain`
next to the `exception` and `stackFrames` fields.

- `exceptionChain.entries` is a parent-first array of 1 to 8 entries. Entry
  IDs are their array indexes. Entry `0` is the `reported` exception and has
  no parent. Every later entry names an earlier `parentId` and a relation:
  `cause`, `context`, `aggregate_member`, or `suppressed`.
- The reported entry repeats the `exception` type and mechanism and the
  `stackFrames`, and must match them exactly.
- `truncated: true` means a depth, width, cycle, unreadable runtime link, or
  SDK limit cut the graph short.
- `messageState` is `captured`, `truncated`, `redacted`, or `not_captured`. A
  message is present only when it is `captured` or `truncated`.
- `stackFramesState` is `captured`, `truncated`, or `not_captured`. Frames are
  present only when they are `captured` or `truncated`, at most 32 per entry.

SDKs reject a contradictory root, a forward parent reference, gaps, and
oversized graphs before the event is queued. They never invent a cause,
message, or frame. Automatic helpers mark messages `redacted` and leave the
text out; a `captured` message is text your application approved for
telemetry. Frames keep bounded code identity and never contain source lines,
local variables, arguments, or raw stack text.

Automatic helpers follow each runtime's own relationships: JavaScript `cause`
and `AggregateError`, Python causes, context, and exception groups, JVM causes
and suppressed exceptions, .NET inner and aggregate exceptions, Go `Unwrap`,
Rust `Error::source`, PHP previous exceptions, Ruby causes, Swift and
Objective-C underlying `NSError` values, and Unity inner and aggregate
exceptions. C and C++ have no common cause API, so their issue types accept the
same chain built by hand and send the same shape. Framework packages reuse
their core helper and send the same chain.

## Diagnostic Evidence

An issue can include an optional `attributes.evidence` object when your
application already knows something runtime inspection cannot find. The SDK
never derives these values from an exception message.

- `likelyRootCause` is up to 1,024 characters. LogBrew shows it as a reported
  hypothesis, not a confirmed cause.
- `likelyFixArea` has at least one of `component`, `module`, `function`,
  repository-relative `file`, positive `line`, or positive `column`. Optional
  `inApp` cannot be the only field. Paths are up to 256 characters and cannot
  be absolute or contain `..`, a URL scheme, a query, or a fragment.
- `impact` has at least one of `affectedUserSegment`, `failedAction`, or
  `userVisibleOutcome`. Segment and action are short, low-cardinality names.
  The outcome is display text up to 512 characters. None of them identify a
  user.
- `capturedFields`, `missingFields`, `redactedFields`, and `truncatedFields`
  each hold 1 to 32 unique field names of up to 64 letters, digits, dots,
  underscores, and hyphens. A name can appear under only one state.

Unknown keys, empty objects, contradictory states, unsafe paths, control
characters, and values outside these limits fail validation before the event
is queued. Add evidence only when your application logic or a reviewed rule
knows it. Never include authorization values, request or response
bodies, personal data, raw user input, full URLs, headers, query strings, local
absolute paths, or raw stack text.

## Metrics

Metrics are explicit: core SDKs do not automatically collect runtime, framework, database, or host metrics. Opt-in framework request helpers may emit a bounded request-duration metric. Their purpose is to aggregate behavior over time (rates, latency distributions, saturation, and release-to-release change), while logs/actions describe discrete facts and traces explain individual executions.

Use metric helpers when your application already has a bounded measurement:

- `counter` and `histogram` values use `delta` or `cumulative` temporality and must be non-negative.
- `gauge` values use `instant` temporality and may go up or down.
- Add an optional stable description that explains what the measurement means. SDKs trim it, limit it to 1024 Unicode scalar values, and reject unsafe control characters. Do not put identifiers, personal data, request values, or other changing content in it.
- Metadata should be primitive and low-cardinality, such as region, route template, operation, status class, queue, or worker name. Keep service and deployment identity in typed context.
- Do not use event, trace, session, user, raw URL, or other high-cardinality values as metric dimensions. Typed context may still link one metric event to an investigation without making those values aggregation keys.

## Product Analytics Capture

Product analytics reuses explicit action events and existing page-view telemetry. Product-action helpers across the supported SDK families attach a reserved versioned `interaction` classification; browser page-view helpers attach `page_view`, and React Native plus Kotlin/Android screen helpers attach `screen_view`. These annotations do not install automatic click capture or collect user-entered values. Use explicit opaque subject and session IDs in the shared telemetry context when user- or session-level analysis is required.

Classified events carry these reserved metadata fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `analyticsSchemaVersion` | integer | The schema version. `1` is the only current value. |
| `analyticsKind` | string | `page_view`, `screen_view`, or `interaction`. |
| `analyticsSurface` | string | Optional route template or screen name. |

`analyticsSurface` is trimmed and left out when it is empty, longer than 256
characters, or contains control characters. Browser surfaces never include
query strings or hash fragments. Use route templates such as `/orders/:id`
rather than concrete paths such as `/orders/8472`. The helpers write these
fields after your metadata, so your metadata cannot change them.

The browser SDK also tags each tab session with its first page's `utm_source`,
`utm_medium`, and `utm_campaign` and the referring site's host name
(`referrer_domain`), so analytics can compare acquisition sources. It reads no
other part of the URL or the referrer; set `captureAttribution: false` to turn
it off.

Network milestones, app lifecycle events, logs, issues, and ordinary spans are
not product interactions and carry no classification. Events without these
fields stay valid. Never use email addresses, names, phone numbers, IP
addresses, authorization values, cookies, user-entered text, DOM selectors,
full URLs, or query strings as identifiers, surfaces, action names, or
metadata. Readers ignore an unknown `analyticsKind` or schema version. The
JavaScript constants `PRODUCT_ANALYTICS_SCHEMA_VERSION` and
`PRODUCT_ANALYTICS_KINDS` list the values the installed package supports.

## Trace Context

SDK trace helpers follow W3C `traceparent` conventions where supported. They validate IDs, reject all-zero trace/span IDs, preserve sampled flags, and avoid global HTTP client patching by default.

Framework integrations that capture inbound requests omit query strings from automatic request/error metadata by default. Frontend and mobile integrations use `clientKey` wording for public keys and only send tracing headers to configured targets.

## Agent-Readable Sessions

LogBrew is designed for structured analysis across many app sessions, not only one-at-a-time inspection. Capture important product steps as `action` events, connect frontend and backend work with `traceparent`, keep session/subject identity in the versioned typed context, and use low-cardinality dimensions such as `routeTemplate`, `funnel`, `step`, `feature`, and `region`.

For browser and mobile apps, prefer explicit action helpers for clicks, form submits, route changes, funnel steps, and retry decisions that your app already understands. Avoid raw selectors, full URLs, user-entered text, screenshots, and visual replay data unless your team has a clear privacy policy and opt-in path.

If you use an AI coding assistant, ask it to wire LogBrew into your app's logger, request lifecycle, and important product actions so agents can analyze timelines made of logs, issues, spans, actions, and metrics. The assistant should keep keys in app configuration and avoid query strings, stack text, and high-cardinality metadata unless your team opts in.

## Privacy Defaults

LogBrew SDKs favor conservative defaults:

- No query strings or URL hashes in automatic request metadata by default.
- No raw stack text unless explicitly enabled.
- The Node delivery client adds only Node version, OS type/release, and
  architecture as automatic shared context. It supports an explicit opt-out
  and does not infer host, user, service, application, or cloud identity.
- The Python client adds only Python implementation/version, OS name/release,
  and architecture as automatic shared context. It supports an explicit
  opt-out and does not infer user, service, application, session, or cloud
  identity.
- The Rust client adds only Rust runtime name, target OS family, and
  architecture as automatic shared context. It supports an explicit opt-out
  and does not probe hostnames, process details, environment variables, local
  accounts or paths, network/cloud identity, CPU details, or memory details.
- The Objective-C source client adds only its runtime name, Apple operating-system
  name/version, architecture, and populated application bundle name/version/build.
  It supports an explicit opt-out and does not infer account, host, network,
  unique-device, session, subject, or tag identity.
- The browser client adds only low-entropy browser brand/significant version,
  platform, and mobile/desktop family when User-Agent Client Hints expose them;
  otherwise it reports the generic browser runtime. It never reads the legacy
  user-agent string or requests high-entropy hints, and supports an explicit
  opt-out.
- Automatic Pino metadata excludes credentials, cookies, bodies, payloads, query text, raw URLs, propagation headers, local file paths, and stack text by default.
- No document title or user agent in browser metadata unless explicitly enabled.
- No global logger, console, fetch, or framework behavior changes unless the integration explicitly documents that opt-in behavior.
- App-owned transports, loggers, and framework versions remain under application control.

## Local Payload Preview

Every core SDK supports local JSON preview or recording transports so you can inspect the queued batch before sending anything to LogBrew. This is useful while deciding which logs, spans, issues, releases, actions, environments, or explicit metrics your application should send.

The canonical schema is [`spec/event-batch.schema.json`](spec/event-batch.schema.json). Public fixtures live in [`fixtures/`](fixtures/).
