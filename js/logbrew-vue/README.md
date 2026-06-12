# @logbrew/vue

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-espresso-bg-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Vue plugin and composable helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It adds Vue 3 `app.use(...)`, app-level provide/inject, a `useLogBrew()` composable, `$logbrew`, view helper events, and Vue error-handler capture while keeping event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`.

## Install

```bash
npm install @logbrew/sdk @logbrew/vue vue
pnpm add @logbrew/sdk @logbrew/vue vue
```

## App Plugin

```js
import { createApp } from "vue";
import { RecordingTransport } from "@logbrew/sdk";
import { createLogBrewVuePlugin } from "@logbrew/vue";
import App from "./App.vue";

createApp(App)
  .use(createLogBrewVuePlugin({
    clientKey: "LOGBREW_CLIENT_KEY",
    transport: RecordingTransport.alwaysAccept()
  }))
  .mount("#app");
```

For Vue browser apps, prefer a browser-scoped public key through `clientKey`. `apiKey` and `LOGBREW_API_KEY` are still accepted for compatibility with lower-level SDK examples and server-side use.

## Composable

```js
import { createVueViewEvent, useLogBrew } from "@logbrew/vue";

export default {
  setup() {
    const logbrew = useLogBrew();
    const event = createVueViewEvent("Dashboard", {
      path: "/dashboard",
      now: () => new Date().toISOString()
    });
    logbrew.client.log(event.id, event.timestamp, event.attributes);
    return { pending: logbrew.client.pendingEvents() };
  }
};
```

The plugin uses Vue's app-level `provide` so `useLogBrew()` works from descendant components. It also wraps `app.config.errorHandler` by default, captures component errors, and then calls any existing handler so normal app behavior is preserved.

## Trace Propagation

Use `createTraceparentFetch()` when Vue frontend work should connect to backend traces. Propagation is target-scoped by default: no `traceparent` header is attached unless the request URL matches `tracePropagationTargets`.

```js
import { createTraceparentFetch, createVueTraceparent } from "@logbrew/vue";

const tracedFetch = createTraceparentFetch({
  traceparentFactory: () => createVueTraceparent(),
  tracePropagationTargets: [
    "https://api.example.com/",
    /^\/api\//u
  ]
});

await tracedFetch("/api/cart");
```

`tracePropagationTargets` accepts strings, regular expressions, or `(url) => boolean` functions. String URL targets apply only to the same origin plus a path prefix, so `https://api.example.com/v1` covers `/v1/orders` on that origin but not `https://wrong.example.com` or `/v10`. Keep targets narrow so Vue does not send tracing headers to unrelated origins. If the API is on another origin, configure that backend's CORS policy to allow the `traceparent` request header.

## Example Source

The package includes example source for plugin setup, composables, view events, Vue error capture, and target-scoped trace propagation. Use the snippets above as the starting point for wiring LogBrew into your Vue application.
