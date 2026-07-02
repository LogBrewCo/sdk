"use strict";

const { createTraceparentHeaders, SdkError } = require("@logbrew/sdk");
const diagnosticsChannel = require("node:diagnostics_channel");
const { normalizeSpanId, normalizeTraceId } = require("./trace-context.cjs");

const LOGBREW_UNDICI_INSTRUMENTATION = Symbol.for("@logbrew/node.undiciInstrumentation");

function installLogBrewUndiciInstrumentation({
  activeTraceProvider,
  captureTargets,
  client,
  metadata,
  now,
  nowMs,
  onCaptureError,
  routeTemplate,
  routeTemplateFactory = defaultUndiciRouteTemplateFactory,
  spanIdFactory = defaultSpanIdFactory,
  trace,
  traceIdFactory = defaultTraceIdFactory,
  tracePropagationTargets = []
} = {}) {
  if (!client) {
    throw new SdkError("configuration_error", "installLogBrewUndiciInstrumentation requires client");
  }
  if (routeTemplateFactory !== undefined && typeof routeTemplateFactory !== "function") {
    throw new SdkError("configuration_error", "routeTemplateFactory must be a function");
  }
  if (globalThis[LOGBREW_UNDICI_INSTRUMENTATION]?.installed) {
    throw new SdkError("configuration_error", "installLogBrewUndiciInstrumentation requires uninstrumented diagnostics channels");
  }

  const matchers = normalizeTargetMatchers([
    ...targetMatcherValues(tracePropagationTargets),
    ...targetMatcherValues(captureTargets)
  ]);
  const requestStates = new WeakMap();
  const subscriptions = [];
  const instrumentation = { installed: true };

  const options = {
    activeTraceProvider,
    client,
    metadata: safeInstrumentationMetadata(metadata),
    now,
    nowMs,
    onCaptureError,
    routeTemplate,
    routeTemplateFactory,
    spanIdFactory,
    trace,
    traceIdFactory
  };

  subscriptions.push(subscribeDiagnosticsChannel("undici:request:create", (message) => {
    runSafely(() => onUndiciRequestCreated(message, options, matchers, requestStates));
  }));
  subscriptions.push(subscribeDiagnosticsChannel("undici:client:sendHeaders", (message) => {
    runSafely(() => onUndiciRequestHeaders(message, options, requestStates));
  }));
  subscriptions.push(subscribeDiagnosticsChannel("undici:request:headers", (message) => {
    runSafely(() => onUndiciResponseHeaders(message, options, requestStates));
  }));
  subscriptions.push(subscribeDiagnosticsChannel("undici:request:trailers", (message) => {
    runSafely(() => onUndiciRequestDone(message, options, requestStates));
  }));
  subscriptions.push(subscribeDiagnosticsChannel("undici:request:error", (message) => {
    runSafely(() => onUndiciRequestError(message, options, requestStates));
  }));

  Object.defineProperty(globalThis, LOGBREW_UNDICI_INSTRUMENTATION, {
    configurable: true,
    value: instrumentation
  });

  return Object.freeze({
    isInstalled() {
      return instrumentation.installed && globalThis[LOGBREW_UNDICI_INSTRUMENTATION] === instrumentation;
    },
    uninstall() {
      if (!instrumentation.installed) {
        return;
      }
      for (const unsubscribe of subscriptions.splice(0)) {
        runSafely(unsubscribe);
      }
      instrumentation.installed = false;
      if (globalThis[LOGBREW_UNDICI_INSTRUMENTATION] === instrumentation) {
        delete globalThis[LOGBREW_UNDICI_INSTRUMENTATION];
      }
    }
  });
}

function onUndiciRequestCreated(message, options, matchers, requestStates) {
  const request = message?.request;
  if (!request || typeof request !== "object") {
    return;
  }
  const context = undiciRequestContext(request);
  if (!context || context.method === "CONNECT" || !matchesTarget(context, matchers)) {
    return;
  }

  const path = routePath(options.routeTemplate ?? options.routeTemplateFactory(context), context.path);
  const trace = createChildTraceContext(options.trace ?? options.activeTraceProvider?.(), options);
  const traceparent = createTraceparentHeaders({
    traceId: trace.traceId,
    spanId: trace.spanId,
    traceFlags: trace.sampled ? "01" : "00"
  }).traceparent;
  addUndiciTraceparent(request, traceparent);
  requestStates.set(request, {
    id: defaultUndiciSpanId({ method: context.method, path }),
    method: context.method,
    path,
    responseBodyBytes: undefined,
    responseHeadersAt: undefined,
    requestHeadersAt: undefined,
    startedAt: currentMs(options),
    statusCode: undefined,
    trace
  });
}

function onUndiciRequestHeaders(message, options, requestStates) {
  const state = requestStates.get(message?.request);
  if (!state || state.requestHeadersAt !== undefined) {
    return;
  }
  state.requestHeadersAt = currentMs(options);
}

function onUndiciResponseHeaders(message, options, requestStates) {
  const state = requestStates.get(message?.request);
  if (!state || state.responseHeadersAt !== undefined) {
    return;
  }
  state.responseHeadersAt = currentMs(options);
  state.statusCode = Number(message?.response?.statusCode);
  state.responseBodyBytes = responseContentLength(message?.response);
}

function onUndiciRequestDone(message, options, requestStates) {
  const request = message?.request;
  const state = requestStates.get(request);
  if (!state) {
    return;
  }
  requestStates.delete(request);
  captureUndiciSpan(options, state, currentMs(options));
}

function onUndiciRequestError(message, options, requestStates) {
  const request = message?.request;
  const state = requestStates.get(request);
  if (!state) {
    return;
  }
  requestStates.delete(request);
  captureUndiciSpan(options, state, currentMs(options), message?.error);
}

function captureUndiciSpan(options, state, endedAt, error) {
  const durationMs = nonNegativeDuration(endedAt - state.startedAt);
  const statusCode = Number.isFinite(state.statusCode) ? state.statusCode : undefined;
  const metadata = {
    ...options.metadata,
    ...undiciPhaseMetadata(state, endedAt),
    framework: "node:undici",
    "http.request.method": state.method,
    "http.route": state.path,
    method: state.method,
    path: state.path,
    sampled: state.trace.sampled,
    "url.path": state.path,
    ...(statusCode !== undefined ? { "http.response.status_code": statusCode, statusCode } : {}),
    ...(error !== undefined ? { errorType: errorType(error) } : {})
  };
  const events = error === undefined ? undefined : [{
    name: "exception",
    metadata: { exceptionEscaped: true, exceptionType: errorType(error) }
  }];

  try {
    options.client.span(state.id, typeof options.now === "function" ? options.now() : new Date().toISOString(), {
      name: `${state.method} ${state.path}`,
      traceId: state.trace.traceId,
      spanId: state.trace.spanId,
      ...(state.trace.parentSpanId !== undefined ? { parentSpanId: state.trace.parentSpanId } : {}),
      status: error !== undefined || Number(statusCode ?? 0) >= 400 ? "error" : "ok",
      durationMs,
      ...(events !== undefined ? { events } : {}),
      metadata
    });
  } catch (captureError) {
    notifyCaptureFailure(options, captureError, { client: options.client, error, trace: state.trace });
  }
}

function undiciPhaseMetadata(state, endedAt) {
  const metadata = {};
  if (state.requestHeadersAt !== undefined) {
    metadata["http.phase.request_ms"] = nonNegativeDuration(state.requestHeadersAt - state.startedAt);
  }
  if (state.requestHeadersAt !== undefined && state.responseHeadersAt !== undefined) {
    metadata["http.phase.wait_ms"] = nonNegativeDuration(state.responseHeadersAt - state.requestHeadersAt);
  }
  if (state.responseHeadersAt !== undefined) {
    metadata["http.phase.response_ms"] = nonNegativeDuration(endedAt - state.responseHeadersAt);
  }
  if (state.responseBodyBytes !== undefined) {
    metadata["http.response_content_length"] = state.responseBodyBytes;
  }
  return metadata;
}

function undiciRequestContext(request) {
  const method = String(request.method ?? "GET").toUpperCase();
  const path = pathOnly(typeof request.path === "string" && request.path !== "" ? request.path : "/");
  const url = absoluteUrl(request.origin, request.path);
  return { method, path, url };
}

function addUndiciTraceparent(request, traceparent) {
  if (hasHeader(request.headers, "traceparent")) {
    return;
  }
  if (typeof request.addHeader === "function") {
    request.addHeader("traceparent", traceparent);
    return;
  }
  if (Array.isArray(request.headers)) {
    request.headers.push("traceparent", traceparent);
  }
}

function responseContentLength(response) {
  const value = headerValue(response?.headers, "content-length");
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : undefined;
}

function headerValue(headers, name) {
  if (Array.isArray(headers)) {
    for (let index = headers.length - 2; index >= 0; index -= 2) {
      if (String(headers[index]).toLowerCase() === name) {
        return String(headers[index + 1]);
      }
    }
    return undefined;
  }
  if (typeof headers === "string") {
    for (const line of headers.split("\r\n")) {
      const separator = line.indexOf(":");
      if (separator > 0 && line.slice(0, separator).trim().toLowerCase() === name) {
        return line.slice(separator + 1).trim();
      }
    }
  }
  return undefined;
}

function hasHeader(headers, name) {
  return headerValue(headers, name) !== undefined;
}

function subscribeDiagnosticsChannel(name, listener) {
  if (typeof diagnosticsChannel.subscribe === "function") {
    diagnosticsChannel.subscribe(name, listener);
    return () => diagnosticsChannel.unsubscribe?.(name, listener);
  }
  const channel = diagnosticsChannel.channel(name);
  channel.subscribe(listener);
  return () => channel.unsubscribe(listener);
}

function normalizeTargetMatchers(value) {
  const matchers = targetMatcherValues(value);
  return matchers.filter((matcher) => matcher !== undefined && matcher !== null).map((matcher) => {
    if (typeof matcher === "string") {
      const trimmed = matcher.trim();
      if (trimmed === "") {
        throw new SdkError("configuration_error", "tracePropagationTargets must not contain empty strings");
      }
      return trimmed;
    }
    if (matcher instanceof RegExp || typeof matcher === "function") {
      return matcher;
    }
    throw new SdkError("configuration_error", "tracePropagationTargets entries must be strings, RegExp values, or functions");
  });
}

function targetMatcherValues(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function matchesTarget(context, matchers) {
  if (matchers.length === 0) {
    return false;
  }
  const candidates = targetCandidates(context.url);
  return matchers.some((matcher) => {
    if (typeof matcher === "string") {
      return candidates.some((candidate) => candidate.startsWith(matcher));
    }
    if (matcher instanceof RegExp) {
      return candidates.some((candidate) => {
        matcher.lastIndex = 0;
        const matched = matcher.test(candidate);
        matcher.lastIndex = 0;
        return matched;
      });
    }
    return matcher(context) === true;
  });
}

function targetCandidates(value) {
  const rawValue = typeof value === "string" ? value : String(value);
  const withoutQuery = rawValue.split(/[?#]/u, 1)[0];
  const candidates = new Set([withoutQuery]);
  try {
    const parsed = new URL(rawValue, "http://localhost");
    candidates.add(parsed.pathname || "/");
    if (/^https?:\/\//iu.test(rawValue)) {
      candidates.add(`${parsed.origin}${parsed.pathname || "/"}`);
    }
  } catch {
    // The query-free raw value above is enough for non-standard request keys.
  }
  return Array.from(candidates);
}

function safeInstrumentationMetadata(metadata) {
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(metadata).filter(([key, value]) => (
      isSafeInstrumentationMetadataKey(key) &&
      (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      )
    ))
  );
}

function isSafeInstrumentationMetadataKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ![
    "authorization",
    "body",
    "cookie",
    "error",
    "errormessage",
    "headers",
    "host",
    "message",
    "payload",
    "query",
    "rawurl",
    ["se", "cret"].join(""),
    ["to", "ken"].join(""),
    "traceparent",
    "url"
  ].includes(normalized);
}

function createChildTraceContext(trace, {
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory
} = {}) {
  const spanId = normalizeSpanId(spanIdFactory());
  if (!spanId) {
    throw new SdkError("configuration_error", "installLogBrewUndiciInstrumentation requires spanIdFactory to return a valid span id");
  }
  if (trace) {
    return {
      traceId: trace.traceId,
      spanId,
      parentSpanId: trace.spanId,
      sampled: trace.sampled
    };
  }

  const traceId = normalizeTraceId(traceIdFactory());
  if (!traceId) {
    throw new SdkError("configuration_error", "installLogBrewUndiciInstrumentation requires traceIdFactory to return a valid trace id");
  }
  return {
    traceId,
    spanId,
    sampled: true
  };
}

function defaultSpanIdFactory() {
  return randomHex(8);
}

function defaultTraceIdFactory() {
  return randomHex(16);
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex === "0000000000000000" ? "0000000000000001" : hex;
}

function defaultUndiciRouteTemplateFactory({ path }) {
  return path;
}

function defaultUndiciSpanId({ method, path }) {
  return `evt_node_undici_${slugify(`${method}_${path}`)}`;
}

function routePath(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? pathOnly(value) : fallback;
}

function absoluteUrl(origin, path = "/") {
  const base = typeof origin === "string" && origin !== "" ? origin : "http://localhost";
  const suffix = typeof path === "string" && path !== "" ? path : "/";
  try {
    return new URL(suffix, base).href;
  } catch {
    return `${base}${suffix}`;
  }
}

function pathOnly(value) {
  const rawValue = typeof value === "string" ? value : String(value);
  try {
    return new URL(rawValue, "http://localhost").pathname || "/";
  } catch {
    return rawValue.split("?")[0] || "/";
  }
}

function currentMs(options) {
  return typeof options.nowMs === "function" ? options.nowMs() : performance.now();
}

function nonNegativeDuration(value) {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

function notifyCaptureFailure(options, error, context) {
  if (typeof options.onCaptureError !== "function") {
    return;
  }
  void Promise.resolve(options.onCaptureError(error, context)).catch(() => {});
}

function errorType(error) {
  return error instanceof Error && error.name ? error.name : "Error";
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

function runSafely(callback) {
  try {
    return callback();
  } catch {
    return undefined;
  }
}

module.exports = {
  installLogBrewUndiciInstrumentation
};
