# @logbrew/express

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Express middleware helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It adds request and error middleware UX while keeping event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`.

## Install

```bash
npm install @logbrew/sdk @logbrew/node @logbrew/express express
pnpm add @logbrew/sdk @logbrew/node @logbrew/express express
```

Set `LOGBREW_SERVER_API_KEY` to a project-scoped server ingest key before starting
the app.

If you are automating setup, follow the same safe path as a person.
Do not ask a person to paste an ingest key.
Do not treat a missing environment variable as a reason to stop setup.
First run `logbrew status --json`. When it reports approved authentication,
create a temporary project and key with the commands below.
Continue without a browser handoff. Confirm authenticated readback, and then
archive the project.
Only stop for account authentication when the status command reports that no
approved authentication is available.

## Create a Project and Confirm Hosted Delivery

Use LogBrew CLI 0.1.32 or newer with approved account authentication to create
the project. This requires no dashboard sign-in. The destination key file must
not already exist. The CLI creates it with owner-only permissions and never
prints the one-time key or its file path.

```bash
logbrew status --json
install -d -m 700 "$HOME/.logbrew"

project_result="$(
  logbrew projects create express-service \
    --runtime node \
    --environment development \
    --ingest-key-file "$HOME/.logbrew/express-service.ingest" \
    --json
)"
export LOGBREW_PROJECT_ID="$(jq -er '.project.id' <<<"$project_result")"
unset project_result
export LOGBREW_SERVER_API_KEY="$(< "$HOME/.logbrew/express-service.ingest")"
```

Start the app after registering the middleware below, then request one safe
route that your app already owns. For example:

```bash
curl --fail http://127.0.0.1:3000/health

logbrew doctor --project "$LOGBREW_PROJECT_ID" --json
logbrew read logs --project "$LOGBREW_PROJECT_ID" \
  --search "GET /health" \
  --since 1h \
  --json
```

A successful ingest response proves submission. The authenticated read proves
that the event is indexed for the same project. If you no longer need the
temporary project, archive it and remove its revoked one-time key file:

```bash
unset LOGBREW_SERVER_API_KEY
logbrew projects archive "$LOGBREW_PROJECT_ID" --yes --json
rm -f "$HOME/.logbrew/express-service.ingest"
unset LOGBREW_PROJECT_ID
```

## Verify It Works

A successful send shows that LogBrew accepted the request. It does not show
that you can read the event. After your app sends one test event, read it
back with a project read key:

```bash
logbrew projects keys create "<project_id>" --kind read \
  --ingest-key-file "$HOME/.logbrew/setup-check.read" --json
export LOGBREW_TOKEN="$(< "$HOME/.logbrew/setup-check.read")"
logbrew read logs --since 1h --json
logbrew issues --since 1h --json
```

A read key reads 1 project and cannot send telemetry. Run `unset LOGBREW_TOKEN`
when you finish. [Verify your setup](https://docs.logbrew.co/guides/verify-setup)
covers key kinds, empty results, and how to revoke the key.

## Request Middleware

```js
import express from "express";
import { logbrewMiddleware } from "@logbrew/express";

const app = express();
const logbrewServerApiKey = process.env.LOGBREW_SERVER_API_KEY;

if (logbrewServerApiKey) {
  app.use(logbrewMiddleware({
    serverApiKey: logbrewServerApiKey,
    onCaptureError(error) {
      console.error("LogBrew request capture failed", error);
    }
  }));
}

app.get("/health", (req, res) => {
  req.logbrew?.client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "health check reached",
    level: "info",
    logger: "express"
  });
  res.json({ ok: true });
});
```

Guard both middleware registrations when local or non-telemetry environments
are intentionally allowed to run without LogBrew configuration. Keep the
guard explicit and app-owned so production configuration validation can still
fail closed when your deployment requires telemetry.

With no `transport` option, the middleware sends to the LogBrew ingest API by default
through `@logbrew/node`. You can pass `endpoint`, `fetchImpl`, or `headers` to
configure that fetch transport, or pass an explicit LogBrew `Transport`.
Delivery failures call `onCaptureError`; they are never converted into a
simulated successful response.

Use `serverApiKey` directly for local server examples, or set `LOGBREW_SERVER_API_KEY` in your server environment and omit it. `apiKey` and `LOGBREW_API_KEY` are still accepted for compatibility with the lower-level JavaScript SDK. Automatic request, metric, and error capture records the matched leaf `req.route.path`; it does not copy `originalUrl`, the concrete router mount value, or the query. Unmatched requests use the explicit `<unmatched>` label.

String routes retain their declared Express pattern, including optional
parameters, groups, and quoted parameter names. The SDK does not parse that
pattern as a URL. Routes declared with an array or regular expression keep the
existing `<unmatched>` label.

`RecordingTransport` remains available from `@logbrew/sdk` when you want to
inspect serialized events locally. It does not send data to LogBrew; use the
default Node fetch transport for production telemetry:

```js
import { RecordingTransport } from "@logbrew/sdk";

const previewTransport = RecordingTransport.alwaysAccept();
app.use(logbrewMiddleware({
  serverApiKey: "local-preview-key",
  transport: previewTransport
}));
```

Every incoming request receives a LogBrew span. A valid W3C `traceparent` continues its trace with a fresh child span; an absent or malformed value starts a fresh local root without breaking the app. The middleware exposes that context through `req.logbrew.trace` and `getActiveLogBrewTrace()` across asynchronous work. Logs, issues, actions, and metrics captured by the default Express client inside the request inherit the same trace unless their event context overrides it. Use `spanIdFactory` and `traceIdFactory` when your runtime needs app-provided IDs:

```js
app.use(logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  spanIdFactory: () => "b7ad6b7169203331"
}));
```

`req.logbrew.trace` contains only normalized W3C IDs and the sampled flag. It does not include request bodies, response bodies, headers, query strings, or the raw `traceparent` value. Use it to correlate app-owned logs, errors, product actions, and downstream milestones with the current request span:

```js
import { getActiveLogBrewTrace } from "@logbrew/express";

app.get("/checkout/:cartId", async (req, res) => {
  const trace = req.logbrew.trace ?? getActiveLogBrewTrace();

  await Promise.resolve();

  const metadata = trace
    ? { routeTemplate: "/checkout/:cartId", traceId: trace.traceId, spanId: trace.spanId }
    : { routeTemplate: "/checkout/:cartId" };

  req.logbrew.client.log("evt_checkout_received", new Date().toISOString(), {
    message: "checkout request accepted",
    level: "info",
    logger: "express",
    metadata
  });

  res.json({ ok: true });
});
```

## Returned Handler Work

Use `withLogBrewExpressHandler()` for request handlers that return a promise.
Register `logbrewMiddleware()` before these handlers and `logbrewErrorHandler()`
after them:

```js
import { withLogBrewExpressHandler } from "@logbrew/express";

app.get("/jobs/:id", withLogBrewExpressHandler(async (req, res) => {
  const job = await loadJob(req.params.id);
  res.json({ status: job.status });
  await recordJobRead(job);
  req.logbrew.client.log("evt_job_read", new Date().toISOString(), {
    message: "job read recorded",
    level: "info"
  });
}));
```

`loadJob()` and `recordJobRead()` are app-owned functions. The middleware flushes
request telemetry when the response finishes or aborts. If a wrapped handler is
still pending, it keeps the same request client open. After all wrapped handlers
settle, it sends their pending events and shuts down the client. Request trace
context also remains available during that work.

The wrapper forwards a promise rejection to `next(error)` once on Express 4 and
5. Synchronous return values, receiver binding, and thrown errors keep their
normal behavior. Return or await the work that needs the request client; the
wrapper does not track work detached from the returned promise. Disabling both
automatic request and metric capture keeps successful requests under manual
delivery. Registering the wrapper does not change unwrapped handlers.

## Request Metrics

Request metrics are opt-in. Enable `captureRequestMetrics` when you want the middleware to send an explicit `http.server.duration` histogram for each completed request:

```js
app.use(logbrewMiddleware({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  captureRequestMetrics: true
}));
```

The metric carries the stable description `Duration of one completed server request.` plus primitive, low-cardinality metadata: `framework`, `method`, `routeTemplate`, `statusCode`, and `statusCodeClass`. Query strings and hashes are omitted. Prefer Express route templates such as `/checkout/:id` over raw URLs, and avoid user IDs, request payloads, headers, or free-form text in custom metric metadata. Use `metricName`, `metricIdFactory`, or `requestMetricEvent` when your app needs a different naming, description, or metadata policy.

## Error Middleware

```js
import { logbrewErrorHandler } from "@logbrew/express";

const logbrewServerApiKey = process.env.LOGBREW_SERVER_API_KEY;

if (logbrewServerApiKey) {
  app.use(logbrewErrorHandler({
    serverApiKey: logbrewServerApiKey,
    onCaptureError(error) {
      console.error("LogBrew error capture failed", error);
    }
  }));
}

app.use((err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: err.message });
});
```

Express error-handling middleware uses four arguments: `(err, req, res, next)`. In Express 5, route handlers and middleware that return rejected promises are forwarded to error handlers automatically, so `logbrewErrorHandler()` is designed to capture and then pass the error onward to your existing response handler. The default issue includes an unhandled `express.middleware` mechanism, a bounded parent-first `Error.cause`/`AggregateError` chain, sanitized structured frames, and one request breadcrumb. Exception-chain messages are redacted; the reported error message remains captured telemetry, so keep sensitive and user-entered text out of exception messages. Raw stack text remains absent unless you explicitly set `includeErrorStack: true`.

When the failing request passed through `logbrewMiddleware()`, the issue stays on that request client until the response finishes, so the issue, final 500 request event, and optional duration metric are sent together before one shutdown. An aborted response uses its close lifecycle as a flush fallback. When the request has a valid `traceparent`, the default error event includes normalized trace correlation without echoing the raw propagation header. Matched route templates keep dynamic IDs and query values out of default issue titles, span names, metrics, and breadcrumbs.

## Request User

Call `req.logbrew.setUser()` once you know who made the request, for example in your authentication middleware. Every later event of that request, including the request span and any error issue, carries `context.subject`:

```js
app.use((req, _res, next) => {
  if (req.account) {
    req.logbrew.setUser(req.account.publicId); // an opaque app-owned ID, not an email address or name
  }
  next();
});
```

The ID stays with its own request, so it never reaches another request's events. Pass `{ kind: "anonymous" }` for visitors who have not signed in. IDs are 1 to 200 characters without control characters. LogBrew stores only the ID and kind; it never collects email addresses, names, or IP addresses for you.

## Example Source

The package includes example source for request middleware, error middleware, and app-owned response handling. The packaged examples use an explicit `RecordingTransport` so they can run offline and print serialized event batches without sending them. Use the default network-delivery snippets above as the starting point for wiring LogBrew into your Express application.

The `handler-wrapper` example sends a response, waits for its request event to
flush, and then records a log from the handler's remaining work:

```bash
bun node_modules/@logbrew/express/examples/index.mjs handler-wrapper
```
