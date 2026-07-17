# @logbrew/react-native

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

React Native helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It keeps all event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`, while adding mobile-friendly helpers for screen views, app-state changes, product actions, API milestones, handled JavaScript errors, provider/hook usage, active W3C trace correlation, explicit W3C trace propagation, opt-in lifecycle spans, opt-in resource fetch spans, opt-in reversible global fetch spans, app-owned native bridge scope sync, and reversible instrumentation setup.

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

When you prepare React Native release artifacts, wrap the app-owned Metro config once. Production bundles and source maps receive one matching Debug ID, while development and hot-reload serialization remain unchanged:

```js
// metro.config.js
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const { withLogBrewMetroConfig } = require("@logbrew/react-native/metro");

module.exports = withLogBrewMetroConfig(
  mergeConfig(getDefaultConfig(__dirname), {})
);
```

Then use the same release identity when capturing the error. The Metro-injected runtime registry connects the first parsed JavaScript frame to its Debug ID without another app option:

```js
captureReactNativeError(client, error, {
  platform: Platform,
  appState: AppState,
  screen: "Checkout",
  release: "2026.06.18",
  environment: "production",
  service: "checkout-mobile",
  runtime: "react-native"
});
```

The wrapper composes an existing custom serializer, is idempotent, and adds no network behavior. A string-returning custom serializer may preserve Metro's default bundle code; a serializer that changes code must return `{ code, map }` so LogBrew cannot attach a mismatched source map. If an advanced build pipeline cannot use the wrapper, `debugIdMap` remains an explicit override and takes precedence over runtime discovery. LogBrew records `releaseArtifactDebugId`, path-only frame metadata, release/environment/service/runtime, and active trace IDs when available. It strips query strings, hashes, and local absolute paths from event metadata; raw stack text is still opt-in with `includeStack: true`. Hosted source-map lookup and rendered symbolicated issues are separate service capabilities and are not implemented by this runtime helper.

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

## Lifecycle, Navigation, And Resource Spans

Use explicit span helpers when you want app foreground/background transitions, route changes, and API resources to appear in the same trace as mobile actions and errors. The AppState lifecycle listener records app-owned lifecycle spans without replacing the simpler action-only `createAppStateListener()`:

```js
import { createReactNativeTraceContext } from "@logbrew/react-native";
import { createAppStateLifecycleSpanListener } from "@logbrew/react-native/lifecycle";

const trace = createReactNativeTraceContext({
  traceparent: incomingTraceparent
});

const stopLifecycleTracing = createAppStateLifecycleSpanListener(client, AppState, {
  trace,
  platform: Platform,
  screen: "Checkout",
  sessionId: "session_123",
  captureInitialState: true
});
```

`createAppStateLifecycleSpanListener()` captures the current AppState as primitive metadata, records transition names such as `app_state:active->background`, and measures duration from the previous observed state when possible. It does not patch React Native internals, derive session health, or inspect native bridge state.

The React Navigation listener accepts a navigation container ref shape without adding a React Navigation dependency:

```js
import {
  captureReactNativeResourceSpan,
  createReactNavigationSpanListener,
} from "@logbrew/react-native";

const stopNavigationTracing = createReactNavigationSpanListener(client, navigationRef, {
  trace,
  platform: Platform,
  appState: AppState,
  metadata: { flow: "checkout" }
});

captureReactNativeResourceSpan(client, {
  trace,
  method: "POST",
  routeTemplate: "/api/checkout",
  statusCode: 202,
  durationMs: 171,
  screen: "Checkout"
});
```

`createReactNavigationSpanListener()` listens for React Navigation `state` changes and uses `__unsafe_action__` dispatch timing when the container exposes it. Route names and query-stripped route paths are captured; route keys are omitted unless `includeRouteKey: true` is set because they can be high-cardinality. `captureReactNativeResourceSpan()` records app-owned resource spans without patching global `fetch`/XHR, reading request bodies, copying headers, or storing full URLs with query text.

For app-owned fetch calls where you want the resource span and outbound `traceparent` in one place, use the explicit resource-fetch subpath:

```js
import {
  createReactNativeGraphQLMetadataFactory,
  createReactNativeResourceFetch
} from "@logbrew/react-native/resource-fetch";

const resourceFetch = createReactNativeResourceFetch(client, {
  trace,
  platform: Platform,
  appState: AppState,
  screen: "Checkout",
  measureResponseBodySize: true,
  metadataFactory: createReactNativeGraphQLMetadataFactory({
    endpoint: "/graphql"
  }),
  tracePropagationTargets: ["https://api.example.com/"]
});

await resourceFetch("https://api.example.com/graphql?email=hidden", {
  method: "POST",
  headers: { accept: "application/json" },
  body: JSON.stringify({
    query: "mutation CheckoutSubmit($email: String!) { checkout(email: $email) { id } }",
    variables: { email: "hidden@example.com" }
  })
});
```

`createReactNativeResourceFetch()` wraps the fetch function your app supplies, or the runtime `fetch` when available. It records status, method, duration, response-start timing, sanitized route template, screen, session, primitive metadata, response size when `Content-Length` is available, and trace correlation. `metadataFactory` is called after each fetch completes or fails so apps can add low-cardinality request metadata such as `graphqlOperationName` or `graphqlOperationType`; by default LogBrew does not parse GraphQL payloads. If you set `measureResponseBodySize: true`, LogBrew can fall back to measuring a cloned response body's byte length when the response omits `Content-Length`; it returns the original response untouched and does not store the response content. Metadata returned from the factory keeps only primitive values and drops sensitive request fields. It does not patch global `fetch` or XHR, inspect request or response bodies by default, capture arbitrary headers, or attach `traceparent` outside `tracePropagationTargets`. Pass `trace` explicitly after `await` boundaries or build the wrapper from provider/hook state so async resource spans stay correlated.
`createReactNativeGraphQLMetadataFactory()` is an explicit helper for GraphQL requests your app already owns. Pass `endpoint` as a route template, absolute URL without query/hash, `RegExp`, predicate, or an array of those when you use it with broader fetch/XHR instrumentation; LogBrew compares route templates and query-stripped URL paths before parsing. It reads only a JSON string request body to derive `graphqlOperationName` and `graphqlOperationType`, drops variables/query text/body fields, ignores large or non-JSON bodies, and can compose an existing primitive metadata factory. Do not use it on unrelated endpoints without an endpoint matcher.

If your app uses Apollo Client, use the optional Apollo subpath with the `ApolloLink` constructor your app already imports:

```js
import { ApolloLink } from "@apollo/client";
import { createReactNativeApolloLink } from "@logbrew/react-native/apollo";

const logbrewApolloLink = createReactNativeApolloLink(client, {
  ApolloLink,
  trace,
  screen: "Checkout",
  metadata: { flow: "checkout" }
});
```

`createReactNativeApolloLink()` returns an app-owned Apollo Link. It records one `graphql.<operationType> <operationName>` span when an operation completes or fails, writes one normalized W3C `traceparent` into the operation context by default, and keeps primitive metadata such as `graphqlOperationName`, `graphqlOperationType`, `framework`, and `source`. It does not add an Apollo dependency to default LogBrew installs, patch global fetch/XHR, capture query text, variables, payloads, response data, arbitrary headers, cookies, error messages, stacks, baggage, or tracestate. Pass `propagateTraceparent: false` if another Apollo link owns outbound propagation.

## Native Bridge Scope Sync

Use the native bridge subpath when JavaScript needs to pass the active LogBrew trace into a native module call your app owns. The helper builds a primitive-only scope payload and sends it through a callback or adapter method such as `setLogBrewScope()`:

```js
import { createReactNativeTraceContext } from "@logbrew/react-native";
import { withLogBrewNativeBridgeScope } from "@logbrew/react-native/native-bridge";

const trace = createReactNativeTraceContext({
  traceparent: incomingTraceparent
});

await withLogBrewNativeBridgeScope(nativeCheckoutModule, {
  trace,
  logger: "NativeCheckout",
  screen: "Checkout",
  sessionId: "session_123",
  metadata: {
    routeTemplate: "/native/checkout"
  }
}, async () => {
  await nativeCheckoutModule.submitOrder();
});
```

`withLogBrewNativeBridgeScope()` syncs the scope before the callback and clears it afterward, including async callbacks. The payload contains only trace IDs, sampled flags, and primitive metadata. It does not install a native module, inspect native bridge arguments, sync user/session identity, capture payloads or headers, derive session health, or patch React Native internals.

## Reversible Instrumentation Setup

Use the instrumentation subpath when you want one setup call to install the app-owned pieces above and receive a resource fetch wrapper:

```js
import { createReactNativeTraceContext } from "@logbrew/react-native";
import { createLogBrewReactNativeInstrumentation } from "@logbrew/react-native/instrumentation";

const trace = createReactNativeTraceContext({
  traceparent: incomingTraceparent
});

const instrumentation = createLogBrewReactNativeInstrumentation(client, {
  trace,
  platform: Platform,
  appState: AppState,
  navigationContainer: navigationRef,
  nativeBridge: nativeCheckoutModule,
  screen: "Checkout",
  sessionId: "session_123",
  tracePropagationTargets: ["https://api.example.com/"],
  captureInitialLifecycleState: true,
  captureInitialNavigationRoute: true
});

await instrumentation.resourceFetch("https://api.example.com/checkout", {
  method: "POST"
});

instrumentation.remove();
```

`createLogBrewReactNativeInstrumentation()` composes existing AppState lifecycle spans, React Navigation spans, target-scoped resource fetch spans, and native bridge scope sync into a removable handle. It does not patch global `fetch`, XHR, React Navigation, AppState, or native modules by default; it only subscribes to the objects your app passes in and returns `remove()`/`stop()` so setup is reversible. Keep `tracePropagationTargets` narrow and continue to avoid request bodies, response bodies, arbitrary headers, full URLs with query text, and high-cardinality route keys.

If migrating an app with many existing `fetch(...)` calls, opt into reversible global fetch instrumentation explicitly:

```js
const instrumentation = createLogBrewReactNativeInstrumentation(client, {
  trace,
  screen: "Checkout",
  instrumentGlobalFetch: true,
  measureFetchResponseBodySize: true,
  tracePropagationTargets: ["https://api.example.com/"]
});

await fetch("https://api.example.com/checkout", { method: "POST" });
instrumentation.remove();
```

With `instrumentGlobalFetch: true`, LogBrew wraps the current `globalThis.fetch`, records the same sanitized resource spans as `resourceFetch`, and puts the original function back only if LogBrew still owns the `fetch` slot. Response-start timing is measured when the fetch promise resolves, and total duration includes any explicit cloned-body sizing you opt into. Response size is read from `Content-Length` by default; set `measureFetchResponseBodySize: true` only when your app accepts clone-based response body sizing for responses without that header. Outbound `traceparent` remains target-scoped; LogBrew still does not patch XHR, read original request or response bodies, copy arbitrary headers, persist offline requests, capture full URLs with query/hash text, or inspect GraphQL payloads unless you explicitly pass the GraphQL metadata factory above.

Apps with older libraries that still use `XMLHttpRequest` can opt into reversible XHR instrumentation separately:

```js
const instrumentation = createLogBrewReactNativeInstrumentation(client, {
  trace,
  screen: "Checkout",
  instrumentGlobalXMLHttpRequest: true,
  measureXhrResponseBodySize: true,
  tracePropagationTargets: ["https://api.example.com/"]
});

const xhr = new XMLHttpRequest();
xhr.open("POST", "https://api.example.com/checkout?email=hidden");
xhr.send(JSON.stringify({ ignored: "body is not captured" }));
instrumentation.remove();
```

With `instrumentGlobalXMLHttpRequest: true`, LogBrew patches only `XMLHttpRequest.prototype.open` and `send`, records sanitized XHR resource spans with status, response-start timing, and response size when `Content-Length` is available, and puts the original methods back when it is safe to do so. If you set `measureXhrResponseBodySize: true`, LogBrew can fall back to measuring the completed XHR response object's byte length without storing the response content. It writes a single `traceparent` through the app's existing `setRequestHeader` only for configured targets. It does not capture request bodies, response bodies, arbitrary request headers, arbitrary response headers, cookies, GraphQL payloads, full URLs with query/hash text, baggage, or tracestate.
If you pass `metadataFactory: createReactNativeGraphQLMetadataFactory({ endpoint: "/graphql" })`, XHR spans can derive the GraphQL operation name and type from JSON string request bodies your app already owns and skip unrelated endpoints. The helper still drops variables, query text, body fields, headers, payloads, response data, baggage, and tracestate; do not enable it broadly without endpoint matching.

## Release Artifact Preparation

Use the release-artifacts subpath after the wrapped React Native build has emitted a Metro bundle and source map. The helper preserves the Metro-injected Debug ID, strips embedded source content by default, writes a local manifest, and can run the installed upload path. It also injects a matching ID when used without the Metro wrapper for compatibility. Hosted JavaScript bundle upload is an explicit opt-in; rendered symbolicated issues and native crash symbolication remain separate service capabilities:

```js
import { prepareLogBrewReactNativeReleaseArtifacts } from "@logbrew/react-native/release-artifacts";

prepareLogBrewReactNativeReleaseArtifacts({
  bundle: "dist/index.android.bundle",
  sourcemap: "dist/index.android.bundle.map",
  platform: "android",
  release: "2026.06.18",
  environment: "production",
  service: "checkout-mobile",
  root: process.cwd()
});
```

For a local loopback upload check, use the upload helper against a `localhost` or `127.0.0.1` endpoint:

```js
import { uploadLogBrewReactNativeReleaseArtifacts } from "@logbrew/react-native/release-artifacts";

uploadLogBrewReactNativeReleaseArtifacts({
  bundle: "dist/index.android.bundle",
  sourcemap: "dist/index.android.bundle.map",
  platform: "android",
  release: "2026.06.18",
  environment: "production",
  service: "checkout-mobile",
  root: process.cwd(),
  endpoint: "http://127.0.0.1:4319/retry-success",
  maxRetries: 2,
  retryDelay: 0
});
```

For a hosted release-artifact endpoint, keep the release-artifact auth value in an environment variable and opt in explicitly:

```js
uploadLogBrewReactNativeReleaseArtifacts({
  bundle: "dist/index.android.bundle",
  sourcemap: "dist/index.android.bundle.map",
  projectId: "550e8400-e29b-41d4-a716-446655440000",
  platform: "android",
  release: "2026.06.18",
  environment: "production",
  service: "checkout-mobile",
  root: process.cwd(),
  endpoint: "https://api.logbrew.com/api/release-artifacts",
  allowHostedUpload: true,
  tokenEnv: "LOGBREW_RELEASE_ARTIFACT_AUTH"
});
```

The helper requires explicit `release`, `environment`, `service`, and `platform` metadata. Hosted uploads also require a UUID `projectId`; local preparation and loopback upload remain valid without it. It defaults minified bundle URLs to `app:///react-native/<platform>/...`, removes query strings and hashes from manifest URLs, and strips source paths under `root` or `stripSourcePrefix`. Hosted endpoints must use HTTPS and must not include embedded auth values, query strings, or fragments. The helper never uses normal SDK ingest keys or account/session API auth values. When `sourcemap` points at a final Hermes-composed map, the helper makes the bundle's `sourceMappingURL` point at that explicit map, so stale packager-map comments do not block manifest generation. The explicit Metro wrapper changes only app-owned serialization and one bounded runtime Debug-ID registry; neither helper patches Gradle, Xcode, global fetch/XHR, request payloads, or transport behavior.

React Native native symbols are handled as release artifacts, not runtime telemetry. For local dry-run validation, use the repo release-artifact tooling against app-owned build outputs such as `ios/build/.../*.dSYM`, `android/app/build/outputs/mapping/release/mapping.txt`, and `android/app/build/intermediates/merged_native_libs/.../*.so`. The current public SDK validates metadata and privacy boundaries only; backend upload, storage, lookup, and native symbolication are still backend-owned future support, so do not rely on normal runtime error capture for native crash symbolication yet.

## Example Source

The package includes example source for screen views, app-state metadata, handled JavaScript errors, provider/hooks, active trace correlation, target-scoped trace propagation, lifecycle/resource spans, native bridge scope sync, and reversible instrumentation setup. After installing, inspect the shipped examples with:

```bash
node node_modules/@logbrew/react-native/examples/index.mjs --list
node node_modules/@logbrew/react-native/examples/index.mjs instrumentation-kit
node node_modules/@logbrew/react-native/examples/index.mjs lifecycle-spans
node node_modules/@logbrew/react-native/examples/index.mjs native-bridge-scope
node node_modules/@logbrew/react-native/examples/index.mjs navigation-resource-spans
node node_modules/@logbrew/react-native/examples/index.mjs resource-fetch-spans
node node_modules/@logbrew/react-native/examples/index.mjs trace-correlation
```
