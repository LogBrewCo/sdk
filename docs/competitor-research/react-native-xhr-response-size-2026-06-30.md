# React Native XHR Response Size - 2026-06-30

## Target

Improve React Native XHR resource spans so production requests can report
response size even when `Content-Length` is absent, without storing response
content or changing default privacy behavior.

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

## LogBrew Choice

LogBrew now keeps response-size fallback explicit:
`createLogBrewReactNativeInstrumentation(..., { measureXhrResponseBodySize:
true })` measures completed XHR response object byte length only when the
server did not provide `Content-Length`. It handles text/string responses,
`ArrayBuffer`, typed array views, and blob-like `size` values.

The default remains `false`, so existing XHR instrumentation continues to use
headers only. The fallback reads only length-like fields at DONE time and does
not store response content, request bodies, response bodies, arbitrary headers,
cookies, GraphQL payloads, full URLs, baggage, or tracestate.

## Intentionally Not Copied

- No Datadog-style always-on body-derived sizing by default.
- No missing-size sentinel in emitted metadata; unavailable stays absent.
- No response body capture or replay-style request/response side objects.
- No dependency on Apollo, GraphQL, native bridge internals, or hidden module
  patching.

## Remaining Gap

Datadog and Sentry remain ahead for richer automatic network replay and
framework-specific instrumentation. LogBrew is narrower but safer by default:
apps can opt into response-size fallback for owned XHR instrumentation without
expanding captured content.
