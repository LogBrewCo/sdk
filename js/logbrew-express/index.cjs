"use strict";

const {
  createIssueAttributesFromError,
  SdkError
} = require("@logbrew/sdk");
const {
  createLogBrewNodeClient,
  createLogBrewTraceContext,
  createNodeFetchTransport,
  getActiveLogBrewTrace,
  runWithLogBrewTrace,
  setLogBrewUser
} = require("@logbrew/node");

const DEFAULT_SDK_NAME = "logbrew-express";
const DEFAULT_SDK_VERSION = "0.1.6";
const requestLifecycles = new WeakMap();

function createLogBrewExpressClient({
  serverApiKey,
  apiKey,
  captureRuntimeContext = true,
  context,
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
  return createLogBrewNodeClient({
    serverApiKey: authKey,
    automaticDelivery: false,
    captureRuntimeContext,
    context,
    sdkName,
    sdkVersion,
    maxRetries
  });
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
      ensureCloseFinalizer(lifecycle);
    }

    runWithLogBrewTrace(trace, next);
  };
}

function withLogBrewExpressHandler(handler) {
  if (typeof handler !== "function" || handler.length > 3) {
    throw new SdkError("configuration_error", "withLogBrewExpressHandler requires a request handler");
  }

  /** @this {*} */
  return function logBrewExpressHandler(req, res, next) {
    const lifecycle = requestLifecycles.get(req);
    if (lifecycle && !lifecycle.released) {
      lifecycle.wrapped = true;
      lifecycle.activeHandlers += 1;
    }
    const ownedLifecycle = lifecycle && !lifecycle.released ? lifecycle : undefined;
    const trace = getRequestTraceContext(req) ?? getActiveLogBrewTrace();

    return runWithLogBrewTrace(trace, () => {
      try {
        const result = Reflect.apply(handler, this, [req, res, next]);
        if (result !== null && (typeof result === "object" || typeof result === "function")
          && typeof result.then === "function") {
          return Promise.resolve(result).then(
            (value) => {
              settleWrappedHandler(ownedLifecycle);
              return value;
            },
            (error) => {
              try {
                next(error || new Error("Rejected promise"));
              } finally {
                settleWrappedHandler(ownedLifecycle);
              }
            }
          );
        }
        settleWrappedHandler(ownedLifecycle);
        return result;
      } catch (error) {
        settleWrappedHandler(ownedLifecycle);
        throw error;
      }
    });
  };
}

function settleWrappedHandler(lifecycle) {
  if (!lifecycle) {
    return;
  }
  lifecycle.activeHandlers -= 1;
  scheduleWrappedShutdown(lifecycle);
}

function scheduleWrappedShutdown(lifecycle) {
  if (!lifecycle.finalized || !lifecycle.deferredShutdown || lifecycle.activeHandlers !== 0
    || lifecycle.shutdownScheduled) {
    return;
  }
  lifecycle.shutdownScheduled = true;
  void runWithLogBrewTrace(getRequestTraceContext(lifecycle.req), () => shutdownWrappedLifecycle(lifecycle));
}

async function shutdownWrappedLifecycle(lifecycle) {
  await lifecycle.deliverySettled;
  if (lifecycle.activeHandlers > 0) {
    lifecycle.shutdownScheduled = false;
    return;
  }
  releaseRequestLifecycle(lifecycle);
  const { client, observers, req, res, transport } = lifecycle;
  const context = { req, res, client, trace: getRequestTraceContext(req) };
  try {
    const hasTail = client.pendingEvents() > 0;
    const response = await client.shutdown(transport);
    if (hasTail) {
      await notifyLifecycleFlush([...observers], response, context);
    }
  } catch (error) {
    await notifyLifecycleFailure([...observers], error, context);
  }
}

function releaseRequestLifecycle(lifecycle) {
  lifecycle.released = true;
  if (requestLifecycles.get(lifecycle.req) === lifecycle) {
    requestLifecycles.delete(lifecycle.req);
  }
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
    const context = { req, res, client, trace };

    return runWithLogBrewTrace(trace, () => {
      const lifecycle = requestLifecycles.get(req);
      const requestOwnsDelivery = lifecycle && !lifecycle.released
        && lifecycle.client === client && lifecycle.transport === transport;
      try {
        const event = typeof options.errorEvent === "function"
          ? options.errorEvent(error, context)
          : createErrorEvent(error, req, { ...options, trace });
        addErrorBreadcrumb(client, req);
        client.issue(event.id, event.timestamp, event.attributes);
        if (requestOwnsDelivery) {
          if (!lifecycle.observers.includes(options)) {
            lifecycle.observers.push(options);
          }
          ensureFinishFinalizer(lifecycle);
          ensureCloseFinalizer(lifecycle);
          if (lifecycle.wrapped && (req.aborted === true || res.destroyed === true || res.writableFinished === true)) {
            void finalizeRequestLifecycle(lifecycle);
          }
        } else {
          shutdownErrorClient(options, transport, context);
        }
      } catch (captureError) {
        void notifyLifecycleFailure([options], captureError, context);
        if (!requestOwnsDelivery && client.pendingEvents() > 0) {
          shutdownErrorClient(options, transport, context);
        }
      }

      next(error);
    });
  };
}

function shutdownErrorClient(options, transport, context) {
  void context.client.shutdown(transport)
    .then((response) => notifyFlush(options, response, context))
    .catch((flushError) => notifyLifecycleFailure([options], flushError, context));
}

function createRequestEvent(req, res, {
  now = () => new Date().toISOString(),
  durationMs = 0,
  idFactory = defaultRequestEventId,
  spanIdFactory,
  traceIdFactory,
  trace = undefined
} = {}) {
  const method = req.method ?? "GET";
  const routeTemplate = getRouteTemplate(req);
  const statusCode = Number(res.statusCode ?? 0);
  const id = idFactory(req, res);
  return createTraceparentRequestSpan(
    trace ?? getRequestTraceContext(req) ?? createRequestTraceContext(req, res, {
      spanIdFactory,
      traceIdFactory
    }),
    { durationMs, id, method, now, routeTemplate, statusCode, responseCompleted: responseCompleted(req, res) }
  );
}

function createErrorEvent(error, req, {
  includeErrorStack = false,
  now = () => new Date().toISOString(),
  idFactory = defaultErrorEventId,
  trace = undefined
} = {}) {
  const method = req.method ?? "GET";
  const routeTemplate = getRouteTemplate(req);
  const traceContext = trace ?? getRequestTraceContext(req) ?? getActiveLogBrewTrace();
  return {
    id: idFactory(error, req),
    timestamp: now(),
    attributes: createIssueAttributesFromError(error, {
      title: `${method} ${routeTemplate} failed`,
      mechanism: "express.middleware",
      handled: false,
      source: "express.middleware",
      trace: traceContext,
      includeErrorStack,
      metadata: {
        framework: "express",
        method,
        routeTemplate
      }
    })
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
      description: "Duration of one completed server request.",
      kind: "histogram",
      value: Math.max(0, Number(durationMs)),
      unit: "ms",
      temporality: "delta",
      metadata: {
        framework: "express",
        method,
        routeTemplate,
        statusCode,
        statusCodeClass: statusCodeClass(statusCode),
        ...incompleteResponseMetadata(req, res)
      }
    }
  };
}

function createRequestContext(client, transport, trace) {
  return {
    client,
    logbrew: client,
    ...(trace ? { trace } : {}),
    // Tags every event of this request with an opaque app-owned user ID.
    setUser: (id, options = {}) => setLogBrewUser(id, { ...options, trace }),
    transport,
    previewJson: () => client.previewJson(),
    flush: () => client.flush(transport),
    shutdown: () => client.shutdown(transport)
  };
}

function createRequestLifecycle({ captureOptions, client, observers, req, res, startedAt, transport }) {
  return {
    captureOptions,
    activeHandlers: 0,
    client,
    closeAttached: false,
    deferredShutdown: false,
    finalized: false,
    finishAttached: false,
    observers,
    released: false,
    req,
    res,
    startedAt,
    transport,
    wrapped: false,
    shutdownScheduled: false
  };
}

function ensureFinishFinalizer(lifecycle) {
  if (lifecycle.finishAttached) {
    return;
  }
  lifecycle.finishAttached = true;
  lifecycle.finishListener = () => {
    void runWithLogBrewTrace(getRequestTraceContext(lifecycle.req), () => finalizeRequestLifecycle(lifecycle));
  };
  lifecycle.res.once("finish", lifecycle.finishListener);
}

function ensureCloseFinalizer(lifecycle) {
  if (lifecycle.closeAttached) {
    return;
  }
  lifecycle.closeAttached = true;
  lifecycle.closeListener = () => {
    void runWithLogBrewTrace(getRequestTraceContext(lifecycle.req), () => finalizeRequestLifecycle(lifecycle));
  };
  lifecycle.res.once("close", lifecycle.closeListener);
  lifecycle.req.once("aborted", lifecycle.closeListener);
}

async function finalizeRequestLifecycle(lifecycle) {
  if (lifecycle.finalized) {
    return;
  }
  lifecycle.finalized = true;
  lifecycle.deferredShutdown = lifecycle.activeHandlers > 0;
  if (!lifecycle.deferredShutdown) {
    releaseRequestLifecycle(lifecycle);
  }
  let resolveDelivery;
  lifecycle.deliverySettled = new Promise((resolve) => { resolveDelivery = resolve; });
  if (lifecycle.finishListener) {
    lifecycle.res.removeListener("finish", lifecycle.finishListener);
  }
  if (lifecycle.closeListener) {
    lifecycle.res.removeListener("close", lifecycle.closeListener);
    lifecycle.req.removeListener("aborted", lifecycle.closeListener);
  }

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
    const deliveryObservers = [...observers];
    const response = await (lifecycle.deferredShutdown ? client.flush(transport) : client.shutdown(transport));
    resolveDelivery();
    scheduleWrappedShutdown(lifecycle);
    await notifyLifecycleFlush(deliveryObservers, response, context);
  } catch (error) {
    resolveDelivery();
    scheduleWrappedShutdown(lifecycle);
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
  return `evt_express_request_${slugify(`${req.method ?? "GET"}_${getRouteTemplate(req)}_${res.statusCode ?? 0}`)}_${randomHex(8)}`;
}

function defaultErrorEventId(_error, req) {
  return `evt_express_error_${slugify(`${req.method ?? "GET"}_${getRouteTemplate(req)}`)}_${randomHex(8)}`;
}

function defaultRequestMetricEventId(req, res) {
  return `evt_express_metric_${slugify(`${req.method ?? "GET"}_${getRouteTemplate(req)}_${res.statusCode ?? 0}`)}_${randomHex(8)}`;
}

function getRouteTemplate(req) {
  const routePath = req.route?.path;
  if (typeof routePath === "string") {
    // Express declares a route pattern here, not a concrete request URL.
    return routePath;
  }
  return "<unmatched>";
}

function addErrorBreadcrumb(client, req) {
  const method = req.method ?? "GET";
  const routeTemplate = getRouteTemplate(req);
  client.addBreadcrumb({
    type: "http",
    category: "express.request",
    level: "error",
    message: `${method} ${routeTemplate}`,
    data: { method, routeTemplate }
  });
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
  routeTemplate,
  statusCode,
  responseCompleted
}) {
  if (!traceContext) {
    return undefined;
  }

  return {
    id,
    timestamp: now(),
    type: "span",
    attributes: {
      name: `${method} ${routeTemplate}`,
      traceId: traceContext.traceId,
      spanId: traceContext.spanId,
      parentSpanId: traceContext.parentSpanId,
      status: statusCode >= 500 || !responseCompleted ? "error" : "ok",
      durationMs,
      metadata: {
        framework: "express",
        method,
        routeTemplate,
        sampled: traceContext.sampled,
        statusCode,
        ...(!responseCompleted ? { responseCompleted: false } : {})
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

function responseCompleted(req, res) {
  return req.aborted !== true && !(res.destroyed === true && res.writableFinished === false);
}

function incompleteResponseMetadata(req, res) {
  return responseCompleted(req, res) ? {} : { responseCompleted: false };
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
  spanIdFactory,
  traceIdFactory
} = {}) {
  return createLogBrewTraceContext(getTraceparentHeader(req), {
    spanIdFactory: () => spanIdFactory?.(req, res),
    traceIdFactory: () => traceIdFactory?.(req, res)
  });
}

function getRequestTraceContext(req) {
  return req.logbrew?.trace;
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
  logbrewMiddleware,
  withLogBrewExpressHandler
};
