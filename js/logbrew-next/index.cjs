const { AsyncLocalStorage } = require("node:async_hooks");
const {
  LogBrewClient,
  RecordingTransport,
  SdkError,
  parseTraceparent
} = require("@logbrew/sdk");

const DEFAULT_SDK_NAME = "logbrew-next";
const DEFAULT_SDK_VERSION = "0.1.0";
const activeTraceContext = new AsyncLocalStorage();

function createLogBrewNextClient({
  apiKey,
  serverApiKey,
  sdkName = DEFAULT_SDK_NAME,
  sdkVersion = DEFAULT_SDK_VERSION,
  maxRetries = 2
} = {}) {
  const authKey = serverApiKey ?? apiKey ?? readEnvServerApiKey() ?? readEnvApiKey();
  if (!authKey) {
    throw new SdkError(
      "configuration_error",
      "createLogBrewNextClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
    );
  }
  return LogBrewClient.create({ apiKey: authKey, sdkName, sdkVersion, maxRetries });
}

function withLogBrewRouteHandler(handler, options = {}) {
  if (typeof handler !== "function") {
    throw new SdkError("configuration_error", "withLogBrewRouteHandler requires a handler function");
  }

  return async function logBrewRouteHandler(request, context = {}) {
    const client = resolveClient(options, request, context);
    const transport = resolveTransport(options, request, context, client);
    const trace = createRouteTraceContext(request, undefined, options);
    const helpers = createRouteHelpers(client, transport, trace);
    const startedAt = nowMs(options);

    return activeTraceContext.run(trace, async () => {
      try {
        const response = await handler(request, context, helpers);
        ensureResponse(response);
        await captureRouteSuccess(options, { request, response, context, client, transport, startedAt, trace });
        return response;
      } catch (error) {
        await recordRouteError(options, error, { request, context, client, transport, trace });
        throw error;
      }
    });
  };
}

function getActiveLogBrewTrace() {
  return activeTraceContext.getStore();
}

function createRouteRequestEvent(request, response, {
  now = () => new Date().toISOString(),
  durationMs = 0,
  idFactory = defaultRouteRequestId,
  spanIdFactory = defaultSpanIdFactory,
  trace
} = {}) {
  const url = safeUrl(request);
  const method = request?.method ?? "GET";
  const statusCode = Number(response?.status ?? 0);
  const id = idFactory(request, response);
  const routeTrace = trace ?? getActiveLogBrewTrace() ?? createRouteTraceContext(request, response, { spanIdFactory });
  const spanEvent = routeTrace
    ? createTraceparentRouteSpan(routeTrace, {
      durationMs,
      id,
      method,
      now,
      pathname: url.pathname,
      statusCode
    })
    : undefined;
  if (spanEvent) {
    return spanEvent;
  }

  return {
    id,
    timestamp: now(),
    attributes: {
      message: `${method} ${url.pathname} ${statusCode}`,
      level: statusCode >= 500 ? "error" : "info",
      logger: "next",
      metadata: {
        framework: "nextjs",
        method,
        pathname: url.pathname,
        statusCode,
        durationMs
      }
    }
  };
}

function createRouteErrorEvent(error, request, {
  includeSearchParams = false,
  now = () => new Date().toISOString(),
  idFactory = defaultRouteErrorId,
  trace
} = {}) {
  const url = safeUrl(request);
  const method = request?.method ?? "GET";
  const message = error instanceof Error ? error.message : String(error);
  const routeTrace = trace ?? getActiveLogBrewTrace();
  return {
    id: idFactory(request),
    timestamp: now(),
    attributes: {
      title: `${method} ${url.pathname} failed`,
      level: "error",
      message,
      metadata: {
        method,
        pathname: url.pathname,
        ...(includeSearchParams ? { search: url.search || null } : {}),
        ...traceMetadata(routeTrace)
      }
    }
  };
}

function createRequestMetricEvent(request, response, {
  now = () => new Date().toISOString(),
  durationMs = 0,
  idFactory = defaultRouteMetricId,
  metricName = "http.server.duration",
  routeTemplate
} = {}) {
  const method = request?.method ?? "GET";
  const resolvedRouteTemplate = routeTemplateOnly(routeTemplate ?? safeUrl(request).pathname);
  const statusCode = Number(response?.status ?? 0);
  return {
    id: idFactory(request, response, resolvedRouteTemplate),
    timestamp: now(),
    attributes: {
      name: metricName,
      kind: "histogram",
      value: Math.max(0, Number(durationMs)),
      unit: "ms",
      temporality: "delta",
      metadata: {
        framework: "nextjs",
        method,
        routeTemplate: resolvedRouteTemplate,
        statusCode,
        statusCodeClass: statusCodeClass(statusCode)
      }
    }
  };
}

function resolveClient(options, request, context) {
  if (typeof options.client === "function") {
    return options.client({ request, context });
  }
  if (options.client) {
    return options.client;
  }
  return createLogBrewNextClient(options);
}

function resolveTransport(options, request, context, client) {
  if (typeof options.transport === "function") {
    return options.transport({ request, context, client });
  }
  return options.transport ?? RecordingTransport.alwaysAccept();
}

function createRouteHelpers(client, transport, trace) {
  return {
    client,
    logbrew: client,
    trace,
    previewJson: () => client.previewJson(),
    flush: () => client.flush(transport),
    shutdown: () => client.shutdown(transport)
  };
}

function ensureResponse(response) {
  if (!(response instanceof Response)) {
    throw new SdkError("route_handler_error", "Next.js route handler must return a Response");
  }
}

async function notifyFlush(options, flushResponse, context) {
  if (typeof options.onFlush === "function") {
    await options.onFlush(flushResponse, context);
  }
}

async function notifyFailure(options, error, context) {
  if (typeof options.onCaptureError === "function") {
    await options.onCaptureError(error, context);
  }
}

async function captureRouteSuccess(options, { request, response, context, client, transport, startedAt, trace }) {
  try {
    const durationMs = (options.captureRequests !== false || options.captureRequestMetrics === true)
      ? routeDurationMs(options, startedAt)
      : 0;
    if (options.captureRequests !== false) {
      recordRouteRequest(options, { request, response, context, client, durationMs, trace });
    }
    if (options.captureRequestMetrics === true) {
      recordRouteMetric(options, { request, response, context, client, durationMs, trace });
    }
    const flushResponse = await client.shutdown(transport);
    await notifyFlush(options, flushResponse, { request, context, client, trace });
  } catch (error) {
    await notifyFailure(options, error, { request, context, client, trace });
  }
}

function recordRouteRequest(options, { request, response, context, client, durationMs, trace }) {
  const event = typeof options.requestEvent === "function"
    ? options.requestEvent(request, response, { client, context, durationMs, request, response, trace })
    : createRouteRequestEvent(request, response, {
      ...options,
      durationMs,
      idFactory: options.requestIdFactory,
      trace
    });
  captureRouteRequestEvent(client, event);
}

function recordRouteMetric(options, { request, response, context, client, durationMs, trace }) {
  const routeTemplate = resolveRouteTemplate(options, request, context);
  const event = typeof options.requestMetricEvent === "function"
    ? options.requestMetricEvent(request, response, { client, context, durationMs, request, response, trace })
    : createRequestMetricEvent(request, response, {
      ...options,
      durationMs,
      idFactory: options.metricIdFactory,
      routeTemplate
    });
  captureRouteMetricEvent(client, event);
}

async function recordRouteError(options, error, { request, context, client, transport, trace }) {
  if (options.captureErrors === false) {
    return;
  }
  const routeTrace = trace ?? getActiveLogBrewTrace();
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, { request, context, client, trace: routeTrace })
    : createRouteErrorEvent(error, request, { ...options, trace: routeTrace });
  try {
    client.issue(event.id, event.timestamp, event.attributes);
    const flushResponse = await client.shutdown(transport);
    await notifyFlush(options, flushResponse, { request, context, client, trace: routeTrace });
  } catch (captureError) {
    await notifyFailure(options, captureError, { request, context, client, trace: routeTrace });
  }
}

function captureRouteRequestEvent(client, event) {
  if (event.type === "span") {
    client.span(event.id, event.timestamp, event.attributes);
    return;
  }
  client.log(event.id, event.timestamp, event.attributes);
}

function captureRouteMetricEvent(client, event) {
  client.metric(event.id, event.timestamp, event.attributes);
}

function defaultRouteRequestId(request, response) {
  const url = safeUrl(request);
  const slug = `${request?.method ?? "GET"}-${url.pathname}-${response?.status ?? 0}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `evt_next_request_${slug || "route"}`;
}

function defaultSpanIdFactory() {
  return randomHex(8);
}

function defaultRouteErrorId(request) {
  const url = safeUrl(request);
  const slug = `${request?.method ?? "GET"}-${url.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `evt_next_error_${slug || "route"}`;
}

function defaultRouteMetricId(request, response, routeTemplate = safeUrl(request).pathname) {
  const sanitizedRouteTemplate = routeTemplateOnly(routeTemplate);
  const slug = `${request?.method ?? "GET"}-${sanitizedRouteTemplate}-${response?.status ?? 0}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `evt_next_metric_${slug || "route"}`;
}

function safeUrl(request) {
  try {
    return new URL(request?.url ?? "http://localhost/");
  } catch {
    return new URL("http://localhost/");
  }
}

function getTraceparentHeader(request) {
  if (!request?.headers || typeof request.headers.get !== "function") {
    return undefined;
  }
  const value = request.headers.get("traceparent");
  return typeof value === "string" ? value : undefined;
}

function resolveRouteTemplate(options, request, context) {
  const value = typeof options.routeTemplate === "function"
    ? options.routeTemplate(request, context)
    : options.routeTemplate;
  return routeTemplateOnly(value ?? safeUrl(request).pathname);
}

function routeTemplateOnly(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return "/";
  }
  try {
    return new URL(value, "http://localhost").pathname || "/";
  } catch {
    return value.split(/[?#]/)[0] || "/";
  }
}

function statusCodeClass(statusCode) {
  if (!Number.isFinite(statusCode) || statusCode <= 0) {
    return "unknown";
  }
  return `${Math.floor(statusCode / 100)}xx`;
}

function createRouteTraceContext(request, response, {
  spanIdFactory = defaultSpanIdFactory
} = {}) {
  const traceparent = getTraceparentHeader(request);
  if (!traceparent) {
    return undefined;
  }

  try {
    const context = parseTraceparent(traceparent);
    const spanId = normalizeSpanId(spanIdFactory(request, response));
    if (!spanId) {
      return undefined;
    }
    return {
      traceId: context.traceId,
      spanId,
      parentSpanId: context.parentSpanId,
      sampled: context.sampled
    };
  } catch {
    return undefined;
  }
}

function normalizeSpanId(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const spanId = value.toLowerCase();
  if (!/^[0-9a-f]{16}$/u.test(spanId) || spanId === "0000000000000000") {
    return undefined;
  }
  return spanId;
}

function traceMetadata(trace) {
  if (!trace) {
    return {};
  }
  return {
    parentSpanId: trace.parentSpanId,
    sampled: trace.sampled,
    spanId: trace.spanId,
    traceId: trace.traceId
  };
}

function createTraceparentRouteSpan(traceContext, {
  durationMs,
  id,
  method,
  now,
  pathname,
  statusCode
}) {
  if (!traceContext) {
    return undefined;
  }

  return {
    id,
    timestamp: now(),
    type: "span",
    attributes: {
      name: `${method} ${pathname}`,
      traceId: traceContext.traceId,
      spanId: traceContext.spanId,
      parentSpanId: traceContext.parentSpanId,
      status: statusCode >= 500 ? "error" : "ok",
      durationMs,
      metadata: {
        framework: "nextjs",
        method,
        pathname,
        sampled: traceContext.sampled,
        statusCode
      }
    }
  };
}

function routeDurationMs(options, startedAt) {
  return Math.max(0, Math.round(nowMs(options) - startedAt));
}

function nowMs(options) {
  if (typeof options.nowMs === "function") {
    return options.nowMs();
  }
  return performance.now();
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return /^0+$/.test(value) ? "0000000000000001" : value;
}

function readEnvApiKey() {
  return globalThis.process?.env?.LOGBREW_API_KEY;
}

function readEnvServerApiKey() {
  return globalThis.process?.env?.LOGBREW_SERVER_API_KEY;
}

module.exports = {
  createLogBrewNextClient,
  createRequestMetricEvent,
  createRouteErrorEvent,
  createRouteRequestEvent,
  getActiveLogBrewTrace,
  withLogBrewRouteHandler
};
