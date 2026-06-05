# @logbrew/angular

Angular providers and DI helpers for the public LogBrew JavaScript SDK.

This package is intentionally thin. It adds Angular `providers`, an injection token, `injectLogBrew()`, view helper events, and optional `ErrorHandler` capture while keeping event validation, retry, flush, and shutdown behavior in `@logbrew/sdk`.

## Install

```bash
npm install @logbrew/sdk @logbrew/angular @angular/core
pnpm add @logbrew/sdk @logbrew/angular @angular/core
```

## Providers

```ts
import { ApplicationConfig } from "@angular/core";
import { RecordingTransport } from "@logbrew/sdk";
import { provideLogBrew } from "@logbrew/angular";

export const appConfig: ApplicationConfig = {
  providers: [
    provideLogBrew({
      clientKey: "LOGBREW_CLIENT_KEY",
      transport: RecordingTransport.alwaysAccept()
    })
  ]
};
```

For Angular browser apps, prefer a browser-scoped public key through `clientKey`. `apiKey` and `LOGBREW_API_KEY` are still accepted for compatibility with lower-level SDK examples and server-side tests.

## Injection

```ts
import { createAngularViewEvent, injectLogBrew } from "@logbrew/angular";

export class DashboardComponent {
  private readonly logbrew = injectLogBrew();

  ngOnInit(): void {
    const event = createAngularViewEvent("Dashboard", {
      path: "/dashboard",
      now: () => new Date().toISOString()
    });
    this.logbrew.client.log(event.id, event.timestamp, event.attributes);
  }
}
```

`provideLogBrew()` installs `LOG_BREW_ANGULAR_CONTEXT` and, by default, an Angular `ErrorHandler` that captures component/application errors. Pass `captureErrors: false` if the app owns error handling elsewhere, or pass `delegateErrorHandler` to keep an existing handler in the loop after telemetry capture.

## Trace Propagation

Use `createTraceparentFetch()` when Angular frontend work should connect to backend traces. Propagation is target-scoped by default: no `traceparent` header is attached unless the request URL matches `tracePropagationTargets`.

```ts
import { createAngularTraceparent, createTraceparentFetch } from "@logbrew/angular";

const tracedFetch = createTraceparentFetch({
  traceparentFactory: () => createAngularTraceparent(),
  tracePropagationTargets: [
    "https://api.example.com/",
    /^\/api\//u
  ]
});

await tracedFetch("/api/cart");
```

`tracePropagationTargets` accepts strings, regular expressions, or `(url) => boolean` functions. Match as narrowly as possible so Angular does not send tracing headers to unrelated origins. If the API is on another origin, configure that backend's CORS policy to allow the `traceparent` request header.

## Packaged Examples

After install, these commands are available from a consumer app:

```bash
node node_modules/@logbrew/angular/examples/index.mjs --help
node node_modules/@logbrew/angular/examples/index.mjs --list
node node_modules/@logbrew/angular/examples/index.mjs readme-example
node node_modules/@logbrew/angular/examples/index.mjs real-user-smoke
node node_modules/@logbrew/angular/examples/index.mjs
npm --prefix node_modules/@logbrew/angular/examples run help
npm --prefix node_modules/@logbrew/angular/examples run list
npm --prefix node_modules/@logbrew/angular/examples run readme-example
npm --prefix node_modules/@logbrew/angular/examples run real-user-smoke
```

The default launcher path runs `real-user-smoke`.
