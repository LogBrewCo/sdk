# @logbrew/react

React helpers for the public LogBrew JavaScript SDK.

## Install

```bash
npm install @logbrew/sdk @logbrew/react react
pnpm add @logbrew/sdk @logbrew/react react
```

The package ships plain ESM and CommonJS entrypoints, `.d.ts` and `.d.cts` declarations, a `LogBrewProvider`, `LogBrewErrorBoundary`, `useLogBrew`, `useLogBrewActions`, `createLogBrewReactClient`, handled React error helpers, and explicit W3C trace propagation helpers for frontend-to-backend fetch calls. It keeps `@logbrew/sdk` and `react` as peer dependencies so app owners control their React/runtime versions.

## Example

```js
import React from "react";
import { LogBrewProvider, createLogBrewReactClient, useLogBrewActions } from "@logbrew/react";

const client = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react",
  sdkVersion: "0.1.0"
});

function CheckoutButton() {
  const logbrew = useLogBrewActions();

  function onClick() {
    logbrew.action("evt_action_001", new Date().toISOString(), {
      name: "checkout-click",
      status: "success"
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

`tracePropagationTargets` accepts strings, regular expressions, or `(url) => boolean` functions. Match narrowly so React apps do not send tracing headers to unrelated origins. If the API is on another origin, configure that backend's CORS policy to allow the `traceparent` request header.
