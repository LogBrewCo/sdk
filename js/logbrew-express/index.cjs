const {
  LogBrewClient,
  parseTraceparent,
  SdkError
} = require("@logbrew/sdk");
const { createNodeFetchTransport } = require("@logbrew/node");
const { AsyncLocalStorage } = require("node:async_hooks");

const DEFAULT_SDK_NAME = "logbrew-express";
const DEFAULT_SDK_VERSION = "0.1.2";
const activeTraceContext = new AsyncLocalStorage();
const requestLifecycles = new WeakMap();

function createLogBrewExpressClient({
  serverApiKey,
  apiKey,
  sdkName = DEFAULT_SDK_NAME,
  sdkVersion = DEFAULT_SDK_VERSION,
  maxRetries = 2
} = {}) {
  const authKey = serverApiKey ?? apiKey ?? readEnvServerApiKey() ?? readEnvApiKey();
  if (!authKey) {
    throw new SdkError(
      "configuration_error",
      "createLogBrewExpressClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
    );
  }
  return LogBrewClient.create({ apiKey: authKey, sdkName, sdkVersion, maxRetries });
}

function logbrewMiddleware(options = {}) {
  const defaultTransport = options.transport === undefined
    ? createNodeFetchTransport(options)
    : undefined;
  return function logBrewExpressMiddleware(req, res, next) {
    const client = resolveClient(options, req, res);
    const transport = resolveTransport(options, req, res, client, defaultTransport);
    const startedAt = nowMs(options);
    const trace = createRequestTraceContext(req, res, options);
    const capturesOnFinish = options.captureRequests !== false || options.captureRequestMetrics === true;

    req.logbrew = createRequestContext(client, transport, trace);
    const lifecycle = createRequestLifecycle({
      captureOptions: capturesOnFinish ? options : undefined,
      client,
      observers: capturesOnFinish ? [options] : [],
      req,
      res,
      startedAt,
      transport
    });
    requestLifecycles.set(req, lifecycle);

    if (capturesOnFinish) {
      ensureFinishFinalizer(lifecycle);
    }

    activeTraceContext.run(trace, next);
  };
}

function logbrewErrorHandler(options = {}) {
  const defaultTransport = options.transport === undefined
    ? createNodeFetchTransport(options)
    : undefined;
  return function logBrewExpressErrorHandler(error, req, res, next) {
    const existing = req.logbrew;
    const client = existing?.client ?? resolveClient(options, req, res);
    const transport = existing?.transport ?? resolveTransport(options, req, res, client, defaultTransport);
    const trace = existing?.trace ?? getActiveLogBrewTrace();
    const event = typeof options.errorEvent === "function"
      ? options.errorEvent(error, { req, res, client, trace })
      : createErrorEvent(error, req, { ...options, trace });

    try {
      client.issue(event.id, event.timestamp, event.attributes);
      const lifecycle = requestLifecycles.get(req);
      if (lifecycle && !lifecycle.finalized && lifecycle.client === client && lifecycle.transport === transport) {
        if (!lifecycle.observers.includes(options)) {
          lifecycle.observers.push(options);
        }
        ensureFinishFinalizer(lifecycle);
        ensureCloseFinalizer(lifecycle);
      } else {
        void client.shutdown(transport)
          .then((response) => notifyFlush(options, response, { req, res, client, trace }))
          .catch((flushError) => notifyFailure(options, flushError, { req, res, client, trace }));
      }
    } catch (captureError) {
      void notifyFailure(options, captureError, { req, res, client, trace });
    }

    next(error);
  };
}

function getActiveLogBrewTrace() {
  return activeTraceContext.getStore();
}

function createRequestEvent(req, res, {
  now = () => new Date().toISOString(),
  durationMs = 0,
  idFactory = defaultRequestEventId,
  spanIdFactory = defaultSpanIdFactory,
  trace = undefined
} = {}) {
  const method = req.method ?? "GET";
  const path = getRequestPath(req);
  const statusCode = Number(res.statusCode ?? 0);
  const id = idFactory(req, res);
  const traceContext = trace ?? getRequestTraceContext(req) ?? createRequestTraceContext(req, res, { spanIdFactory });
  const spanEvent = traceContext
    ? createTraceparentRequestSpan(traceContext, {
      durationMs,
      id,
      method,
      now,
      path,
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
      message: `${method} ${path} ${statusCode}`,
      level: statusCode >= 500 ? "error" : "info",
      logger: "express",
      metadata: {
        method,
        path,
        statusCode,
        durationMs
      }
    }
  };
}

function createErrorEvent(error, req, {
  now = () => new Date().toISOString(),
  idFactory = defaultErrorEventId,
  trace = undefined
} = {}) {
  const method = req.method ?? "GET";
  const path = getRequestPath(req);
  const message = error instanceof Error ? error.message : String(error);
  const traceContext = trace ?? getRequestTraceContext(req) ?? getActiveLogBrewTrace();
  return {
    id: idFactory(error, req),
    timestamp: now(),
    attributes: {
      title: `${method} ${path} failed`,
      level: "error",
      message,
      metadata: {
        method,
        path,
        ...traceMetadata(traceContext)
      }
    }
  };
}

function createRequestMetricEvent(req, res, {
  now = () => new Date().toISOString(),
  durationMs = 0,
  idFactory = defaultRequestMetricEventId,
  metricName = "http.server.duration"
} = {}) {
  const method = req.method ?? "GET";
  const routeTemplate = getRouteTemplate(req);
  const statusCode = Number(res.statusCode ?? 0);
  return {
    id: idFactory(req, res),
    timestamp: now(),
    attributes: {
      name: metricName,
      kind: "histogram",
      value: Math.max(0, Number(durationMs)),
      unit: "ms",
      temporality: "delta",
      metadata: {
        framework: "express",
        method,
        routeTemplate,
        statusCode,
        statusCodeClass: statusCodeClass(statusCode)
      }
    }
  };
}

function createRequestContext(client, transport, trace) {
  return {
    client,
    logbrew: client,
    ...(trace ? { trace } : {}),
    transport,
    previewJson: () => client.previewJson(),
    flush: () => client.flush(transport),
    shutdown: () => client.shutdown(transport)
  };
}

function createRequestLifecycle({ captureOptions, client, observers, req, res, startedAt, transport }) {
  return {
    captureOptions,
    client,
    closeAttached: false,
    finalized: false,
    finishAttached: false,
    observers,
    req,
    res,
    startedAt,
    transport
  };
}

function ensureFinishFinalizer(lifecycle) {
  if (lifecycle.finishAttached) {
    return;
  }
  lifecycle.finishAttached = true;
  lifecycle.res.once("finish", () => {
    void finalizeRequestLifecycle(lifecycle);
  });
}

function ensureCloseFinalizer(lifecycle) {
  if (lifecycle.closeAttached) {
    return;
  }
  lifecycle.closeAttached = true;
  lifecycle.res.once("close", () => {
    void finalizeRequestLifecycle(lifecycle);
  });
}

async function finalizeRequestLifecycle(lifecycle) {
  if (lifecycle.finalized) {
    return;
  }
  lifecycle.finalized = true;
  requestLifecycles.delete(lifecycle.req);

  const { captureOptions: options, client, observers, req, res, startedAt, transport } = lifecycle;
  const trace = getRequestTraceContext(req);
  const context = { req, res, client, trace };
  let captureError;

  if (options) {
    try {
      const durationMs = Math.max(0, Math.round(nowMs(options) - startedAt));
      if (options.captureRequests !== false) {
        const event = typeof options.requestEvent === "function"
          ? options.requestEvent(req, res, { client, durationMs, trace })
          : createRequestEvent(req, res, { ...options, durationMs, trace });
        captureRequestEvent(client, event);
      }
      if (options.captureRequestMetrics === true) {
        const metricEvent = typeof options.requestMetricEvent === "function"
          ? options.requestMetricEvent(req, res, { client, durationMs, trace })
          : createRequestMetricEvent(req, res, {
            ...options,
            durationMs,
            idFactory: options.metricIdFactory
          });
        captureRequestMetricEvent(client, metricEvent);
      }
    } catch (error) {
      captureError = error;
    }
  }

  if (captureError) {
    await notifyLifecycleFailure(observers, captureError, context);
  }

  try {
    const response = await client.shutdown(transport);
    await notifyLifecycleFlush(observers, response, context);
  } catch (error) {
    await notifyLifecycleFailure(observers, error, context);
  }
}

async function notifyLifecycleFlush(observers, response, context) {
  for (const options of observers) {
    try {
      await notifyFlush(options, response, context);
    } catch (error) {
      await notifyLifecycleFailure([options], error, context);
    }
  }
}

async function notifyLifecycleFailure(observers, error, context) {
  for (const options of observers) {
    try {
      await notifyFailure(options, error, context);
    } catch {
      // App callbacks must not turn a response lifecycle callback into an unhandled rejection.
    }
  }
}

function resolveClient(options, req, res) {
  if (typeof options.client === "function") {
    return options.client({ req, res });
  }
  if (options.client) {
    return options.client;
  }
  return createLogBrewExpressClient(options);
}

function resolveTransport(options, req, res, client, defaultTransport) {
  if (typeof options.transport === "function") {
    return options.transport({ req, res, client });
  }
  return options.transport ?? defaultTransport;
}

async function notifyFlush(options, response, context) {
  if (typeof options.onFlush === "function") {
    await options.onFlush(response, context);
  }
}

async function notifyFailure(options, error, context) {
  if (typeof options.onCaptureError === "function") {
    await options.onCaptureError(error, context);
  }
}

function defaultRequestEventId(req, res) {
  return `evt_express_request_${slugify(`${req.method ?? "GET"}_${getRequestPath(req)}_${res.statusCode ?? 0}`)}`;
}

function defaultSpanIdFactory() {
  return randomHex(8);
}

function defaultErrorEventId(error, req) {
  const message = error instanceof Error ? error.message : String(error);
  return `evt_express_error_${slugify(`${req.method ?? "GET"}_${getRequestPath(req)}_${message}`)}`;
}

function defaultRequestMetricEventId(req, res) {
  return `evt_express_metric_${slugify(`${req.method ?? "GET"}_${getRouteTemplate(req)}_${res.statusCode ?? 0}`)}`;
}

function getRequestPath(req) {
  return pathOnly(req.originalUrl ?? req.url ?? "/");
}

function getRouteTemplate(req) {
  const routePath = req.route?.path;
  if (typeof routePath === "string") {
    const baseUrl = req.baseUrl ?? "";
    if (baseUrl && routePath.startsWith(baseUrl)) {
      return pathOnly(routePath);
    }
    return pathOnly(`${baseUrl}${routePath}`);
  }
  return getRequestPath(req);
}

function pathOnly(value) {
  const rawValue = typeof value === "string" ? value : String(value);
  try {
    return new URL(rawValue, "http://localhost").pathname || "/";
  } catch {
    return rawValue.split("?")[0] || "/";
  }
}

function getTraceparentHeader(req) {
  const value = req.headers?.traceparent;
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
}

function createTraceparentRequestSpan(traceContext, {
  durationMs,
  id,
  method,
  now,
  path,
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
      name: `${method} ${path}`,
      traceId: traceContext.traceId,
      spanId: traceContext.spanId,
      parentSpanId: traceContext.parentSpanId,
      status: statusCode >= 500 ? "error" : "ok",
      durationMs,
      metadata: {
        framework: "express",
        method,
        path,
        sampled: traceContext.sampled,
        statusCode
      }
    }
  };
}

function captureRequestEvent(client, event) {
  if (event.type === "span") {
    client.span(event.id, event.timestamp, event.attributes);
    return;
  }
  client.log(event.id, event.timestamp, event.attributes);
}

function captureRequestMetricEvent(client, event) {
  client.metric(event.id, event.timestamp, event.attributes);
}

function statusCodeClass(statusCode) {
  if (!Number.isFinite(statusCode) || statusCode <= 0) {
    return "unknown";
  }
  return `${Math.floor(statusCode / 100)}xx`;
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

function createRequestTraceContext(req, res, {
  spanIdFactory = defaultSpanIdFactory
} = {}) {
  const traceparent = getTraceparentHeader(req);
  if (!traceparent) {
    return undefined;
  }

  try {
    const context = parseTraceparent(traceparent);
    const spanId = normalizeSpanId(spanIdFactory(req, res));
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

function getRequestTraceContext(req) {
  return req.logbrew?.trace;
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

function readEnvApiKey() {
  return globalThis.process?.env?.LOGBREW_API_KEY;
}

function readEnvServerApiKey() {
  return globalThis.process?.env?.LOGBREW_SERVER_API_KEY;
}

function nowMs(options) {
  if (typeof options.nowMs === "function") {
    return options.nowMs();
  }
  return performance.now();
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

module.exports = {
  createErrorEvent,
  createLogBrewExpressClient,
  createRequestMetricEvent,
  createRequestEvent,
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware
};
