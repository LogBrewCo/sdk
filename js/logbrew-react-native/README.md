# @logbrew/react-native

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

React Native helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It keeps all event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`, while adding mobile-friendly helpers for screen views, app-state changes, product actions, API milestones, handled JavaScript errors, provider/hook usage, active W3C trace correlation, and explicit W3C trace propagation for mobile fetch calls.

## Install

```bash
npm install @logbrew/sdk @logbrew/react-native react react-native
pnpm add @logbrew/sdk @logbrew/react-native react react-native
```

## Basic Usage

```js
import { AppState, Platform } from "react-native";
import {
  captureScreenView,
  createAppStateListener,
  createLogBrewReactNativeClient
} from "@logbrew/react-native";

const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "my-mobile-app",
  sdkVersion: "0.1.0"
});

captureScreenView(client, "Checkout", {
  platform: Platform,
  appState: AppState,
  timestamp: "2026-06-02T10:00:03Z"
});

const stopListening = createAppStateListener(client, AppState, {
  platform: Platform
});
```

For mobile apps, prefer an app-scoped public key through `clientKey`. `apiKey` is still accepted for compatibility with lower-level SDK examples.

## Product Actions And API Milestones

Use explicit action and network helpers for important mobile funnel steps your app already understands. These events are designed for timelines and agent analysis without enabling broad automatic replay:

```js
import {
  captureReactNativeAction,
  captureReactNativeNetwork,
  createReactNativeTraceContext,
  withLogBrewTrace
} from "@logbrew/react-native";

const trace = createReactNativeTraceContext({
  traceparent: incomingTraceparent
});

withLogBrewTrace(trace, () => {
  captureReactNativeAction(client, {
    name: "checkout.submit",
    screen: "Checkout",
    sessionId: "session_123",
    metadata: {
      funnel: "checkout",
      step: "submit"
    }
  });

  captureReactNativeNetwork(client, {
    method: "POST",
    routeTemplate: "/api/checkout",
    statusCode: 202,
    durationMs: 128,
    screen: "Checkout",
    sessionId: "session_123"
  });
});
```

`routeTemplate` is stripped of query strings and hashes before capture. Keep metadata low-cardinality and primitive-only, such as screen names, route templates, funnel names, step names, status codes, durations, session IDs, or trace IDs. Active trace metadata overwrites caller-supplied trace keys so accidental spoofed IDs do not break correlation. Do not send request bodies, response bodies, authorization headers, user-entered form values, or full URLs with private query text. LogBrew does not patch global `fetch` or record visual replay from this package.

## Error Capture

Use `captureReactNativeError()` in app-owned error boundaries, route handlers, async catch blocks, or global handlers. It records handled JavaScript errors as LogBrew issue events with React Native context and omits stack text by default:

```js
import { captureReactNativeError } from "@logbrew/react-native";

try {
  await checkout();
} catch (error) {
  captureReactNativeError(client, error, {
    platform: Platform,
    appState: AppState,
    screen: "Checkout",
    metadata: { flow: "checkout" }
  });
  throw error;
}
```

Set `includeStack: true` only when your app has decided stack text is safe to send. Non-`Error` thrown values are accepted and converted into issue messages so app error handlers do not need custom guards.

## Provider And Hooks

```js
import { AppState, Platform } from "react-native";
import {
  createReactNativeTraceContext,
  LogBrewNativeProvider,
  useLogBrewNativeActions
} from "@logbrew/react-native";

function CheckoutScreen() {
  const {
    captureReactNativeAction,
    captureReactNativeNetwork,
    captureScreenView
  } = useLogBrewNativeActions();
  captureScreenView("Checkout");
  captureReactNativeAction({
    name: "checkout.view",
    screen: "Checkout",
    metadata: { funnel: "checkout", step: "view" }
  });
  captureReactNativeNetwork({
    method: "GET",
    routeTemplate: "/api/cart",
    statusCode: 200,
    durationMs: 42,
    screen: "Checkout"
  });
  return null;
}

export function App({ client }) {
  const trace = createReactNativeTraceContext({
    traceparent: incomingTraceparent
  });
  return (
    <LogBrewNativeProvider client={client} platform={Platform} appState={AppState} trace={trace}>
      <CheckoutScreen />
    </LogBrewNativeProvider>
  );
}
```

The package ships a `react-native` entry that imports `AppState` and `Platform` for Metro, while the default Node entry accepts those dependencies explicitly. That keeps mobile setup explicit instead of pretending a Node process is a native runtime.

## Trace Propagation

Use an active trace when one product operation should connect screen views, logs, handled errors, actions, network milestones, explicit spans, and outbound request headers. `createReactNativeTraceContext()` continues a valid W3C `traceparent` with a fresh local span ID and falls back to a local root when the incoming value is missing or malformed:

```js
import {
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  createReactNativeTraceHeaders,
  getReactNativeTraceMetadata,
  getActiveLogBrewTrace,
  withLogBrewTrace
} from "@logbrew/react-native";

const trace = createReactNativeTraceContext({
  traceparent: incomingTraceparent
});

withLogBrewTrace(trace, activeTrace => {
  client.log("evt_log_checkout", new Date().toISOString(), {
    message: "checkout started",
    level: "info",
    metadata: {
      screen: "Checkout",
      ...getReactNativeTraceMetadata(activeTrace)
    }
  });
  client.span("evt_span_checkout", new Date().toISOString(), createReactNativeSpanAttributes({
    name: "mobile.checkout",
    status: "ok",
    durationMs: 132,
    trace: activeTrace
  }));
  console.log(getActiveLogBrewTrace()?.traceId);
});

const headers = createReactNativeTraceHeaders(trace);
```

For async handlers, keep the returned `trace` object and pass it explicitly after `await` boundaries, or use provider `trace` so hook helpers receive it directly. This avoids pretending React Native has a universal async context manager while still making event-handler correlation simple and predictable.

Use `createTraceparentFetch()` when a React Native app should connect mobile fetch work to backend traces. Propagation is target-scoped by default: no `traceparent` header is attached unless the request URL matches `tracePropagationTargets`.

```js
import {
  createReactNativeTraceContext,
  createReactNativeTraceparent,
  createTraceparentFetch
} from "@logbrew/react-native";

const trace = createReactNativeTraceContext({
  traceparent: incomingTraceparent
});

const tracedFetch = createTraceparentFetch({
  trace,
  traceparentFactory: () => createReactNativeTraceparent(),
  tracePropagationTargets: [
    "https://api.example.com/",
    /^\/mobile-api\//
  ]
});

await tracedFetch("https://api.example.com/checkout", {
  method: "POST",
  headers: { accept: "application/json" }
});
```

When `traceparentFactory` is omitted, `createTraceparentFetch()` reuses the supplied or active trace context. `tracePropagationTargets` accepts strings, regular expressions, or `(url) => boolean` functions. String URL targets apply only to the same origin plus a path prefix, so `https://api.example.com/v1` covers `/v1/orders` on that origin but not `https://wrong.example.com` or `/v10`. Keep targets narrow so mobile requests do not send tracing headers to unrelated origins. If the API is cross-origin or behind a gateway, allow the `traceparent` request header there too.

## Example Source

The package includes example source for screen views, app-state metadata, handled JavaScript errors, provider/hooks, active trace correlation, and target-scoped trace propagation. After installing, inspect the shipped examples with:

```bash
node node_modules/@logbrew/react-native/examples/index.mjs --list
node node_modules/@logbrew/react-native/examples/index.mjs trace-correlation
```
