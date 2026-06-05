# @logbrew/nestjs

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

When an incoming HTTP request has a valid W3C `traceparent` header, default request capture records the request as a LogBrew `span` that continues the incoming trace. Requests without `traceparent`, or with a malformed header, fall back to the existing request `log` event so bad client headers do not break the controller. Automatic request metadata uses the path without query text by default. Use `captureRequests: false` when a controller should only flush manual events, and use `spanIdFactory` when tests or edge runtimes need deterministic child span IDs.

## Packaged Examples

After install, these commands are available from a consumer app:

```bash
node node_modules/@logbrew/nestjs/examples/index.mjs --help
node node_modules/@logbrew/nestjs/examples/index.mjs --list
node node_modules/@logbrew/nestjs/examples/index.mjs readme-example
node node_modules/@logbrew/nestjs/examples/index.mjs real-user-smoke
node node_modules/@logbrew/nestjs/examples/index.mjs
npm --prefix node_modules/@logbrew/nestjs/examples run help
npm --prefix node_modules/@logbrew/nestjs/examples run list
npm --prefix node_modules/@logbrew/nestjs/examples run readme-example
npm --prefix node_modules/@logbrew/nestjs/examples run real-user-smoke
```

The default launcher path runs `real-user-smoke`.
