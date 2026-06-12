# @logbrew/nestjs

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-espresso-bg-512.png" alt="LogBrew logo" width="96" height="96">
</p>

NestJS interceptor helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It adds NestJS HTTP interceptor UX while keeping event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`.

## Install

```bash
npm install @logbrew/sdk @logbrew/nestjs @nestjs/common @nestjs/core @nestjs/platform-express reflect-metadata rxjs
pnpm add @logbrew/sdk @logbrew/nestjs @nestjs/common @nestjs/core @nestjs/platform-express reflect-metadata rxjs
```

## Global Interceptor

```ts
import { NestFactory } from "@nestjs/core";
import { RecordingTransport } from "@logbrew/sdk";
import { LogBrewInterceptor } from "@logbrew/nestjs";
import { AppModule } from "./app.module";

const app = await NestFactory.create(AppModule);

app.useGlobalInterceptors(new LogBrewInterceptor({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  spanIdFactory: () => "b7ad6b7169203331",
  transport: RecordingTransport.alwaysAccept()
}));

await app.listen(3000);
```

Inside a controller, the Express request object exposes `request.logbrew`:

```ts
import { Controller, Get, Req } from "@nestjs/common";
import type { Request } from "express";

@Controller()
export class AppController {
  @Get("/health")
  health(@Req() request: Request) {
    request.logbrew?.client.log("evt_log_001", "2026-06-02T10:00:03Z", {
      message: "health check reached",
      level: "info",
      logger: "nestjs"
    });
    return { ok: true };
  }
}
```

The interceptor uses Nest's HTTP `ExecutionContext`, adds `request.logbrew` before the route handler runs, captures successful request completion, and captures thrown route errors with RxJS `catchError` before rethrowing them to Nest's normal exception handling path.

Use `serverApiKey` directly for local server examples, or set `LOGBREW_SERVER_API_KEY` in your server environment and omit it. `apiKey` and `LOGBREW_API_KEY` are still accepted for compatibility with the lower-level JavaScript SDK.

When an incoming HTTP request has a valid W3C `traceparent` header, default request capture records the request as a LogBrew `span` that continues the incoming trace. Requests without `traceparent`, or with a malformed header, fall back to the existing request `log` event so bad client headers do not break the controller. Automatic request metadata uses the path without query text by default. Use `captureRequests: false` when a controller should only flush manual events, and use `spanIdFactory` when your runtime needs app-provided child span IDs.

## Request Duration Metrics

Enable request metrics when you want low-cardinality latency histograms from NestJS routes without changing controller behavior:

```ts
app.useGlobalInterceptors(new LogBrewInterceptor({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  captureRequestMetrics: true
}));
```

This emits an explicit `http.server.duration` histogram with primitive metadata for `framework`, `method`, `routeTemplate`, `statusCode`, and `statusCodeClass`. Route templates are preferred when Nest exposes them through the underlying HTTP adapter, and query strings or hashes are omitted by default. Use `captureRequests: false` with `captureRequestMetrics: true` when you only want request metrics.

## Packaged Examples

The package includes example source for the interceptor, controller access, and app-owned response handling. Use the snippets above as the starting point for wiring LogBrew into your NestJS application.
