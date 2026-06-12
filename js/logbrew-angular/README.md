# @logbrew/angular

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

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

For Angular browser apps, prefer a browser-scoped public key through `clientKey`. `apiKey` and `LOGBREW_API_KEY` are still accepted for compatibility with lower-level SDK examples and server-side use.

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

`tracePropagationTargets` accepts strings, regular expressions, or `(url) => boolean` functions. String URL targets apply only to the same origin plus a path prefix, so `https://api.example.com/v1` covers `/v1/orders` on that origin but not `https://wrong.example.com` or `/v10`. Keep targets narrow so Angular does not send tracing headers to unrelated origins. If the API is on another origin, configure that backend's CORS policy to allow the `traceparent` request header.

## Example Source

The package includes example source for the provider, DI helper, view events, error capture, and trace propagation setup. Use the snippets above as the starting point for wiring LogBrew into your Angular application.
