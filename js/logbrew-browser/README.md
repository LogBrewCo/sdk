# @logbrew/browser

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-espresso-bg-512.png" alt="LogBrew logo" width="96" height="96">
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

`installLogBrewBrowser()` attaches `error` and `unhandledrejection` listeners with `addEventListener()`, captures an initial page-view span, flushes queued events when the page becomes hidden or receives `pagehide`, and returns a handle with `client`, `flush()`, `shutdown()`, `previewJson()`, and `uninstall()`.

For browser apps, prefer a browser-scoped public key through `clientKey`. `apiKey` is still accepted for compatibility with lower-level SDK examples.

By default, browser metadata keeps the current path without query string or hash. It does not include document title or user agent unless `includeDocumentTitle` or `includeUserAgent` is enabled. Pass `sanitizeMetadata(metadata, kind)` to remove or rewrite metadata before events are queued.

Set `flushOnPageHide: false` or `flushOnVisibilityHidden: false` if your app wants to own page lifecycle delivery itself.

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

## Fetch Transport

```js
import { createFetchTransport, installLogBrewBrowser } from "@logbrew/browser";

installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  transport: createFetchTransport({
    endpoint: "https://api.logbrew.com/v1/events"
  })
});
```

Use `RecordingTransport.alwaysAccept()` from `@logbrew/sdk` when you want to inspect queued browser events before network delivery.

## Trace Propagation

Use `createTraceparentFetch()` when the browser app should connect frontend work to backend traces. Propagation is target-scoped by default: no `traceparent` header is attached unless the request URL matches `tracePropagationTargets`.

```js
import {
  createBrowserTraceparent,
  createTraceparentFetch
} from "@logbrew/browser";

const tracedFetch = createTraceparentFetch({
  traceparentFactory: () => createBrowserTraceparent(),
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

`tracePropagationTargets` accepts strings, regular expressions, or `(url) => boolean` functions. String URL targets apply only to the same origin plus a path prefix, so `https://api.example.com/v1` covers `/v1/orders` on that origin but not `https://wrong.example.com` or `/v10`. Keep targets narrow so browser requests do not send tracing headers to unrelated origins. If the API is on another origin, configure that backend's CORS policy to allow the `traceparent` request header.

## Example Source

The package includes example source for browser setup, page-view capture, error listeners, visibility flushing, and target-scoped trace propagation. Use the snippets above as the starting point for wiring LogBrew into your browser application.
