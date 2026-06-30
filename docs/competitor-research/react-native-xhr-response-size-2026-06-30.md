# React Native Resource Response Size - 2026-06-30

## Target

Improve React Native resource spans so production requests can report response
size even when `Content-Length` is absent, without storing response content or
changing default privacy behavior.

## Sources Read

- Datadog React Native SDK
  `https://github.com/DataDog/dd-sdk-reactnative` on `develop`
  commit `92462dccefd689815d87dabbad0d41572cd06cca`:
  `packages/core/src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/responseSize.ts`,
  `packages/core/src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/XHRProxy.ts`.
- Sentry React Native SDK
  `https://github.com/getsentry/sentry-react-native` on `main`
  commit `0a147b20978f207cd9af748e8a305690ea5cbfda`:
  `packages/core/src/js/replay/xhrUtils.ts`,
  `packages/core/src/js/replay/networkUtils.ts`.
- Sentry React Native npm package `@sentry/react-native@8.16.0`, tarball
  `https://registry.npmjs.org/@sentry/react-native/-/react-native-8.16.0.tgz`
  from repo `getsentry/sentry-react-native`: `dist/js/replay/networkUtils.js`,
  `dist/js/replay/xhrUtils.js`.
- Datadog React Native npm package `@datadog/mobile-react-native@3.5.2`,
  tarball
  `https://registry.npmjs.org/@datadog/mobile-react-native/-/mobile-react-native-3.5.2.tgz`,
  repo `DataDog/dd-sdk-reactnative` npm `gitHead`
  `92462dccefd689815d87dabbad0d41572cd06cca`:
  `src/rum/DdRum.ts`,
  `src/rum/eventMappers/resourceEventMapper.ts`,
  `src/rum/instrumentation/resourceTracking/DdRumResourceTracking.tsx`,
  `src/rum/instrumentation/resourceTracking/requestProxy/interfaces/RumResource.ts`,
  `src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/DatadogRumResource/ResourceReporter.ts`,
  `src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/DatadogRumResource/resourceTiming.ts`,
  `src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/responseSize.ts`.
- OpenTelemetry targeted source search for official React Native XHR
  instrumentation returned no official package/source file to compare.

## Patterns Observed

- Datadog calculates XHR response size from `Content-Length` first, then falls
  back to body-derived sizing based on `responseType` (`text`, `blob`,
  `arraybuffer`, and approximate JSON stringification). It emits a missing-size
  sentinel when unavailable.
- Sentry's React Native mobile replay XHR enrichment records request and
  response sizes; response size uses `content-length` when present, otherwise
  falls back to a body-size helper. Header/body details are controlled
  separately by URL allow/deny options and `captureBodies`.
- Sentry's shared network helper also prefers `Content-Length`, has bounded body
  sizing helpers, and keeps detailed body/header capture behind explicit
  replay/network-detail controls.
- Datadog reports resource size through `DdRum.stopResource(...)`; its resource
  reporter also adds first-byte/download/fetch timing attributes when response
  start time is available.

## LogBrew Choice

LogBrew now keeps response-size fallback explicit:
`createLogBrewReactNativeInstrumentation(..., { measureXhrResponseBodySize:
true })` measures completed XHR response object byte length only when the
server did not provide `Content-Length`. It handles text/string responses,
`ArrayBuffer`, typed array views, and blob-like `size` values.

2026-06-30 fetch follow-up: `createReactNativeResourceFetch()` and reversible
global fetch instrumentation now record response-start timing when the fetch
promise resolves, while total duration still includes any explicit cloned-body
sizing work. They also record `responseSizeBytes` from `Content-Length` by
default. Apps can set `measureResponseBodySize: true` on the explicit resource
fetch helper, or `measureFetchResponseBodySize: true` on
`createLogBrewReactNativeInstrumentation()`, to measure a cloned fetch response
body when the header is missing. The original response object is returned
untouched, the metadata factory receives only numeric timing/size values, and
response content is not retained.

The default remains `false`, so existing XHR instrumentation continues to use
headers only, while fetch still records header-provided response sizes without
body reads. The fallback reads only length-like fields at DONE time for XHR, or
only a cloned response body for fetch, and does not store response content,
request bodies, response bodies, arbitrary headers, cookies, GraphQL payloads,
full URLs, baggage, or tracestate.

## Intentionally Not Copied

- No Datadog-style always-on body-derived sizing by default.
- No missing-size sentinel in emitted metadata; unavailable stays absent.
- No fetch original-body reads; clone-based sizing is opt-in.
- No response body capture or replay-style request/response side objects.
- No dependency on Apollo, GraphQL, native bridge internals, or hidden module
  patching.

## Remaining Gap

Datadog and Sentry remain ahead for richer automatic network replay, deeper
response phase timings, and framework-specific instrumentation. LogBrew is
narrower but safer by default: apps can opt into response-size fallback and get
fetch response-start timing for owned fetch/XHR instrumentation without
expanding captured content.
