const { AsyncLocalStorage } = require("node:async_hooks");
const {
  LogBrewClient,
  SdkError,
  createIssueAttributesFromError,
  parseTraceparent
} = require("@logbrew/sdk");
const { createNodeFetchTransport } = require("@logbrew/node");
const {
  createNextRequestErrorEvent,
  getTraceparentHeader,
  nextDeploymentContext,
  nextRoutePath,
  randomHex,
  readEnvApiKey,
  readEnvServerApiKey
} = require("./request-error-event.cjs");

const activeTraceContext = new AsyncLocalStorage();

function createLogBrewNextClient({
  apiKey,
  serverApiKey,
  context,
  sdkName = "logbrew-next",
  sdkVersion = "0.1.11",
  maxRetries = 2
} = {}) {
  const authKey = serverApiKey ?? apiKey ?? readEnvServerApiKey() ?? readEnvApiKey();
  if (!authKey) {
    throw new SdkError(
      "configuration_error",
      "createLogBrewNextClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
    );
  }
  const deploymentContext = nextDeploymentContext(context);
  return LogBrewClient.create({ apiKey: authKey, context: deploymentContext, sdkName, sdkVersion, maxRetries });
}

function createLogBrewNextRequestErrorHandler(options = {}) {
  const defaultTransport = options.transport === undefined
    ? createNodeFetchTransport(options)
    : undefined;

  return async function logBrewNextRequestErrorHandler(error, request = {}, context = {}) {
    let runtime = { error, request, context };
    try {
      const resolvedClient = resolveRequestErrorClient(options, runtime);
      const client = resolvedClient.client;
      const transport = resolveTransport(options, { ...runtime, client }, defaultTransport);
      runtime = { ...runtime, client, transport };
      try {
        const event = typeof options.errorEvent === "function"
          ? options.errorEvent(error, runtime)
          : createNextRequestErrorEvent(error, request, context, options);
        client.issue(event.id, event.timestamp, event.attributes);
      } catch (captureError) {
        await notifyFailure(options, captureError, runtime);
      }
      const response = resolvedClient.owned
        ? await client.shutdown(transport)
        : await client.flush(transport);
      await notifyFlush(options, response, runtime);
    } catch (captureError) {
      try {
        await notifyFailure(options, captureError, runtime);
      } catch {
        // Observability callbacks must not replace the application error Next.js is handling.
      }
    }
  };
}

function withLogBrewRouteHandler(handler, options = {}) {
  if (typeof handler !== "function") {
    throw new SdkError("configuration_error", "withLogBrewRouteHandler requires a handler function");
  }

  const defaultTransport = options.transport === undefined
    ? createNodeFetchTransport(options)
    : undefined;

  return async function logBrewRouteHandler(request, context = {}) {
    const { client, owned } = resolveClient(options, request, context);
    const transport = resolveTransport(options, { request, context, client }, defaultTransport);
    const trace = createRouteTraceContext(request, undefined, options);
    const helpers = createRouteHelpers(client, transport, trace, request);
    const startedAt = nowMs(options);

    return activeTraceContext.run(trace, async () => {
      try {
        const response = await handler(request, context, helpers);
        ensureResponse(response);
        await captureRouteSuccess(options, { request, response, context, client, owned, transport, startedAt, trace });
        return response;
      } catch (error) {
        await recordRouteError(options, error, { request, context, client, owned, transport, trace });
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
  routeTemplate,
  spanIdFactory = defaultSpanIdFactory,
  trace
} = {}) {
  const routePath = routeTemplateOnly(routeTemplate);
  const method = request?.method ?? "GET";
  const statusCode = Number(response?.status ?? 0);
  const id = idFactory(request, response, routePath);
  const routeTrace = trace ?? getActiveLogBrewTrace() ?? createRouteTraceContext(request, response, { spanIdFactory });
  const spanEvent = routeTrace
    ? createTraceparentRouteSpan(routeTrace, {
      durationMs,
      id,
      method,
      now,
      routeTemplate: routePath,
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
      message: `${method} ${routePath} ${statusCode}`,
      level: statusCode >= 500 ? "error" : "info",
      logger: "next",
      metadata: {
        framework: "nextjs",
        method,
        routeTemplate: routePath,
        statusCode,
        durationMs
      }
    }
  };
}

function createRouteErrorEvent(error, request, {
  includeErrorStack = false,
  includeSearchParams = false,
  now = () => new Date().toISOString(),
  idFactory = defaultRouteErrorId,
  routeTemplate,
  trace
} = {}) {
  const url = safeUrl(request);
  const routePath = routeTemplateOnly(routeTemplate);
  const method = request?.method ?? "GET";
  const routeTrace = trace ?? getActiveLogBrewTrace();
  return {
    id: idFactory(request, routePath),
    timestamp: now(),
    attributes: createIssueAttributesFromError(error, {
      title: `${method} ${routePath} failed`,
      mechanism: "nextjs.route_handler",
      handled: false,
      source: "nextjs.route_handler",
      includeErrorStack,
      metadata: {
        framework: "nextjs",
        method,
        operation: "http.server",
        routeTemplate: routePath,
        ...(includeSearchParams ? { search: url.search || null } : {}),
        ...traceMetadata(routeTrace)
      }
    })
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
  const resolvedRouteTemplate = routeTemplateOnly(routeTemplate);
  const statusCode = Number(response?.status ?? 0);
  return {
    id: idFactory(request, response, resolvedRouteTemplate),
    timestamp: now(),
    attributes: {
      name: metricName,
      description: "Duration of one completed server request.",
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
    return { client: options.client({ request, context }), owned: true };
  }
  if (options.client) {
    return { client: options.client, owned: false };
  }
  return { client: createLogBrewNextClient(options), owned: true };
}

function resolveTransport(options, runtime, defaultTransport) {
  if (typeof options.transport === "function") {
    return options.transport(runtime);
  }
  return options.transport ?? defaultTransport;
}

function resolveRequestErrorClient(options, runtime) {
  if (typeof options.client === "function") {
    return { client: options.client(runtime), owned: true };
  }
  if (options.client) {
    return { client: options.client, owned: false };
  }
  return { client: createLogBrewNextClient(options), owned: true };
}

// Users belong to one route request, so one request's user never reaches another request.
const routeSubjects = new WeakMap();
const MAX_USER_ID_LENGTH = 200;

function setRouteUser(request, id, { kind = "user" } = {}) {
  const normalized = typeof id === "string" ? id.trim() : "";
  const characters = Array.from(normalized);
  if (characters.length === 0 || characters.length > MAX_USER_ID_LENGTH || characters.some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  })) {
    throw new SdkError("configuration_error", `LogBrew user id must be 1-${MAX_USER_ID_LENGTH} characters without control characters`);
  }
  if (kind !== "user" && kind !== "anonymous") {
    throw new SdkError("configuration_error", "LogBrew user kind must be user or anonymous");
  }
  if (!request || typeof request !== "object") {
    return false;
  }
  routeSubjects.set(request, { id: normalized, kind });
  return true;
}

function withRouteSubject(attributes, request) {
  const subject = request && typeof request === "object" ? routeSubjects.get(request) : undefined;
  if (!subject || attributes?.context?.subject) {
    return attributes;
  }
  return { ...attributes, context: { ...(attributes.context ?? { schemaVersion: 1 }), subject } };
}

function createRouteHelpers(client, transport, trace, request) {
  return {
    client,
    logbrew: client,
    // Tags this request's route span and route error issue with an opaque app-owned user ID.
    setUser: (id, options) => setRouteUser(request, id, options),
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
    try {
      await options.onCaptureError(error, context);
    } catch {
      // A capture callback must not change the application's response or error.
    }
  }
}

async function captureRouteSuccess(options, runtime) {
  const { request, response, context, client, startedAt, trace } = runtime;
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
  } catch (error) {
    await notifyFailure(options, error, { request, context, client, trace });
  }
  await finalizeRouteCapture(options, runtime);
}

async function finalizeRouteCapture(options, { request, context, client, owned, transport, trace }) {
  try {
    const flushResponse = owned
      ? await client.shutdown(transport)
      : await client.flush(transport);
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
      routeTemplate: resolveRouteTemplate(options, request, context),
      trace
    });
  captureRouteRequestEvent(client, { ...event, attributes: withRouteSubject(event.attributes, request) });
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

async function recordRouteError(options, error, runtime) {
  const { request, context, client, trace } = runtime;
  const routeTrace = trace ?? getActiveLogBrewTrace();
  try {
    if (options.captureErrors !== false) {
      const event = typeof options.errorEvent === "function"
        ? options.errorEvent(error, { request, context, client, trace: routeTrace })
        : createRouteErrorEvent(error, request, {
          ...options,
          routeTemplate: resolveRouteTemplate(options, request, context),
          trace: routeTrace
        });
      client.issue(event.id, event.timestamp, withRouteSubject(event.attributes, request));
    }
  } catch (captureError) {
    await notifyFailure(options, captureError, { request, context, client, trace: routeTrace });
  }
  await finalizeRouteCapture(options, { ...runtime, trace: routeTrace });
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

function defaultRouteRequestId() {
  return `evt_next_request_${randomHex(8)}`;
}

function defaultSpanIdFactory() {
  return randomHex(8);
}

function defaultRouteErrorId() {
  return `evt_next_error_${randomHex(8)}`;
}

function defaultRouteMetricId() {
  return `evt_next_metric_${randomHex(8)}`;
}

function safeUrl(request) {
  try {
    return new URL(request?.url ?? "http://localhost/");
  } catch {
    return new URL("http://localhost/");
  }
}

function resolveRouteTemplate(options, request, context) {
  const value = typeof options.routeTemplate === "function"
    ? options.routeTemplate(request, context)
    : options.routeTemplate;
  return routeTemplateOnly(value);
}

function routeTemplateOnly(value) {
  return nextRoutePath(value);
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
  routeTemplate,
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
      name: `${method} ${routeTemplate}`,
      traceId: traceContext.traceId,
      spanId: traceContext.spanId,
      parentSpanId: traceContext.parentSpanId,
      status: statusCode >= 500 ? "error" : "ok",
      durationMs,
      metadata: {
        framework: "nextjs",
        method,
        operation: "http.server",
        routeTemplate,
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

module.exports = {
  createLogBrewNextClient,
  createLogBrewNextRequestErrorHandler,
  createNextRequestErrorEvent,
  createRequestMetricEvent,
  createRouteErrorEvent,
  createRouteRequestEvent,
  getActiveLogBrewTrace,
  withLogBrewRouteHandler
};
