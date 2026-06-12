# @logbrew/next

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

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

By default, successful Route Handler responses are captured after your handler returns. When the incoming `Request` has a valid W3C `traceparent` header, request capture records a LogBrew `span` that continues the incoming trace. Requests without `traceparent`, or with a malformed header, fall back to a request `log` event so bad client headers do not break your route. Use `captureRequests: false` when a route should only flush manual events, use `spanIdFactory` when your runtime needs app-provided child span IDs, and use `onCaptureError` to observe telemetry delivery failures without letting observability own the route response.

Automatic route error events record the method and pathname, but omit query strings by default. Pass `includeSearchParams: true` only when query capture is intentional and safe for the route.

Request metrics are opt-in. Enable `captureRequestMetrics` when you want the route wrapper to emit an explicit `http.server.duration` histogram for completed App Router requests:

```js
export const GET = withLogBrewRouteHandler(handler, {
  serverApiKey: process.env.LOGBREW_SERVER_API_KEY,
  captureRequestMetrics: true,
  routeTemplate: "/api/orders/[id]"
});
```

The metric includes primitive, low-cardinality metadata: `framework`, `method`, `routeTemplate`, `statusCode`, and `statusCodeClass`. Next.js Route Handlers expose standard `Request` and `Response` objects, so pass a stable `routeTemplate` when a route contains dynamic segments. Query strings and hashes are omitted. Avoid user IDs, request payloads, headers, or free-form text in custom metric metadata. Use `metricName`, `metricIdFactory`, or `requestMetricEvent` when your app needs a different naming or metadata policy. Set `captureRequests: false` with `captureRequestMetrics: true` when you only want the duration metric and not the request log/span.

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

## Example Source

The package includes example source for App Router Route Handlers, server-side client creation, and app-owned responses. Use the snippets above as the starting point for wiring LogBrew into your Next.js application.
