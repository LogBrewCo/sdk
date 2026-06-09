import { catchError, tap, throwError } from "rxjs";
import {
  LogBrewClient,
  RecordingTransport,
  SdkError,
  parseTraceparent,
  spanAttributesFromTraceparent
} from "@logbrew/sdk";

const DEFAULT_SDK_NAME = "logbrew-nestjs";
const DEFAULT_SDK_VERSION = "0.1.1";

export function createLogBrewNestClient({
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
      "createLogBrewNestClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
    );
  }
  return LogBrewClient.create({ apiKey: authKey, sdkName, sdkVersion, maxRetries });
}

export class LogBrewInterceptor {
  constructor(options = {}) {
    this.options = options;
  }

  intercept(executionContext, next) {
    const http = executionContext.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    const client = resolveClient(this.options, executionContext, request, response);
    const transport = resolveTransport(this.options, executionContext, request, response, client);
    const startedAt = nowMs(this.options);

    request.logbrew = createRequestContext(client, transport);

    return next.handle().pipe(
      tap({
        complete: () => {
          if (this.options.captureRequests !== false || this.options.captureRequestMetrics === true) {
            void captureRequestFinish(this.options, {
              client,
              executionContext,
              request,
              response,
              startedAt,
              transport
            });
          }
        }
      }),
      catchError((error) => {
        void captureRequestError(this.options, {
          client,
          error,
          executionContext,
          request,
          response,
          transport
        });
        return throwError(() => error);
      })
    );
  }
}

export function createRequestEvent(request, response, {
  now = () => new Date().toISOString(),
  durationMs = 0,
  idFactory = defaultRequestEventId,
  spanIdFactory = defaultSpanIdFactory
} = {}) {
  const method = request.method ?? "GET";
  const path = getRequestPath(request);
  const statusCode = Number(response.statusCode ?? 0);
  const id = idFactory(request, response);
  const traceparent = getTraceparentHeader(request);
  const spanEvent = traceparent
    ? createTraceparentRequestSpan(traceparent, {
      durationMs,
      id,
      method,
      now,
      path,
      spanIdFactory: () => spanIdFactory(request, response),
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
      logger: "nestjs",
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
  idFactory = defaultErrorEventId
} = {}) {
  const method = request.method ?? "GET";
  const path = getRequestPath(request);
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: idFactory(error, request),
    timestamp: now(),
    attributes: {
      title: `${method} ${path} failed`,
      level: "error",
      message,
      metadata: {
        method,
        path
      }
    }
  };
}

export function createRequestMetricEvent(request, response, {
  now = () => new Date().toISOString(),
  durationMs = 0,
  idFactory = defaultRequestMetricEventId,
  metricName = "http.server.duration"
} = {}) {
  const method = request.method ?? "GET";
  const routeTemplate = getRouteTemplate(request);
  const statusCode = Number(response.statusCode ?? 0);
  return {
    id: idFactory(request, response),
    timestamp: now(),
    attributes: {
      name: metricName,
      kind: "histogram",
      value: Math.max(0, Number(durationMs)),
      unit: "ms",
      temporality: "delta",
      metadata: {
        framework: "nestjs",
        method,
        routeTemplate,
        statusCode,
        statusCodeClass: statusCodeClass(statusCode)
      }
    }
  };
}

function createRequestContext(client, transport) {
  return {
    client,
    logbrew: client,
    transport,
    previewJson: () => client.previewJson(),
    flush: () => client.flush(transport),
    shutdown: () => client.shutdown(transport)
  };
}

async function captureRequestFinish(options, {
  client,
  executionContext,
  request,
  response,
  startedAt,
  transport
}) {
  try {
    const durationMs = Math.max(0, Math.round(nowMs(options) - startedAt));
    if (options.captureRequests !== false) {
      const event = typeof options.requestEvent === "function"
        ? options.requestEvent(request, response, { client, durationMs, executionContext })
        : createRequestEvent(request, response, { ...options, durationMs });
      captureRequestEvent(client, event);
    }
    if (options.captureRequestMetrics === true) {
      const metricEvent = typeof options.requestMetricEvent === "function"
        ? options.requestMetricEvent(request, response, { client, durationMs, executionContext })
        : createRequestMetricEvent(request, response, {
          ...options,
          durationMs,
          idFactory: options.metricIdFactory
        });
      captureRequestMetricEvent(client, metricEvent);
    }
    const transportResponse = await client.shutdown(transport);
    await notifyFlush(options, transportResponse, { client, executionContext, request, response });
  } catch (error) {
    await notifyFailure(options, error, { client, executionContext, request, response });
  }
}

async function captureRequestError(options, {
  client,
  error,
  executionContext,
  request,
  response,
  transport
}) {
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, { client, executionContext, request, response })
    : createErrorEvent(error, request, options);

  try {
    client.issue(event.id, event.timestamp, event.attributes);
    const transportResponse = await client.shutdown(transport);
    await notifyFlush(options, transportResponse, { client, executionContext, request, response });
  } catch (captureError) {
    await notifyFailure(options, captureError, { client, executionContext, request, response });
  }
}

function resolveClient(options, executionContext, request, response) {
  if (typeof options.client === "function") {
    return options.client({ executionContext, request, response });
  }
  if (options.client) {
    return options.client;
  }
  return createLogBrewNestClient(options);
}

function resolveTransport(options, executionContext, request, response, client) {
  if (typeof options.transport === "function") {
    return options.transport({ client, executionContext, request, response });
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

function defaultRequestEventId(request, response) {
  return `evt_nestjs_request_${slugify(`${request.method ?? "GET"}_${getRequestPath(request)}_${response.statusCode ?? 0}`)}`;
}

function defaultSpanIdFactory() {
  return randomHex(8);
}

function defaultErrorEventId(error, request) {
  const message = error instanceof Error ? error.message : String(error);
  return `evt_nestjs_error_${slugify(`${request.method ?? "GET"}_${getRequestPath(request)}_${message}`)}`;
}

function defaultRequestMetricEventId(request, response) {
  return `evt_nestjs_metric_${slugify(`${request.method ?? "GET"}_${getRouteTemplate(request)}_${response.statusCode ?? 0}`)}`;
}

function getRequestPath(request) {
  return pathOnly(request.originalUrl ?? request.url ?? "/");
}

function getRouteTemplate(request) {
  const routePath = request.route?.path;
  if (typeof routePath === "string") {
    const baseUrl = request.baseUrl ?? "";
    if (baseUrl && routePath.startsWith(baseUrl)) {
      return pathOnly(routePath);
    }
    return pathOnly(`${baseUrl}${routePath}`);
  }
  return getRequestPath(request);
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

function createTraceparentRequestSpan(traceparent, {
  durationMs,
  id,
  method,
  now,
  path,
  spanIdFactory,
  statusCode
}) {
  if (!traceparent) {
    return undefined;
  }

  try {
    parseTraceparent(traceparent);
    const spanId = spanIdFactory();
    return {
      id,
      timestamp: now(),
      type: "span",
      attributes: spanAttributesFromTraceparent(traceparent, {
        durationMs,
        metadata: {
          framework: "nestjs",
          method,
          path,
          statusCode
        },
        name: `${method} ${path}`,
        spanId,
        status: statusCode >= 500 ? "error" : "ok"
      })
    };
  } catch {
    return undefined;
  }
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

export default {
  createErrorEvent,
  createLogBrewNestClient,
  createRequestMetricEvent,
  createRequestEvent,
  LogBrewInterceptor
};
