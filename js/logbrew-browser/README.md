# @logbrew/browser

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Browser helpers for the public LogBrew JavaScript SDK.

This package captures page views, synchronous browser errors, unhandled Promise rejections, product actions, and app-owned network milestones while keeping validation, buffering, retry, flush, and shutdown behavior in `@logbrew/sdk`.

## Install

```bash
npm install @logbrew/sdk @logbrew/browser
pnpm add @logbrew/sdk @logbrew/browser
```

## Browser Setup

```js
import { installLogBrewBrowser } from "@logbrew/browser";

const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY"
});

logbrew.client.log("evt_log_001", new Date().toISOString(), {
  message: "browser app started",
  level: "info",
  logger: "browser"
});
```

`installLogBrewBrowser()` attaches `error` and `unhandledrejection` listeners with `addEventListener()`, captures an initial page-view span, creates one W3C trace context for the browser session, flushes queued events when the page becomes hidden, receives `pagehide`, or comes back `online`, and returns a handle with `client`, `traceContext`, `flush()`, `shutdown()`, `previewJson()`, and `uninstall()`.

Route changes in single-page apps are explicit. Use `installLogBrewBrowserNavigationInstrumentation()` when your app wants LogBrew to observe `history.pushState`, `history.replaceState`, and `popstate`, create a fresh route trace context, and capture a page-view span for each path change. It is not installed by default.

`onFlush(response, context, details)` and `onCaptureError(error, context, details)` receive `details.reason` as `capture`, `online`, `pagehide`, or `visibility_hidden`, so apps can distinguish normal capture flushes from lifecycle and connectivity delivery without parsing browser events globally.

For browser apps, prefer a browser-scoped public key through `clientKey`. `apiKey` is still accepted for compatibility with lower-level SDK examples.

By default, browser metadata keeps the current path without query string or hash. It does not include document title or user agent unless `includeDocumentTitle` or `includeUserAgent` is enabled. Pass `sanitizeMetadata(metadata, kind)` to remove or rewrite metadata before events are queued.

Set `flushOnOnline: false`, `flushOnPageHide: false`, or `flushOnVisibilityHidden: false` if your app wants to own lifecycle or connectivity delivery itself.

## Structured Actions

Use `captureBrowserAction()` for the product steps your app already understands, such as clicks, form submits, route changes, retry decisions, or funnel steps. Use `captureBrowserNetwork()` for important API milestones that should be correlated with the same session or trace. These action events give LogBrew and AI agents a session timeline that can be analyzed across many users without requiring a person to watch individual recordings.

```js
import {
  captureBrowserAction,
  captureBrowserNetwork,
  installLogBrewBrowser
} from "@logbrew/browser";

const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY"
});

await captureBrowserAction({
  name: "checkout.clicked",
  status: "success",
  metadata: {
    funnel: "checkout",
    routeTemplate: "/checkout",
    sessionId: "sess_123",
    step: 2
  }
}, logbrew);

await captureBrowserNetwork({
  method: "POST",
  routeTemplate: "/api/checkout",
  statusCode: 503,
  durationMs: 842,
  sessionId: "sess_123",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  metadata: {
    funnel: "checkout",
    retryAttempt: 1
  }
}, logbrew);
```

Action and network metadata is sanitized to primitive values. Keep it low-cardinality and avoid raw selectors, full URLs, query strings, headers, request or response bodies, user-entered text, screenshots, or replay payloads unless your application owns a clear opt-in and redaction policy. `captureBrowserNetwork()` records route templates, methods, status codes, durations, trace IDs, session IDs, and your own primitive metadata; it does not patch `fetch` or inspect network payloads automatically.

## Resource Timing Spans

Use `captureBrowserResourceTiming()` when your app wants browser `PerformanceResourceTiming` entries to appear as trace spans under the current page or route trace. Pass `resourcePathTemplate` for high-cardinality routes so resource spans group by a stable path instead of a specific ID.

```js
import {
  captureBrowserResourceTiming,
  installLogBrewBrowser
} from "@logbrew/browser";

const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY"
});

for (const entry of performance.getEntriesByType("resource")) {
  if (entry.name.includes("/api/checkout/")) {
    await captureBrowserResourceTiming(entry, logbrew, {
      resourcePathTemplate: "/api/checkout/:id"
    });
  }
}
```

For app-owned automatic capture, opt in with `installLogBrewBrowserResourceTimingInstrumentation()` after setup. It uses `PerformanceObserver` for `resource` entries, can be removed with `uninstall()`, and is not enabled by default.

```js
import {
  installLogBrewBrowser,
  installLogBrewBrowserResourceTimingInstrumentation
} from "@logbrew/browser";

const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY"
});

const resources = installLogBrewBrowserResourceTimingInstrumentation(logbrew, {
  resourcePathTemplate({ path }) {
    return path.replace(/\/\d+$/u, "/:id");
  }
});

// Later, if your app owns teardown.
resources.uninstall();
```

Resource timing spans keep the active trace ID, create a child span ID, record duration, status code when the browser exposes it, initiator type, size fields, and bounded phase timings such as lookup, connect, TLS, request, and response time. They store only path/template metadata; full URLs, hosts, query strings, hash fragments, headers, request or response bodies, cookies, baggage, and tracestate are not captured.

## Fetch Spans

Use `createLogBrewBrowserFetch()` when browser API calls should become trace spans and optionally propagate W3C `traceparent` to your own backend. This wraps an app-owned `fetch` function and is separate from the lower-level `createTraceparentFetch()` header helper.

```js
import {
  createLogBrewBrowserFetch,
  installLogBrewBrowser
} from "@logbrew/browser";

const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY"
});

const logbrewFetch = createLogBrewBrowserFetch(logbrew, {
  resourcePathTemplate({ path }) {
    return path.replace(/\/\d+$/u, "/:id");
  },
  tracePropagationTargets: [/^\/api\//]
});

await logbrewFetch("/api/orders/123", {
  method: "POST",
  body: JSON.stringify({ cartId: "cart_123" })
});
```

`createLogBrewBrowserFetch()` creates a child span under the active page or route trace, injects exactly one normalized `traceparent` only when `tracePropagationTargets` matches, measures duration, records method, path/template, status code, response content length when exposed, and error type for network failures, then rethrows the original fetch error. It never captures request or response bodies, arbitrary headers, full URLs, hosts, query strings, hash fragments, cookies, error messages, baggage, or tracestate.

If your app intentionally wants a global browser fetch patch, opt in with `installLogBrewBrowserFetchInstrumentation()` and keep the returned teardown handle.

```js
const fetchInstrumentation = installLogBrewBrowserFetchInstrumentation(logbrew, {
  resourcePathTemplate: "/api/orders/:id",
  tracePropagationTargets: [/^\/api\/orders\//]
});

// Later, if your app owns teardown.
fetchInstrumentation.uninstall();
```

Fetch instrumentation is not installed by default. If your XHR calls already go through an app-owned wrapper, use `captureBrowserXhrSpan()` or `captureBrowserResourceTiming()` instead of prototype instrumentation.

## XHR Spans

Use `installLogBrewBrowserXhrInstrumentation()` only when your app intentionally wants LogBrew to observe browser `XMLHttpRequest` calls. It patches `XMLHttpRequest.prototype.open/send` after explicit install and returns a teardown handle.

```js
import {
  installLogBrewBrowser,
  installLogBrewBrowserXhrInstrumentation
} from "@logbrew/browser";

const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY"
});

const xhrInstrumentation = installLogBrewBrowserXhrInstrumentation(logbrew, {
  resourcePathTemplate({ path }) {
    return path.replace(/\/\d+$/u, "/:id");
  },
  tracePropagationTargets: [/^\/api\//]
});

// Later, if your app owns teardown.
xhrInstrumentation.uninstall();
```

XHR instrumentation creates a child span under the active page or route trace, injects exactly one normalized `traceparent` only when `tracePropagationTargets` matches, measures duration, records method, path/template, status code, response content length when exposed, and event type for network failures such as `error`, `abort`, or `timeout`. It never captures request or response bodies, arbitrary headers, full URLs, hosts, query strings, hash fragments, cookies, error messages, baggage, or tracestate.

If your app already has its own XHR wrapper, use `captureBrowserXhrSpan()` or `createBrowserXhrSpanEvent()` with your sanitized request summary instead of installing prototype instrumentation.

## Fetch Transport

```js
import { createFetchTransport, installLogBrewBrowser } from "@logbrew/browser";

installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  transport: createFetchTransport({
    endpoint: "https://api.logbrew.com/v1/events",
    maxKeepaliveBodyBytes: 64 * 1024
  })
});
```

`createFetchTransport()` uses browser `fetch` with `keepalive: true` by default so explicit page-lifecycle flushes can finish during navigation. To keep that behavior predictable, LogBrew refuses keepalive payloads above `maxKeepaliveBodyBytes` before calling `fetch`; the queued events remain available for a later non-keepalive flush. Set `keepalive: false` for app-owned large-batch delivery. LogBrew does not use `sendBeacon` by default because beacon cannot send the same Authorization header as `fetch`; use the explicit beacon transport only when your intake endpoint accepts the Authorization-headerless browser beacon envelope.

## Optional Beacon Transport

Use `createBeaconTransport()` for app-owned page-exit delivery only when the target endpoint accepts a JSON body shaped as `{ ingest_key, envelope }`.

```js
import { createBeaconTransport, installLogBrewBrowser } from "@logbrew/browser";

installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  transport: createBeaconTransport({
    endpoint: "https://example.com/logbrew/browser-beacon",
    maxBeaconBodyBytes: 60 * 1024
  })
});
```

The beacon transport sends a `Blob` with `Content-Type: application/json` when the browser supports it, falls back to `fetch` when `sendBeacon` is unavailable, refused, or the body exceeds `maxBeaconBodyBytes`, and never places the browser key in the URL or request headers. The fallback fetch uses the same body-authenticated envelope and disables `keepalive` for oversized bodies to avoid browser keepalive failures. Persisted delivery still stores only the original sanitized telemetry envelope, not the browser key.

When an intake returns HTTP `429`, the browser transport reads the standard `Retry-After` header and passes it to the core SDK as `retryAfterMs`. The flush then raises `SdkError` code `rate_limited`, preserves queued events, and avoids immediate retry; use that signal for app-owned retry timing or user-facing recovery.

Browser clients inherit the core SDK's bounded in-memory queue. Pass `maxQueueSize` and `onEventDropped` to `installLogBrewBrowser()` or `createLogBrewBrowserClient()` when the app wants explicit drop reporting during high-volume browser logging. LogBrew also flushes queued in-memory events on the browser `online` event by default, which helps after temporary connectivity loss.

## Optional Persisted Delivery

Use `persistOffline: true` when a browser app should keep failed batches in Web Storage across a reload, navigation, or temporary offline session.

```js
import { installLogBrewBrowser } from "@logbrew/browser";

const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  persistOffline: {
    maxStoredBatches: 10,
    maxStoredBytes: 256 * 1024,
    storage: window.localStorage
  }
});
```

Persisted delivery stores only the already-sanitized JSON batch body. It does not store the browser key, request headers, cookies, raw payloads, full URLs, query strings, or hash fragments. Stored batches are bounded by `maxStoredBatches` and `maxStoredBytes`, deduplicated by exact batch body, replayed on install and on `online`, and cleared after a successful replay. If the same page session still has the failed events in memory, LogBrew treats that in-memory queue as the source of truth and avoids replaying its own persisted copy separately.

Use `createPersistentBrowserTransport({ transport, storage })` when your app wants to wrap a custom browser transport directly. Persistence is explicit recovery for the documented header-based `fetch` delivery path; it is not a hidden background worker or `sendBeacon` fallback.

Use `RecordingTransport.alwaysAccept()` from `@logbrew/sdk` when you want to inspect queued browser events before network delivery.

## Trace Propagation

Use `createTraceparentFetch()` when the browser app should connect frontend work to backend traces. Propagation is target-scoped by default: no `traceparent` header is attached unless the request URL matches `tracePropagationTargets`.

```js
import {
  createBrowserTraceContext,
  createTraceparentFetch
} from "@logbrew/browser";

const traceContext = createBrowserTraceContext();

const tracedFetch = createTraceparentFetch({
  traceContext,
  tracePropagationTargets: [
    "https://api.example.com/",
    /^\/api\//
  ]
});

await tracedFetch("/api/checkout", {
  method: "POST",
  body: JSON.stringify({ cartId: "cart_123" })
});
```

`installLogBrewBrowser()` creates a shared `traceContext` automatically and uses it for the initial page-view span, browser action metadata, browser error metadata, unhandled rejection metadata, and app-owned network milestone metadata. Pass `traceContext: logbrew.traceContext` to `createTraceparentFetch()` when the browser request should use the same trace as the page and product actions.

If your app renews the active trace on SPA navigation, pass a provider so each request gets the current route trace:

```js
const tracedFetch = createTraceparentFetch({
  traceContext: () => logbrew.traceContext,
  tracePropagationTargets: [/^\/api\//]
});
```

`tracePropagationTargets` accepts strings, regular expressions, or `(url) => boolean` functions. String URL targets apply only to the same origin plus a path prefix, so `https://api.example.com/v1` covers `/v1/orders` on that origin but not `https://wrong.example.com` or `/v10`. Keep targets narrow so browser requests do not send tracing headers to unrelated origins. If the API is on another origin, configure that backend's CORS policy to allow the `traceparent` request header.

LogBrew does not patch global `fetch` or XHR by default, capture request/response bodies, copy arbitrary headers, store query strings or hash fragments by default, or emit W3C baggage/tracestate from the browser helper. Use explicit app-owned fetch/XHR spans or network milestones for the routes that matter.

## SPA Navigation Tracing

Use the navigation helper after `installLogBrewBrowser()` when a browser app wants route-level page-view spans and route-scoped trace correlation without adopting a framework integration.

```js
import {
  captureBrowserAction,
  createTraceparentFetch,
  installLogBrewBrowser,
  installLogBrewBrowserNavigationInstrumentation
} from "@logbrew/browser";

const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY"
});

const navigation = installLogBrewBrowserNavigationInstrumentation(logbrew);

const tracedFetch = createTraceparentFetch({
  traceContext: () => logbrew.traceContext,
  tracePropagationTargets: [/^\/api\//]
});

await captureBrowserAction({
  name: "settings.opened",
  metadata: {
    routeTemplate: "/settings"
  }
}, logbrew);

await tracedFetch("/api/settings");

navigation.uninstall();
```

The helper captures only path changes by default. Query strings, hash fragments, history state objects, request bodies, response bodies, headers, browser storage values, screenshots, and replay data are not copied into telemetry. `uninstall()` removes the `popstate` listener and puts the original `history.pushState` and `history.replaceState` functions back when they are still the LogBrew wrappers.

## Example Source

The package includes example source for browser setup, page-view capture, error listeners, visibility flushing, and target-scoped trace propagation. Use the snippets above as the starting point for wiring LogBrew into your browser application.
