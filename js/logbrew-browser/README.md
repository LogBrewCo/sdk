# @logbrew/browser

Browser helpers for the public LogBrew JavaScript SDK.

This package captures page views, synchronous browser errors, and unhandled Promise rejections while keeping validation, buffering, retry, flush, and shutdown behavior in `@logbrew/sdk`.

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

For browser apps, prefer a browser-scoped public key through `clientKey`. `apiKey` is still accepted for compatibility with lower-level SDK examples and tests.

By default, browser metadata keeps the current path without query string or hash. It does not include document title or user agent unless `includeDocumentTitle` or `includeUserAgent` is enabled. Pass `sanitizeMetadata(metadata, kind)` to remove or rewrite metadata before events are queued.

Set `flushOnPageHide: false` or `flushOnVisibilityHidden: false` if your app wants to own page lifecycle delivery itself.

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

For tests and local examples, use `RecordingTransport.alwaysAccept()` from `@logbrew/sdk` so no network call is made.

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

`tracePropagationTargets` accepts strings, regular expressions, or `(url) => boolean` functions. Match as narrowly as possible so browser requests do not send tracing headers to unrelated origins. If the API is on another origin, configure that backend's CORS policy to allow the `traceparent` request header.

## Packaged Examples

After install, these commands are available from a consumer app:

```bash
node node_modules/@logbrew/browser/examples/index.mjs --help
node node_modules/@logbrew/browser/examples/index.mjs --list
node node_modules/@logbrew/browser/examples/index.mjs readme-example
node node_modules/@logbrew/browser/examples/index.mjs real-user-smoke
node node_modules/@logbrew/browser/examples/index.mjs
npm --prefix node_modules/@logbrew/browser/examples run help
npm --prefix node_modules/@logbrew/browser/examples run list
npm --prefix node_modules/@logbrew/browser/examples run readme-example
npm --prefix node_modules/@logbrew/browser/examples run real-user-smoke
```

The default launcher path runs `real-user-smoke`.
