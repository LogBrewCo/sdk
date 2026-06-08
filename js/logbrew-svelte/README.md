# @logbrew/svelte

Svelte context and error helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It adds Svelte 5 context helpers, a `useLogBrew()` accessor, view helper events, and error capture helpers while keeping event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`.

## Install

```bash
npm install @logbrew/sdk @logbrew/svelte svelte
pnpm add @logbrew/sdk @logbrew/svelte svelte
```

## Component Context

```svelte
<script>
  import { RecordingTransport } from "@logbrew/sdk";
  import { setLogBrewContext, useLogBrew } from "@logbrew/svelte";

  setLogBrewContext({
    clientKey: "LOGBREW_CLIENT_KEY",
    transport: RecordingTransport.alwaysAccept()
  });

  const logbrew = useLogBrew();
  logbrew.client.log("evt_log_001", new Date().toISOString(), {
    message: "dashboard rendered",
    level: "info",
    logger: "svelte"
  });
</script>

<p>Pending events: {logbrew.client.pendingEvents()}</p>
```

For Svelte browser apps, prefer a browser-scoped public key through `clientKey`. `apiKey` and `LOGBREW_API_KEY` are still accepted for compatibility with lower-level SDK examples and server-side use.

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

Use `captureSvelteError()` from Svelte boundary handlers, app-owned error hooks, or SvelteKit hooks. The helper captures an issue event and then shuts down through the context transport so app error handling remains in the app's control.

## Trace Propagation

Use `createTraceparentFetch()` when Svelte frontend work should connect to backend traces. Propagation is target-scoped by default: no `traceparent` header is attached unless the request URL matches `tracePropagationTargets`.

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

`tracePropagationTargets` accepts strings, regular expressions, or `(url) => boolean` functions. Match as narrowly as possible so Svelte does not send tracing headers to unrelated origins. If the API is on another origin, configure that backend's CORS policy to allow the `traceparent` request header.

## Example Source

The package includes example source for context setup, view events, Svelte error capture, and target-scoped trace propagation. Use the snippets above as the starting point for wiring LogBrew into your Svelte application.
