import fp from "fastify-plugin";
import {
  LogBrewClient,
  RecordingTransport,
  parseTraceparent,
  SdkError
} from "@logbrew/sdk";
import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_SDK_NAME = "logbrew-fastify";
const DEFAULT_SDK_VERSION = "0.1.0";
const activeTraceContext = new AsyncLocalStorage();

export function createLogBrewFastifyClient({
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
      "createLogBrewFastifyClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
    );
  }
  return LogBrewClient.create({ apiKey: authKey, sdkName, sdkVersion, maxRetries });
}

async function logbrewFastifyPluginImpl(fastify, options = {}) {
  ensureRequestDecorator(fastify);

  const startedAtByRequest = new WeakMap();

  fastify.addHook("onRequest", async (request, reply) => {
    const client = resolveClient(options, request, reply);
    const transport = resolveTransport(options, request, reply, client);
    const trace = createRequestTraceContext(request, reply, options);
    startedAtByRequest.set(request, nowMs(options));
    request.logbrew = createRequestContext(client, transport, trace);
    enterRequestTraceContext(request);
  });

  fastify.addHook("preHandler", async (request) => {
    enterRequestTraceContext(request);
  });

  if (options.captureRequests !== false || options.captureRequestMetrics === true) {
    fastify.addHook("onResponse", async (request, reply) => {
      enterRequestTraceContext(request);
      const startedAt = startedAtByRequest.get(request) ?? nowMs(options);
      await captureRequestFinish(options, { request, reply, startedAt });
    });
  }

  fastify.addHook("onError", async (request, reply, error) => {
    enterRequestTraceContext(request);
    await captureRequestError(options, { request, reply, error });
  });
}

export const logbrewFastifyPlugin = fp(logbrewFastifyPluginImpl, {
  fastify: ">=4",
  name: "logbrew-fastify"
});
export const logbrewPlugin = logbrewFastifyPlugin;

export function getActiveLogBrewTrace() {
  return activeTraceContext.getStore();
}

export function createRequestEvent(request, reply, {
  now = () => new Date().toISOString(),
  durationMs = 0,
  idFactory = defaultRequestEventId,
  spanIdFactory = defaultSpanIdFactory,
  trace = undefined
} = {}) {
  const method = request.method ?? "GET";
  const path = getRequestPath(request);
  const statusCode = Number(reply.statusCode ?? 0);
  const id = idFactory(request, reply);
  const traceContext = trace ?? getRequestTraceContext(request) ?? createRequestTraceContext(request, reply, { spanIdFactory });
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
      logger: "fastify",
      metadata: {
        method,
        path,
        statusCode,
        durationMs
      }
    }
  };
}

export function createErrorEvent(error, request, {
  now = () => new Date().toISOString(),
  idFactory = defaultErrorEventId,
  trace = undefined
} = {}) {
  const method = request.method ?? "GET";
  const path = getRequestPath(request);
  const message = error instanceof Error ? error.message : String(error);
  const traceContext = trace ?? getRequestTraceContext(request) ?? getActiveLogBrewTrace();
  return {
    id: idFactory(error, request),
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

export function createRequestMetricEvent(request, reply, {
  now = () => new Date().toISOString(),
  durationMs = 0,
  idFactory = defaultRequestMetricEventId,
  metricName = "http.server.duration"
} = {}) {
  const method = request.method ?? "GET";
  const routeTemplate = getRouteTemplate(request);
  const statusCode = Number(reply.statusCode ?? 0);
  return {
    id: idFactory(request, reply),
    timestamp: now(),
    attributes: {
      name: metricName,
      kind: "histogram",
      value: durationMs,
      unit: "ms",
      temporality: "delta",
      metadata: {
        framework: "fastify",
        method,
        routeTemplate,
        statusCode,
        statusCodeClass: statusCodeClass(statusCode)
      }
    }
  };
}

function ensureRequestDecorator(fastify) {
  if (typeof fastify.hasRequestDecorator === "function" && fastify.hasRequestDecorator("logbrew")) {
    return;
  }
  try {
    fastify.decorateRequest("logbrew", null);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? error.code : "";
    if (code !== "FST_ERR_DEC_ALREADY_PRESENT") {
      throw error;
    }
  }
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

async function captureRequestFinish(options, { request, reply, startedAt }) {
  const existing = request.logbrew;
  if (!existing) {
    return;
  }
  const trace = existing.trace;
  try {
    const durationMs = Math.max(0, Math.round(nowMs(options) - startedAt));
    if (options.captureRequests !== false) {
      const event = typeof options.requestEvent === "function"
        ? options.requestEvent(request, reply, { client: existing.client, durationMs, trace })
        : createRequestEvent(request, reply, { ...options, durationMs, trace });
      captureRequestEvent(existing.client, event);
    }
    if (options.captureRequestMetrics === true) {
      const metricEvent = typeof options.requestMetricEvent === "function"
        ? options.requestMetricEvent(request, reply, { client: existing.client, durationMs, trace })
        : createRequestMetricEvent(request, reply, {
          ...options,
          durationMs,
          idFactory: options.metricIdFactory
        });
      captureRequestMetricEvent(existing.client, metricEvent);
    }
    const response = await existing.client.shutdown(existing.transport);
    await notifyFlush(options, response, { request, reply, client: existing.client, trace });
  } catch (error) {
    await notifyFailure(options, error, { request, reply, client: existing.client, trace });
  }
}

async function captureRequestError(options, { request, reply, error }) {
  const existing = request.logbrew;
  const client = existing?.client ?? resolveClient(options, request, reply);
  const transport = existing?.transport ?? resolveTransport(options, request, reply, client);
  const trace = existing?.trace ?? getActiveLogBrewTrace();
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, { request, reply, client, trace })
    : createErrorEvent(error, request, { ...options, trace });

  try {
    client.issue(event.id, event.timestamp, event.attributes);
    const response = await client.shutdown(transport);
    await notifyFlush(options, response, { request, reply, client, trace });
  } catch (captureError) {
    await notifyFailure(options, captureError, { request, reply, client, trace });
  }
}

function resolveClient(options, request, reply) {
  if (typeof options.client === "function") {
    return options.client({ request, reply });
  }
  if (options.client) {
    return options.client;
  }
  return createLogBrewFastifyClient(options);
}

function resolveTransport(options, request, reply, client) {
  if (typeof options.transport === "function") {
    return options.transport({ request, reply, client });
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

function defaultRequestEventId(request, reply) {
  return `evt_fastify_request_${slugify(`${request.method ?? "GET"}_${getRequestPath(request)}_${reply.statusCode ?? 0}`)}`;
}

function defaultRequestMetricEventId(request, reply) {
  return `evt_fastify_metric_${slugify(`${request.method ?? "GET"}_${getRouteTemplate(request)}_${reply.statusCode ?? 0}`)}`;
}

function defaultSpanIdFactory() {
  return randomHex(8);
}

function defaultErrorEventId(error, request) {
  const message = error instanceof Error ? error.message : String(error);
  return `evt_fastify_error_${slugify(`${request.method ?? "GET"}_${getRequestPath(request)}_${message}`)}`;
}

function getRequestPath(request) {
  return pathOnly(request.url ?? "/");
}

function getRouteTemplate(request) {
  return pathOnly(
    request.routeOptions?.url
    ?? request.routerPath
    ?? request.routeConfig?.url
    ?? request.url
    ?? "/"
  );
}

function pathOnly(value) {
  const rawValue = typeof value === "string" ? value : String(value);
  try {
    return new URL(rawValue, "http://localhost").pathname || "/";
  } catch {
    return rawValue.split("?")[0] || "/";
  }
}

function getTraceparentHeader(request) {
  const value = request.headers?.traceparent;
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
        framework: "fastify",
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

function createRequestTraceContext(request, reply, {
  spanIdFactory = defaultSpanIdFactory
} = {}) {
  const traceparent = getTraceparentHeader(request);
  if (!traceparent) {
    return undefined;
  }

  try {
    const context = parseTraceparent(traceparent);
    const spanId = normalizeSpanId(spanIdFactory(request, reply));
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

function enterRequestTraceContext(request) {
  activeTraceContext.enterWith(getRequestTraceContext(request));
}

function getRequestTraceContext(request) {
  return request.logbrew?.trace;
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

function nowMs(options) {
  if (typeof options.nowMs === "function") {
    return options.nowMs();
  }
  return performance.now();
}

function readEnvApiKey() {
  return globalThis.process?.env?.LOGBREW_API_KEY;
}

function readEnvServerApiKey() {
  return globalThis.process?.env?.LOGBREW_SERVER_API_KEY;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

function statusCodeClass(statusCode) {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) {
    return "unknown";
  }
  return `${Math.floor(statusCode / 100)}xx`;
}

export default {
  createErrorEvent,
  createLogBrewFastifyClient,
  createRequestMetricEvent,
  createRequestEvent,
  getActiveLogBrewTrace,
  logbrewFastifyPlugin,
  logbrewPlugin
};
