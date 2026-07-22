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

## Release Artifacts

For production Next.js builds, wrap `next.config.mjs` with the build-time release-artifact helper. It enables `productionBrowserSourceMaps` only when your config has not chosen a value, runs after the production compile, injects matching Debug IDs, strips embedded source text by default, writes a privacy-bounded manifest next to `.next`, and can upload the prepared artifacts before the build completes:

```js
// next.config.mjs
import { withLogBrewNextReleaseArtifacts } from "@logbrew/next/release-artifacts";

export default withLogBrewNextReleaseArtifacts(
  {
    turbopack: {}
  },
  {
    release: "2026.06.18",
    environment: "production",
    service: "checkout-next-web",
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    upload: {
      endpoint: "https://api.logbrew.com/api/release-artifacts",
      allowHostedUpload: true,
      maxRetries: 2
    }
  }
);
```

The helper defaults minified URLs to `app:///_next/static/chunks/...`. Use `minifiedPathPrefix`, `manifestPath`, `repositoryUrl`, `commitSha`, or `stripSourcePrefix` when your deploy needs explicit paths or source-link metadata. Set `LOGBREW_RELEASE_ARTIFACT_TOKEN` in the build environment to a dedicated release-artifact token. Use `tokenEnv` for a different CI variable, or `dryRun: true` to prepare the complete build output without a network request. Existing `compiler.runAfterProductionCompile` work runs first. Upload is disabled when `upload` is omitted, and any unsafe preparation or upload result fails the production build without exposing response text or secret values.

## App Router Route Handler

```js
// app/api/logbrew/route.js
import { RecordingTransport } from "@logbrew/sdk";
import { getActiveLogBrewTrace, withLogBrewRouteHandler } from "@logbrew/next";

export const runtime = "nodejs";

export const POST = withLogBrewRouteHandler(
  async (_request, _context, { client, trace }) => {
    const activeTrace = trace ?? getActiveLogBrewTrace();

    client.log("evt_log_001", "2026-06-02T10:00:03Z", {
      message: "worker started",
      level: "info",
      logger: "job-runner",
      ...(activeTrace
        ? { metadata: { traceId: activeTrace.traceId, spanId: activeTrace.spanId } }
        : {})
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

By default, successful Route Handler responses are captured after your handler returns. When the incoming `Request` has a valid W3C `traceparent` header, the wrapper exposes a normalized trace object through `helpers.trace` and `getActiveLogBrewTrace()`, then records the request as a LogBrew `span` that continues the incoming trace. Use that same `traceId` and `spanId` in app-owned logs, product actions, or custom event callbacks when you want route-level debugging correlation. Requests without `traceparent`, or with a malformed header, fall back to a request `log` event so bad client headers do not break your route. Use `captureRequests: false` when a route should only flush manual events, use `spanIdFactory` when your runtime needs app-provided child span IDs, and use `onCaptureError` to observe telemetry delivery failures without letting observability own the route response.

The public trace helper only includes normalized W3C IDs plus sampled state: `traceId`, `spanId`, `parentSpanId`, and `sampled`. It does not expose the raw `traceparent` header, request headers, request bodies, cookies, or query strings.

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

## Client Route Spans

Use the browser-safe `@logbrew/next/client` subpath from client components. It has no `node:` imports and uses `clientKey` wording for browser setup:

```jsx
"use client";

import { usePathname } from "next/navigation";
import {
  createLogBrewNextBrowserClient,
  useLogBrewNextNavigation
} from "@logbrew/next/client";

const client = createLogBrewNextBrowserClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "my-next-app",
  sdkVersion: "0.1.0"
});

const routePatterns = [
  "/",
  "/projects/[projectId]/settings",
  "/docs/[[...slug]]"
];

export function LogBrewNextNavigationSpans({ traceparent }) {
  const pathname = usePathname();

  useLogBrewNextNavigation({
    client,
    pathname,
    routePatterns,
    traceparent
  });

  return null;
}
```

`useLogBrewNextNavigation` records one `next.route <routeTemplate>` span when `pathname` changes to a route that matches one of your stable `routePatterns`. Use `createNextRouteTemplate` directly when you want to preview how a concrete `pathname` maps to `/projects/[projectId]/settings`, `[...catchAll]`, `[[...optionalCatchAll]]`, or a route-group pattern such as `/(app)/dashboard/[teamId]`.

The client helper requires explicit W3C trace context through `traceparent` or `traceId` plus `spanId`. It does not patch `fetch`, `XMLHttpRequest`, browser history, or the Next router. It never records the concrete pathname, query string, hash, headers, cookies, request body, or raw `traceparent` value. If a pathname cannot be matched to a stable route template, it skips the span instead of emitting a high-cardinality URL. Metadata is primitive-only.

Use `captureNextNavigation(client, input)` when you want to emit a route span from app-owned navigation callbacks instead of the React hook.

## Server Client Helper

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
