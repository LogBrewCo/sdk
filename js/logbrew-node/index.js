import {
  LogBrewClient,
  RecordingTransport,
  createTraceparentHeaders,
  parseTraceparent,
  SdkError,
  TransportError
} from "@logbrew/sdk";
import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_SDK_NAME = "logbrew-node";
const DEFAULT_SDK_VERSION = "0.1.0";
const DEFAULT_ENDPOINT = "https://api.logbrew.com/v1/events";
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
    method,
    path,
    sampled: trace.sampled,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(error !== undefined ? {
      errorMessage: errorMessage(error),
      errorType: errorType(error)
    } : {})
  };

  try {
    options.client.span(id, typeof options.now === "function" ? options.now() : new Date().toISOString(), {
      name: `${method} ${path}`,
      traceId: trace.traceId,
      spanId: trace.spanId,
      ...(trace.parentSpanId !== undefined ? { parentSpanId: trace.parentSpanId } : {}),
      status: error !== undefined || Number(statusCode ?? 0) >= 400 ? "error" : "ok",
      durationMs,
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

function createFetchTraceContext(trace, {
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory
} = {}) {
  const spanId = normalizeSpanId(spanIdFactory());
  if (!spanId) {
    throw new SdkError("configuration_error", "fetchWithLogBrewSpan requires spanIdFactory to return a valid span id");
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
    throw new SdkError("configuration_error", "fetchWithLogBrewSpan requires traceIdFactory to return a valid trace id");
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

function normalizeTraceId(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const traceId = value.toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(traceId) || traceId === "00000000000000000000000000000000") {
    return undefined;
  }
  return traceId;
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
  captureHttpError,
  createNodeFetchTransport,
  createHttpErrorEvent,
  createHttpRequestEvent,
  createLogBrewNodeClient,
  createLogBrewNodeContext,
  fetchWithLogBrewSpan,
  getActiveLogBrewTrace,
  withLogBrewHttpHandler
};
