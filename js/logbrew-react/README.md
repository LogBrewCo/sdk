# @logbrew/react

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

React helpers for the public LogBrew JavaScript SDK.

## Install

```bash
npm install @logbrew/sdk @logbrew/react react
pnpm add @logbrew/sdk @logbrew/react react
```

The package ships plain ESM and CommonJS entrypoints, `.d.ts` and `.d.cts` declarations, a `LogBrewProvider`, `LogBrewErrorBoundary`, `useLogBrew`, `useLogBrewActions`, `useLogBrewAction`, `useLogBrewNetwork`, `useLogBrewReactRouterNavigation`, `createReactRouterRouteTemplate`, `createLogBrewReactClient`, handled React error helpers, and explicit W3C trace propagation helpers for frontend-to-backend fetch calls. It keeps `@logbrew/sdk` and `react` as peer dependencies so app owners control their React/runtime versions.

If a React browser app also wants Web Vitals or interaction timing spans, install the browser package and import the optional subpath:

```bash
npm install @logbrew/sdk @logbrew/browser @logbrew/react react
pnpm add @logbrew/sdk @logbrew/browser @logbrew/react react
```

## Example

```js
import React from "react";
import {
  LogBrewProvider,
  createLogBrewReactClient,
  useLogBrewAction,
  useLogBrewNetwork
} from "@logbrew/react";

const client = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react",
  sdkVersion: "0.1.0"
});

function CheckoutButton() {
  const captureAction = useLogBrewAction({
    metadata: {
      funnel: "checkout",
      routeTemplate: "/checkout",
      sessionId: "sess_123"
    }
  });
  const captureNetwork = useLogBrewNetwork({
    routeTemplate: "/api/checkout",
    sessionId: "sess_123"
  });

  async function onClick() {
    captureAction({
      name: "checkout-click",
      metadata: { step: "submit" }
    });

    captureNetwork({
      durationMs: 124,
      method: "POST",
      statusCode: 202,
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
    });
  }

  return React.createElement("button", { onClick }, "Checkout");
}

export function App() {
  return React.createElement(
    LogBrewProvider,
    { client },
    React.createElement(CheckoutButton)
  );
}
```

For browser React apps, prefer a browser-scoped public key through `clientKey`. `apiKey` is still accepted for compatibility with lower-level SDK examples. Call `flush` or `shutdown` on the underlying client to send queued events through a transport, and use `previewJson()` when you want a stable local JSON preview before sending anything.

`createLogBrewReactClient()` also passes through the core SDK queue controls: `maxQueueSize`, `eventFilter`, `onEventDropped`, and `maxRetries`. Use them to keep heavy UI bursts bounded and observable without interrupting React rendering.

## Product Actions And Network Milestones

Use `useLogBrewAction()` for product steps your React app already understands, such as route changes, clicks, form submits, retry decisions, and funnel steps. Use `useLogBrewNetwork()` for important API milestones that should be correlated with the same session or trace. Both helpers enqueue LogBrew `action` events, which gives LogBrew and AI agents a structured timeline across many app sessions without requiring visual replay.

Keep metadata low-cardinality and privacy-safe. Prefer route templates such as `/checkout` or `/api/orders/:id`; avoid raw selectors, full URLs, query strings, user-entered text, headers, request bodies, response bodies, screenshots, and replay payloads unless your application owns an explicit opt-in and redaction policy. `useLogBrewNetwork()` strips query strings and hashes from `routeTemplate`, records method/status/duration/session/trace metadata, and does not patch `fetch` automatically.

## Browser Timing Spans

Use `useLogBrewBrowserInstrumentation()` from `@logbrew/react/browser` when a React browser app wants the provider's LogBrew client to capture browser timing spans. This subpath is opt-in: it requires `@logbrew/browser`, runs from a React effect, unregisters observers on unmount, and does not change the default `@logbrew/react` import path.

```js
import React from "react";
import { LogBrewProvider, createLogBrewReactClient } from "@logbrew/react";
import { useLogBrewBrowserInstrumentation } from "@logbrew/react/browser";

const client = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "checkout-web",
  sdkVersion: "0.1.0"
});

function BrowserTimingObserver({ webVitals }) {
  useLogBrewBrowserInstrumentation({
    interactionTiming: {
      interactionPathTemplate: "/checkout"
    },
    traceContext: {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "b7ad6b7169203331"
    },
    webVitals: {
      metricNames: ["LCP", "CLS", "INP"],
      webVitals,
      webVitalPathTemplate: "/checkout"
    }
  });

  return null;
}

export function App({ webVitals }) {
  return React.createElement(
    LogBrewProvider,
    { client },
    React.createElement(BrowserTimingObserver, { webVitals })
  );
}
```

The hook delegates to `@logbrew/browser` for the actual Web Vitals and PerformanceObserver logic. It defaults `flushOnCapture` to `false`, so timing spans join the in-memory SDK queue and are sent only when your app flushes through an app-owned transport. It records route templates and timing fields, not raw element selectors, full URLs, query strings, hashes, headers, payloads, screenshots, or replay data. Pass a stable options object when possible to avoid reinstalling observers during React rerenders.

## React Router Route Spans

Use `useLogBrewReactRouterNavigation()` when a React Router app should capture route changes as low-cardinality spans. The helper stays dependency-free: your app imports `useLocation`, `useNavigationType`, and `matchRoutes` from its own React Router version, then passes route matches or a stable route template into LogBrew.

```js
import React from "react";
import {
  matchRoutes,
  useLocation,
  useNavigationType
} from "react-router";
import {
  useLogBrewReactRouterNavigation
} from "@logbrew/react";

const routes = [
  {
    path: "/projects/:projectId/settings",
    element: React.createElement(ProjectSettings)
  }
];

function LogBrewRouteObserver() {
  const location = useLocation();
  const navigationType = useNavigationType();

  useLogBrewReactRouterNavigation({
    location,
    matchRoutes,
    navigationType,
    routes,
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"
  });

  return null;
}
```

`createReactRouterRouteTemplate(routeMatches)` derives names such as `/projects/:projectId/settings` from React Router matches, matching the route-pattern style developers expect from mature SDKs. It does not record route params, history state, query strings, hashes, headers, bodies, or browser storage values. Use `captureReactRouterNavigation(client, input)` or `createReactRouterNavigationSpanEvent(input)` when you already have route matches outside React hooks.

## Error Boundary

Wrap risky subtrees with `LogBrewErrorBoundary` when you want React render errors to become LogBrew issues and also render a scoped fallback UI. The boundary records React's component stack by default, but JavaScript stack text stays opt-in through `includeStack: true`.

```js
import React from "react";
import {
  LogBrewErrorBoundary,
  LogBrewProvider,
  createLogBrewReactClient
} from "@logbrew/react";

const client = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY"
});

export function App() {
  return React.createElement(
    LogBrewProvider,
    { client },
    React.createElement(
      LogBrewErrorBoundary,
      {
        fallback: ({ error, resetError }) => React.createElement(
          "button",
          { onClick: resetError },
          `Retry after ${error instanceof Error ? error.message : "React error"}`
        ),
        metadata: { section: "checkout" },
        onError: (_error, _info, event) => {
          console.info("captured LogBrew issue", event.id);
        }
      },
      React.createElement(CheckoutButton)
    )
  );
}
```

Use `captureReactError(client, error, options)` for app-owned custom boundaries, event handlers, or async catch blocks. `createReactErrorEvent(error, options)` returns the issue event shape without queueing it, which is useful for previews or custom review screens.

## Trace Propagation

Use `createTraceparentFetch()` when a React app should connect frontend work to backend traces. Propagation is target-scoped by default: no `traceparent` header is attached unless the request URL matches `tracePropagationTargets`.

```js
import {
  createReactTraceparent,
  createTraceparentFetch
} from "@logbrew/react";

const tracedFetch = createTraceparentFetch({
  traceparentFactory: () => createReactTraceparent(),
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

`tracePropagationTargets` accepts strings, regular expressions, or `(url) => boolean` functions. String URL targets apply only to the same origin plus a path prefix, so `https://api.example.com/v1` covers `/v1/orders` on that origin but not `https://wrong.example.com` or `/v10`. Keep targets narrow so React apps do not send tracing headers to unrelated origins. If the API is on another origin, configure that backend's CORS policy to allow the `traceparent` request header.
