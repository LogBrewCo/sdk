# @logbrew/next

Next.js App Router helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It creates server-side LogBrew clients, wraps App Router Route Handlers, captures successful route requests and thrown route errors, and still keeps manual event creation available through the route helpers.

## Install

```bash
npm install @logbrew/sdk @logbrew/next next react react-dom
pnpm add @logbrew/sdk @logbrew/next next react react-dom
```

## App Router Route Handler

```js
// app/api/logbrew/route.js
import { RecordingTransport } from "@logbrew/sdk";
import { withLogBrewRouteHandler } from "@logbrew/next";

export const runtime = "nodejs";

export const POST = withLogBrewRouteHandler(
  async (_request, _context, { client }) => {
    client.log("evt_log_001", "2026-06-02T10:00:03Z", {
      message: "worker started",
      level: "info",
      logger: "job-runner"
    });

    return Response.json(JSON.parse(client.previewJson()));
  },
  {
    serverApiKey: "LOGBREW_SERVER_API_KEY",
    spanIdFactory: () => "b7ad6b7169203331",
    transport: RecordingTransport.alwaysAccept()
  }
);
```

Use `serverApiKey` directly for local server examples, or set `LOGBREW_SERVER_API_KEY` in your server environment and omit it. `apiKey` and `LOGBREW_API_KEY` are still accepted for compatibility with lower-level SDK examples, but Next.js Route Handlers should use server-side keys only. Use the Browser, React, Vue, Svelte, Angular, or React Native packages for frontend `clientKey` setup.

By default, successful Route Handler responses are captured after your handler returns. When the incoming `Request` has a valid W3C `traceparent` header, request capture records a LogBrew `span` that continues the incoming trace. Requests without `traceparent`, or with a malformed header, fall back to a request `log` event so bad client headers do not break your route. Use `captureRequests: false` when a route should only flush manual events, use `spanIdFactory` when tests or edge runtimes need deterministic child span IDs, and use `onCaptureError` to observe telemetry delivery failures without letting observability own the route response.

Automatic route error events record the method and pathname, but omit query strings by default. Pass `includeSearchParams: true` only when query capture is intentional and safe for the route.

The wrapper expects App Router Route Handlers that return standard `Response` objects. It does not call `NextResponse.next()` and does not use the deprecated `middleware` filename. For Next.js 16 request interception, use the framework's `proxy.js` convention separately and keep LogBrew event creation in server-side route code.

## Client Helper

```js
import { createLogBrewNextClient } from "@logbrew/next";

const client = createLogBrewNextClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "my-next-app",
  sdkVersion: "0.1.0"
});
```

## Packaged Examples

After install, these commands are available from a consumer app:

```bash
node node_modules/@logbrew/next/examples/index.mjs --help
node node_modules/@logbrew/next/examples/index.mjs --list
node node_modules/@logbrew/next/examples/index.mjs readme-example
node node_modules/@logbrew/next/examples/index.mjs real-user-smoke
node node_modules/@logbrew/next/examples/index.mjs
npm --prefix node_modules/@logbrew/next/examples run help
npm --prefix node_modules/@logbrew/next/examples run list
npm --prefix node_modules/@logbrew/next/examples run readme-example
npm --prefix node_modules/@logbrew/next/examples run real-user-smoke
```

The default launcher path runs `real-user-smoke`.
