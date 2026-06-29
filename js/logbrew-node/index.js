import {
  LogBrewClient,
  RecordingTransport,
  createTraceparentHeaders,
  parseTraceparent,
  SdkError,
  TransportError
} from "@logbrew/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createLogBrewQueueBatchSpanOptions as createQueueBatchSpanOptions,
  createLogBrewQueueTraceHeaders as createQueueTraceHeaders,
  createLogBrewQueueTraceLinks as createQueueTraceLinks,
  normalizeSpanId,
  normalizeTraceId,
  resolveOperationTrace
} from "./trace-context.js";
import { instrumentLogBrewPgClient as instrumentPgClient } from "./pg.js";
import { instrumentLogBrewRedisClient as instrumentRedisClient } from "./redis.js";

const DEFAULT_SDK_NAME = "logbrew-node";
const DEFAULT_SDK_VERSION = "0.1.0";
const DEFAULT_ENDPOINT = "https://api.logbrew.com/v1/events";
const MAX_SPAN_EVENTS = 8;
const activeTraceContext = new AsyncLocalStorage();

export function createLogBrewNodeClient({
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
      "createLogBrewNodeClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
    );
  }
  return LogBrewClient.create({ apiKey: authKey, sdkName, sdkVersion, maxRetries });
}

export function createNodeFetchTransport({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = defaultFetch(),
  headers = {}
} = {}) {
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new SdkError("configuration_error", "createNodeFetchTransport requires a non-empty endpoint");
  }
  if (typeof fetchImpl !== "function") {
    throw new SdkError("configuration_error", "createNodeFetchTransport requires fetch");
  }

  return {
    async send(apiKey, body) {
      try {
        const response = await fetchImpl(endpoint, {
          body,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...headers
          },
          method: "POST"
        });
        return { statusCode: response.status, attempts: 1 };
      } catch (error) {
        throw TransportError.network(`fetch failed: ${errorMessage(error)}`);
      }
    }
  };
}

export function withLogBrewHttpHandler(handler, options = {}) {
  if (typeof handler !== "function") {
    throw new SdkError("configuration_error", "withLogBrewHttpHandler requires a handler function");
  }

  return function logBrewHttpHandler(req, res) {
    const client = resolveClient(options, req, res);
    const transport = resolveTransport(options, req, res, client);
    const startedAt = nowMs(options);
    const trace = createRequestTraceContext(req, res, options);
    const context = createLogBrewNodeContext(client, transport, trace);
    let errorCaptured = false;

    req.logbrew = context;

    if (options.captureRequests !== false) {
      res.once("finish", () => {
        if (!errorCaptured) {
          void captureHttpRequestFinish(options, { req, res, client, transport, startedAt });
        }
      });
    }

    activeTraceContext.run(trace, () => {
      try {
        const result = handler(req, res, context);
        if (isPromiseLike(result)) {
          void result.catch((error) => {
            errorCaptured = true;
            return handleHttpHandlerError(options, { error, req, res, context });
          });
        }
      } catch (error) {
        errorCaptured = true;
        void handleHttpHandlerError(options, { error, req, res, context });
      }
    });
  };
}

export function createLogBrewNodeContext(client, transport, trace) {
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

export function getActiveLogBrewTrace() {
  return activeTraceContext.getStore();
}

export function createLogBrewQueueTraceHeaders(trace = getActiveLogBrewTrace()) {
  return createQueueTraceHeaders(trace);
}

export function createLogBrewQueueTraceLinks(carriers, metadata) {
  return createQueueTraceLinks(carriers, metadata);
}

export function instrumentLogBrewPgClient(pgClient, options = {}) {
  return instrumentPgClient(pgClient, {
    ...options,
    activeTraceProvider: getActiveLogBrewTrace,
    runWithTrace: (trace, callback) => activeTraceContext.run(trace, callback)
  });
}

export function instrumentLogBrewRedisClient(redisClient, options = {}) {
  return instrumentRedisClient(redisClient, {
    ...options,
    activeTraceProvider: getActiveLogBrewTrace,
    runWithTrace: (trace, callback) => activeTraceContext.run(trace, callback)
  });
}

export async function fetchWithLogBrewSpan(input, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  if (typeof fetchImpl !== "function") {
    throw new SdkError("configuration_error", "fetchWithLogBrewSpan requires fetch");
  }
  if (!options.client) {
    throw new SdkError("configuration_error", "fetchWithLogBrewSpan requires client");
  }

  const method = getFetchMethod(input, init);
  const path = pathOnly(options.routeTemplate ?? getFetchUrl(input));
  const startedAt = nowMs(options);
  const trace = createFetchTraceContext(options.trace ?? getActiveLogBrewTrace(), options);
  const traceFlags = trace.sampled ? "01" : "00";
  const traceparent = createTraceparentHeaders({
    traceId: trace.traceId,
    spanId: trace.spanId,
    traceFlags
  }).traceparent;
  const fetchInit = withFetchTraceparent(input, init, traceparent);
  const id = options.id ?? defaultFetchSpanId({ method, path });

  try {
    const response = await activeTraceContext.run(trace, () => fetchImpl(input, fetchInit));
    await captureFetchSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      id,
      method,
      path,
      response,
      trace
    });
    return response;
  } catch (error) {
    await captureFetchSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      error,
      id,
      method,
      path,
      trace
    });
    throw error;
  }
}

export async function databaseOperationWithLogBrewSpan(operationName, options = {}) {
  if (typeof operationName !== "string" || operationName.trim() === "") {
    throw new SdkError("configuration_error", "databaseOperationWithLogBrewSpan requires a non-empty operation name");
  }
  if (!options.client) {
    throw new SdkError("configuration_error", "databaseOperationWithLogBrewSpan requires client");
  }
  if (typeof options.operation !== "function") {
    throw new SdkError("configuration_error", "databaseOperationWithLogBrewSpan requires operation");
  }
  const system = normalizeDatabaseLabel(options.system, "database");
  const operationKind = normalizeDatabaseOperationKind(options.operationKind);
  const startedAt = nowMs(options);
  const trace = createChildTraceContext("databaseOperationWithLogBrewSpan", options.trace ?? getActiveLogBrewTrace(), options);
  const id = options.id ?? defaultDatabaseSpanId({ operationKind, operationName, system });

  try {
    const result = await activeTraceContext.run(trace, options.operation);
    await captureDatabaseSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      id,
      operationKind,
      operationName,
      system,
      trace
    });
    return result;
  } catch (error) {
    await captureDatabaseSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      error,
      id,
      operationKind,
      operationName,
      system,
      trace
    });
    throw error;
  }
}

export async function cacheOperationWithLogBrewSpan(operationName, options = {}) {
  return operationWithLogBrewSpan("cache", operationName, options);
}

export async function queueOperationWithLogBrewSpan(operationName, options = {}) {
  return operationWithLogBrewSpan("queue", operationName, options);
}

export async function queueBatchOperationWithLogBrewSpan(operationName, options = {}) {
  return queueOperationWithLogBrewSpan(operationName, createQueueBatchSpanOptions(options));
}

export function createHttpRequestEvent(req, res, {
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
      logger: "node",
      metadata: {
        method,
        path,
        statusCode,
        durationMs
      }
    }
  };
}

export function createHttpErrorEvent(error, req, {
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

export async function captureHttpError(error, req, res, context, options = {}) {
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, { req, res, client: context.client, trace: context.trace })
    : createHttpErrorEvent(error, req, { ...options, trace: context.trace });

  try {
    context.client.issue(event.id, event.timestamp, event.attributes);
    const response = await context.client.shutdown(context.transport);
    await notifyFlush(options, response, { req, res, client: context.client, trace: context.trace });
    return response;
  } catch (captureError) {
    await notifyFailure(options, captureError, { req, res, client: context.client, trace: context.trace });
    throw captureError;
  }
}

async function captureHttpRequestFinish(options, { req, res, client, transport, startedAt }) {
  const trace = getRequestTraceContext(req);
  try {
    const durationMs = Math.max(0, Math.round(nowMs(options) - startedAt));
    const event = typeof options.requestEvent === "function"
      ? options.requestEvent(req, res, { client, durationMs, trace })
      : createHttpRequestEvent(req, res, { ...options, durationMs, trace });
    captureRequestEvent(client, event);
    const response = await client.shutdown(transport);
    await notifyFlush(options, response, { req, res, client, trace });
  } catch (error) {
    await notifyFailure(options, error, { req, res, client, trace });
  }
}

async function handleHttpHandlerError(options, { error, req, res, context }) {
  await captureHttpError(error, req, res, context, options)
    .catch(() => undefined);

  if (typeof options.onError === "function") {
    await options.onError(error, { req, res, client: context.client, trace: context.trace });
    return;
  }

  if (!res.headersSent) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Internal Server Error");
    return;
  }

  if (!res.writableEnded) {
    res.end();
  }
}

function resolveClient(options, req, res) {
  if (typeof options.client === "function") {
    return options.client({ req, res });
  }
  if (options.client) {
    return options.client;
  }
  return createLogBrewNodeClient(options);
}

function resolveTransport(options, req, res, client) {
  if (typeof options.transport === "function") {
    return options.transport({ req, res, client });
  }
  return options.transport ?? RecordingTransport.alwaysAccept();
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

async function captureFetchSpan(options, {
  durationMs,
  error,
  id,
  method,
  path,
  response,
  trace
}) {
  const statusCode = response?.status;
  const metadata = {
    ...primitiveMetadata(options.metadata),
    framework: "node:fetch",
    "http.request.method": method,
    "http.route": path,
    method,
    path,
    sampled: trace.sampled,
    "url.path": path,
    ...(statusCode !== undefined ? { "http.response.status_code": statusCode, statusCode } : {}),
    ...(error !== undefined ? {
      errorMessage: errorMessage(error),
      errorType: errorType(error)
    } : {})
  };
  const events = spanEvents(options.events, error);

  try {
    options.client.span(id, typeof options.now === "function" ? options.now() : new Date().toISOString(), {
      name: `${method} ${path}`,
      traceId: trace.traceId,
      spanId: trace.spanId,
      ...(trace.parentSpanId !== undefined ? { parentSpanId: trace.parentSpanId } : {}),
      status: error !== undefined || Number(statusCode ?? 0) >= 400 ? "error" : "ok",
      durationMs,
      ...(events !== undefined ? { events } : {}),
      ...(options.links !== undefined ? { links: options.links } : {}),
      metadata
    });
  } catch (captureError) {
    try {
      await notifyFailure(options, captureError, { client: options.client, error, response, trace });
    } catch {
      // Outbound fetch ownership stays with the app; telemetry callbacks must not replace HTTP outcomes.
    }
  }
}

async function captureDatabaseSpan(options, {
  durationMs,
  error,
  id,
  operationKind,
  operationName,
  system,
  trace
}) {
  const metadata = {
    ...databaseMetadata(options.metadata),
    framework: "node:database",
    "db.system.name": system,
    "db.operation.name": operationKind,
    dbSystem: system,
    dbOperation: operationName.trim(),
    dbOperationKind: operationKind,
    sampled: trace.sampled,
    ...(typeof options.databaseName === "string" && options.databaseName.trim() !== "" ? {
      "db.namespace": options.databaseName.trim(),
      dbName: options.databaseName.trim()
    } : {}),
    ...(typeof options.statementTemplate === "string" && options.statementTemplate.trim() !== "" ? {
      dbStatementTemplate: options.statementTemplate.trim()
    } : {}),
    ...(Number.isFinite(options.rowCount) ? {
      rowCount: Math.max(0, Math.trunc(options.rowCount))
    } : {}),
    ...(error !== undefined ? { errorType: errorType(error) } : {})
  };
  const events = spanEvents(options.events, error);

  try {
    options.client.span(id, typeof options.now === "function" ? options.now() : new Date().toISOString(), {
      name: `${system} ${operationKind} ${operationName.trim()}`,
      traceId: trace.traceId,
      spanId: trace.spanId,
      ...(trace.parentSpanId !== undefined ? { parentSpanId: trace.parentSpanId } : {}),
      status: error !== undefined ? "error" : "ok",
      durationMs,
      ...(events !== undefined ? { events } : {}),
      ...(options.links !== undefined ? { links: options.links } : {}),
      metadata
    });
  } catch (captureError) {
    try {
      await notifyFailure(options, captureError, { client: options.client, error, trace });
    } catch {
      // Database ownership stays with the app; telemetry callbacks must not replace operation outcomes.
    }
  }
}

async function operationWithLogBrewSpan(kind, operationName, options = {}) {
  const helperName = `${kind}OperationWithLogBrewSpan`;
  if (typeof operationName !== "string" || operationName.trim() === "") {
    throw new SdkError("configuration_error", `${helperName} requires a non-empty operation name`);
  }
  if (!options.client) {
    throw new SdkError("configuration_error", `${helperName} requires client`);
  }
  if (typeof options.operation !== "function") {
    throw new SdkError("configuration_error", `${helperName} requires operation`);
  }
  const system = normalizeDatabaseLabel(options.system, kind);
  const operationKind = normalizeDatabaseOperationKind(options.operationKind);
  const startedAt = nowMs(options);
  const trace = createChildTraceContext(helperName, resolveOperationTrace(options, getActiveLogBrewTrace()), options);
  const id = options.id ?? `evt_node_${kind}_${slugify(`${system}_${operationKind}_${operationName}`)}`;

  try {
    const result = await activeTraceContext.run(trace, options.operation);
    await captureOperationSpan(kind, options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      id,
      operationKind,
      operationName,
      system,
      trace
    });
    return result;
  } catch (error) {
    await captureOperationSpan(kind, options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      error,
      id,
      operationKind,
      operationName,
      system,
      trace
    });
    throw error;
  }
}

async function captureOperationSpan(kind, options, {
  durationMs,
  error,
  id,
  operationKind,
  operationName,
  system,
  trace
}) {
  const metadata = {
    ...operationMetadata(kind, options.metadata),
    framework: `node:${kind}`,
    ...(kind === "cache" ? { "db.system.name": system, "db.operation.name": operationKind, ...(typeof options.cacheName === "string" && options.cacheName.trim() !== "" ? { "db.namespace": options.cacheName.trim() } : {}) } : {}),
    ...(kind === "queue" ? { "messaging.system": system, "messaging.operation.name": operationKind, "messaging.operation.type": operationKind, ...(typeof options.queueName === "string" && options.queueName.trim() !== "" ? { "messaging.destination.name": options.queueName.trim() } : {}), ...(Number.isFinite(options.messageCount) && Math.max(0, Math.trunc(options.messageCount)) > 1 ? { "messaging.batch.message_count": Math.max(0, Math.trunc(options.messageCount)) } : {}) } : {}),
    [`${kind}System`]: system,
    [`${kind}Operation`]: operationName.trim(),
    [`${kind}OperationKind`]: operationKind,
    sampled: trace.sampled,
    ...cacheSpanMetadata(kind, options),
    ...queueSpanMetadata(kind, options),
    ...(error !== undefined ? { errorType: errorType(error) } : {})
  };
  const events = spanEvents(options.events, error);

  try {
    options.client.span(id, typeof options.now === "function" ? options.now() : new Date().toISOString(), {
      name: `${system} ${operationKind} ${operationName.trim()}`,
      traceId: trace.traceId,
      spanId: trace.spanId,
      ...(trace.parentSpanId !== undefined ? { parentSpanId: trace.parentSpanId } : {}),
      status: error !== undefined ? "error" : "ok",
      durationMs,
      ...(events !== undefined ? { events } : {}),
      ...(options.links !== undefined ? { links: options.links } : {}),
      metadata
    });
  } catch (captureError) {
    try {
      await notifyFailure(options, captureError, { client: options.client, error, trace });
    } catch {
      // Cache and queue ownership stays with the app; telemetry callbacks must not replace operation outcomes.
    }
  }
}

function createFetchTraceContext(trace, {
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory
} = {}) {
  return createChildTraceContext("fetchWithLogBrewSpan", trace, { spanIdFactory, traceIdFactory });
}

function createChildTraceContext(source, trace, {
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory
} = {}) {
  const spanId = normalizeSpanId(spanIdFactory());
  if (!spanId) {
    throw new SdkError("configuration_error", `${source} requires spanIdFactory to return a valid span id`);
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
    throw new SdkError("configuration_error", `${source} requires traceIdFactory to return a valid trace id`);
  }
  return {
    traceId,
    spanId,
    sampled: true
  };
}

function withFetchTraceparent(input, init = {}, traceparent) {
  return {
    ...(init ?? {}),
    headers: fetchHeadersWithTraceparent(init?.headers ?? getFetchInputHeaders(input), traceparent)
  };
}

function fetchHeadersWithTraceparent(headers, traceparent) {
  if (typeof globalThis.Headers === "function") {
    const nextHeaders = new globalThis.Headers(headers ?? undefined);
    nextHeaders.set("traceparent", traceparent);
    return nextHeaders;
  }
  if (Array.isArray(headers)) {
    return [
      ...headers.filter(([key]) => String(key).toLowerCase() !== "traceparent"),
      ["traceparent", traceparent]
    ];
  }
  return {
    ...(headers ?? {}),
    traceparent
  };
}

function getFetchInputHeaders(input) {
  return isRequest(input) ? input.headers : undefined;
}

function getFetchMethod(input, init = {}) {
  const method = init?.method ?? (isRequest(input) ? input.method : "GET");
  return String(method).toUpperCase();
}

function getFetchUrl(input) {
  if (isRequest(input)) {
    return input.url;
  }
  if (typeof globalThis.URL === "function" && input instanceof globalThis.URL) {
    return input.href;
  }
  return String(input);
}

function isRequest(input) {
  return typeof globalThis.Request === "function" && input instanceof globalThis.Request;
}

function defaultFetchSpanId({ method, path }) {
  return `evt_node_fetch_${slugify(`${method}_${path}`)}`;
}

function defaultDatabaseSpanId({ operationKind, operationName, system }) {
  return `evt_node_database_${slugify(`${system}_${operationKind}_${operationName}`)}`;
}

function defaultTraceIdFactory() {
  return randomHex(16);
}

function primitiveMetadata(metadata) {
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ))
  );
}

function databaseMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(primitiveMetadata(metadata)).filter(([key]) => isSafeDatabaseMetadataKey(key))
  );
}

function operationMetadata(kind, metadata) {
  return Object.fromEntries(
    Object.entries(primitiveMetadata(metadata)).filter(([key]) => isSafeOperationMetadataKey(kind, key))
  );
}

function spanEvents(events, error) {
  const exceptionEvents = exceptionSpanEvent(error);
  if (events === undefined) {
    return exceptionEvents.length > 0 ? exceptionEvents : undefined;
  }
  if (!Array.isArray(events) || events.length > MAX_SPAN_EVENTS) {
    return events;
  }
  if (exceptionEvents.length === 0) {
    return events.length > 0 ? events : undefined;
  }
  return events.slice(0, MAX_SPAN_EVENTS - exceptionEvents.length).concat(exceptionEvents);
}

function exceptionSpanEvent(error) {
  return error === undefined
    ? []
    : [{ name: "exception", metadata: { exceptionEscaped: true, exceptionType: errorType(error) } }];
}

function cacheSpanMetadata(kind, options) {
  if (kind !== "cache") {
    return {};
  }
  return {
    ...(typeof options.cacheName === "string" && options.cacheName.trim() !== "" ? { cacheName: options.cacheName.trim() } : {}),
    ...(typeof options.hit === "boolean" ? { cacheHit: options.hit } : {}),
    ...(Number.isFinite(options.itemSizeBytes) ? { itemSizeBytes: Math.max(0, Math.trunc(options.itemSizeBytes)) } : {}),
    ...(Number.isFinite(options.itemCount) ? { itemCount: Math.max(0, Math.trunc(options.itemCount)) } : {})
  };
}

function queueSpanMetadata(kind, options) {
  if (kind !== "queue") {
    return {};
  }
  return {
    ...(typeof options.queueName === "string" && options.queueName.trim() !== "" ? { queueName: options.queueName.trim() } : {}),
    ...(typeof options.taskName === "string" && options.taskName.trim() !== "" ? { taskName: options.taskName.trim() } : {}),
    ...(Number.isFinite(options.messageCount) ? { messageCount: Math.max(0, Math.trunc(options.messageCount)) } : {})
  };
}

function isSafeDatabaseMetadataKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ![
    "authorization",
    "connection",
    "connectionstring",
    "cookie",
    "dbquery",
    "dbquerytext",
    "dbstatement",
    "headers",
    "host",
    "params",
    "parameters",
    ["pass", "word"].join(""),
    "query",
    "rawquery",
    ["se", "cret"].join(""),
    "sql",
    "sqltext",
    "statement",
    ["to", "ken"].join(""),
    "url",
    "user",
    "username"
  ].includes(normalized);
}

function isSafeOperationMetadataKey(kind, key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const blocked = kind === "queue" ? [
    "args",
    "body",
    "brokerurl",
    "cookie",
    "headers",
    "message",
    "messagebody",
    "payload",
    "rawmessage",
    ["se", "cret"].join(""),
    ["to", "ken"].join(""),
    "url"
  ] : [
    "cachekey",
    "command",
    "cookie",
    "headers",
    "key",
    "rawcommand",
    ["se", "cret"].join(""),
    ["to", "ken"].join(""),
    "value"
  ];
  return !blocked.includes(normalized);
}

function normalizeDatabaseLabel(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

function normalizeDatabaseOperationKind(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return "operation";
  }
  const normalized = value.trim().replace(/[^a-z0-9_.:-]+/gi, "_").replace(/^_+|_+$/g, "");
  return normalized.toUpperCase() === normalized ? normalized : normalized.toLowerCase();
}

function defaultRequestEventId(req, res) {
  return `evt_node_request_${slugify(`${req.method ?? "GET"}_${getRequestPath(req)}_${res.statusCode ?? 0}`)}`;
}

function defaultSpanIdFactory() {
  return randomHex(8);
}

function defaultErrorEventId(error, req) {
  const message = error instanceof Error ? error.message : String(error);
  return `evt_node_error_${slugify(`${req.method ?? "GET"}_${getRequestPath(req)}_${message}`)}`;
}

function getRequestPath(req) {
  return pathOnly(req.url ?? "/");
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
        framework: "node:http",
        "http.request.method": method,
        "http.response.status_code": statusCode,
        method, path,
        sampled: traceContext.sampled,
        statusCode, "url.path": path
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

function nowMs(options) {
  if (typeof options.nowMs === "function") {
    return options.nowMs();
  }
  return performance.now();
}

function defaultFetch() {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
}

function readEnvApiKey() {
  return globalThis.process?.env?.LOGBREW_API_KEY;
}

function readEnvServerApiKey() {
  return globalThis.process?.env?.LOGBREW_SERVER_API_KEY;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorType(error) {
  return error instanceof Error && error.name ? error.name : "Error";
}

function isPromiseLike(value) {
  return value !== null && typeof value === "object" && typeof value.then === "function";
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

export default {
  cacheOperationWithLogBrewSpan,
  captureHttpError,
  createNodeFetchTransport,
  createHttpErrorEvent,
  createHttpRequestEvent,
  createLogBrewNodeClient,
  createLogBrewNodeContext,
  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  databaseOperationWithLogBrewSpan,
  fetchWithLogBrewSpan,
  getActiveLogBrewTrace,
  instrumentLogBrewPgClient,
  instrumentLogBrewRedisClient,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan,
  withLogBrewHttpHandler
};
