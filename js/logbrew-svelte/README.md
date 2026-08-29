# @logbrew/svelte

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Svelte context and SvelteKit request/error helpers for the public LogBrew JavaScript SDK.

This package stays thin over `@logbrew/sdk` and `@logbrew/browser`. It adds Svelte 5 context helpers plus correlated SvelteKit server request/error hooks while the shared packages own event validation, delivery, browser errors, page views, breadcrumbs, tracing, retry, flush, and shutdown.

## Install

```bash
npm install @logbrew/sdk @logbrew/browser @logbrew/svelte svelte
pnpm add @logbrew/sdk @logbrew/browser @logbrew/svelte svelte
```

## SvelteKit Server Hooks

Create a server-scoped key, keep it in a server-only environment variable, and export the returned hooks from `src/hooks.server.js`:

```js
import {
  createLogBrewSvelteContext,
  createLogBrewSvelteKitHooks
} from "@logbrew/svelte";

const logbrew = createLogBrewSvelteContext({
  serverApiKey: process.env.LOGBREW_SERVER_API_KEY,
  context: {
    schemaVersion: 1,
    resource: {
      service: { name: "storefront-web" },
      deployment: { environment: "production", release: "web@1.4.0" }
    }
  }
});

const hooks = createLogBrewSvelteKitHooks(logbrew);
export const handle = hooks.handle;
export const handleError = hooks.handleError;
```

`handle` records one bounded `http.server` request span using the HTTP method, SvelteKit route ID, status, duration, and W3C trace context. It never records the concrete URL, query, headers, body, cookies, or route parameters. `handleError` adds the exception type, handled state, sanitized generated frames, bounded cause chain, one request-local route breadcrumb, and the same trace/span IDs. Shared client breadcrumbs are not used by server hooks, so concurrent users cannot inherit one another's history. Invalid incoming `traceparent` values are ignored without breaking the request. Telemetry delivery failures do not replace the application response unless `raiseCaptureErrors` is explicitly enabled.

Pass `mapError(input)` when the application already returns a sanitized `App.Error`; its return value remains the SvelteKit hook result.

## Browser Setup

Use `@logbrew/browser` once from browser-owned startup to capture page views, browser errors, unhandled rejections, lifecycle delivery, and the active browser trace. Pass that context to the root Svelte component:

```js
import { installLogBrewBrowser } from "@logbrew/browser";

export const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  context: {
    schemaVersion: 1,
    resource: {
      service: { name: "storefront-browser" },
      deployment: { environment: "production", release: "web@1.4.0" }
    }
  }
});
```

Browser and server keys are separate. Never place the server key in a public Svelte bundle.
Keep the canonical shared-context environment and release identical on both surfaces; use stable service names to distinguish browser and server work without breaking deployment filtering.

## Component Context

```svelte
<script>
  import { setLogBrewContext } from "@logbrew/svelte";

  export let logbrew;
  setLogBrewContext(logbrew);

  logbrew.client.log("evt_log_001", new Date().toISOString(), {
    message: "dashboard rendered",
    level: "info",
    logger: "svelte"
  });
</script>

<p>Pending events: {logbrew.client.pendingEvents()}</p>
```

For direct component-only setup, `createLogBrewSvelteContext({ clientKey })` now owns authenticated fetch delivery to `https://api.logbrew.co/v1/events`; an explicit transport still overrides it. Use a browser-scoped public key through `clientKey` and a server-scoped key through `serverApiKey` or `LOGBREW_SERVER_API_KEY`.

## View And Error Helpers

```js
import {
  captureSvelteError,
  createSvelteErrorEvent,
  createSvelteViewEvent,
  useLogBrew
} from "@logbrew/svelte";

const logbrew = useLogBrew();
const view = createSvelteViewEvent("Dashboard", { path: "/dashboard" });
logbrew.client.log(view.id, view.timestamp, view.attributes);

await captureSvelteError(new Error("component failed"), logbrew, {
  component: "Dashboard",
  errorEvent(error) {
    return createSvelteErrorEvent(error, {
      component: "Dashboard"
    });
  }
});
```

Use `captureSvelteError()` from Svelte boundary handlers or other app-owned error hooks. It creates typed exception evidence through the shared JavaScript diagnostics path and flushes without closing the reusable context. Raw stack text remains excluded unless `includeErrorStack: true` is explicitly supplied; sanitized frames are still captured by default.

The helper and SvelteKit hooks forward the core JavaScript error options, including bounded application-reported `evidence` for a likely cause, repository-relative fix area, impact, and explicit missing, redacted, or truncated fields. LogBrew keeps that content labeled as unverified application telemetry.

## Trace Propagation

Use `createTraceparentFetch()` when Svelte frontend work should connect to backend traces. These exports delegate to the same canonical browser tracing implementation used by `@logbrew/browser`. Propagation is target-scoped by default: no `traceparent` header is attached unless the request URL matches `tracePropagationTargets`.

```js
import { createSvelteTraceparent, createTraceparentFetch } from "@logbrew/svelte";

const tracedFetch = createTraceparentFetch({
  traceparentFactory: () => createSvelteTraceparent(),
  tracePropagationTargets: [
    "https://api.example.com/",
    /^\/api\//u
  ]
});

await tracedFetch("/api/cart");
```

`tracePropagationTargets` accepts strings, regular expressions, or `(url) => boolean` functions. String URL targets apply only to the same origin plus a path prefix, so `https://api.example.com/v1` covers `/v1/orders` on that origin but not `https://wrong.example.com` or `/v10`. Keep targets narrow so Svelte does not send tracing headers to unrelated origins. If the API is on another origin, configure that backend's CORS policy to allow the `traceparent` request header.

## Example Source

The package includes example source for context setup, view events, Svelte error capture, and target-scoped trace propagation. Use the snippets above as the starting point for wiring LogBrew into your Svelte application.
