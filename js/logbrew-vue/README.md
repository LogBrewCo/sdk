# @logbrew/vue

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

For Vue browser apps, prefer a browser-scoped public key through `clientKey`. `apiKey` and `LOGBREW_API_KEY` are still accepted for compatibility with lower-level SDK examples and server-side tests.

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

`tracePropagationTargets` accepts strings, regular expressions, or `(url) => boolean` functions. Match as narrowly as possible so Vue does not send tracing headers to unrelated origins. If the API is on another origin, configure that backend's CORS policy to allow the `traceparent` request header.

## Packaged Examples

After install, these commands are available from a consumer app:

```bash
node node_modules/@logbrew/vue/examples/index.mjs --help
node node_modules/@logbrew/vue/examples/index.mjs --list
node node_modules/@logbrew/vue/examples/index.mjs readme-example
node node_modules/@logbrew/vue/examples/index.mjs real-user-smoke
node node_modules/@logbrew/vue/examples/index.mjs
npm --prefix node_modules/@logbrew/vue/examples run help
npm --prefix node_modules/@logbrew/vue/examples run list
npm --prefix node_modules/@logbrew/vue/examples run readme-example
npm --prefix node_modules/@logbrew/vue/examples run real-user-smoke
```

The default launcher path runs `real-user-smoke`.
