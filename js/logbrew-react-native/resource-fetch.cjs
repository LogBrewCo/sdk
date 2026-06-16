"use strict";

const { SdkError } = require("@logbrew/sdk");
const {
  captureReactNativeResourceSpan,
  createReactNativeTraceContext,
  createTraceparentFetch,
  getActiveLogBrewTrace
} = require("./index.cjs");

function createReactNativeResourceFetch(client, {
  appState,
  fetchImpl,
  metadata = {},
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  platform,
  randomValues,
  routeTemplate,
  routeTemplateFactory = defaultRouteTemplateFactory,
  screen,
  sessionId,
  trace,
  traceFlags = "01",
  tracePropagationTargets = []
} = {}) {
  if (routeTemplateFactory !== undefined && typeof routeTemplateFactory !== "function") {
    throw new SdkError("configuration_error", "routeTemplateFactory must be a function");
  }

  return async function logBrewResourceFetch(input, init) {
    const startedAtMs = nowMs();
    const timestamp = now();
    const activeTrace = resourceTraceContext({ randomValues, trace, traceFlags });
    const tracedFetch = createTraceparentFetch({
      fetchImpl,
      trace: activeTrace,
      tracePropagationTargets
    });
    const method = requestMethod(input, init);
    const safeRouteTemplate = routeTemplate ?? routeTemplateFactory({ input, init, url: requestUrl(input) });
    try {
      const response = await tracedFetch(input, init);
      captureReactNativeResourceSpan(client, {
        appState,
        durationMs: elapsedMs(startedAtMs, nowMs),
        metadata,
        method,
        platform,
        routeTemplate: safeRouteTemplate,
        screen,
        sessionId,
        statusCode: responseStatusCode(response),
        timestamp,
        trace: activeTrace
      });
      return response;
    } catch (error) {
      captureReactNativeResourceSpan(client, {
        appState,
        durationMs: elapsedMs(startedAtMs, nowMs),
        metadata: {
          ...metadata,
          fetchErrorName: errorName(error),
          fetchErrorValueType: typeof error
        },
        method,
        platform,
        routeTemplate: safeRouteTemplate,
        screen,
        sessionId,
        status: "error",
        timestamp,
        trace: activeTrace
      });
      throw error;
    }
  };
}

function requestMethod(input, init) {
  const method = init?.method ?? input?.method ?? "GET";
  return String(method).toUpperCase();
}

function resourceTraceContext({ randomValues, trace, traceFlags }) {
  if (typeof trace === "string") {
    return createReactNativeTraceContext({ randomValues, traceFlags, traceparent: trace });
  }
  return trace ?? getActiveLogBrewTrace() ?? createReactNativeTraceContext({ randomValues, traceFlags });
}

function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor === "function" && input instanceof URLConstructor) {
    return input.toString();
  }
  if (typeof input?.url === "string") {
    return input.url;
  }
  return String(input);
}

function defaultRouteTemplateFactory({ url }) {
  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor === "function") {
    try {
      const parsedUrl = new URLConstructor(url, "https://logbrew.local");
      return parsedUrl.pathname;
    } catch {
      // Fall back to query/hash stripping below for non-standard request keys.
    }
  }
  return String(url).split(/[?#]/u, 1)[0];
}

function elapsedMs(startedAtMs, nowMs) {
  const durationMs = nowMs() - startedAtMs;
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : undefined;
}

function responseStatusCode(response) {
  return typeof response?.status === "number" && Number.isFinite(response.status) ? response.status : undefined;
}

function errorName(error) {
  return typeof error?.name === "string" && error.name.trim() !== "" ? error.name : "Error";
}

module.exports = {
  createReactNativeResourceFetch
};
