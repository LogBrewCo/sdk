"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { catchError, Observable, tap, throwError } = require("rxjs");
const {
  LogBrewClient,
  RecordingTransport,
  SdkError,
  parseTraceparent
} = require("@logbrew/sdk");

const DEFAULT_SDK_NAME = "logbrew-nestjs";
const DEFAULT_SDK_VERSION = "0.1.1";
const activeTraceContext = new AsyncLocalStorage();

function createLogBrewNestClient({
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

class LogBrewInterceptor {
  constructor(options = {}) {
    this.options = options;
  }

  intercept(executionContext, next) {
    const http = executionContext.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    const client = resolveClient(this.options, executionContext, request, response);
    const transport = resolveTransport(this.options, executionContext, request, response, client);
    const trace = createRequestTraceContext(request, response, this.options);
    const shutdownClient = shouldShutdownClient(this.options);
    const startedAt = nowMs(this.options);

    request.logbrew = createRequestContext(client, transport, trace, shutdownClient);

    return new Observable((subscriber) => activeTraceContext.run(trace, () =>
      next.handle().pipe(
        tap({
          complete: () => {
            if (this.options.captureRequests !== false || this.options.captureRequestMetrics === true) {
              void captureRequestFinish(this.options, {
                client,
                executionContext,
                request,
                response,
                shutdownClient,
                startedAt,
                trace,
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
            shutdownClient,
            trace,
            transport
          });
          return throwError(() => error);
        })
      ).subscribe(subscriber)
    ));
  }
}

function getActiveLogBrewTrace() {
  return activeTraceContext.getStore();
}

function createLogBrewNestLogger(options = {}) {
  const client = options.client ?? createLogBrewNestClient(options);
  const logger = options.logger ?? "nestjs";
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultLoggerEventId;
  const onCaptureError = typeof options.onCaptureError === "function" ? options.onCaptureError : () => {};
  const state = {
    captured: 0,
    pendingFlush: Promise.resolve(null)
  };
  const baseLogger = options.baseLogger;

  function notifyCaptureError(error) {
    try {
      void Promise.resolve(onCaptureError(error)).catch(() => {});
    } catch {
      // Logger error handlers must not make application logging throw.
    }
  }

  function capture(level, message, context) {
    try {
      state.captured += 1;
      const normalizedLevel = normalizeLoggerLevel(level);
      const timestamp = now();
      const metadata = loggerMetadata({
        context,
        logger,
        message,
        trace: getActiveLogBrewTrace()
      });
      const id = idFactory(normalizedLevel, message, context, state.captured);

      if ((normalizedLevel === "error" || normalizedLevel === "critical") && options.captureErrorsAsIssues !== false) {
        client.issue(id, timestamp, {
          title: `${context || logger} ${normalizedLevel === "critical" ? "critical" : "error"}`,
          level: normalizedLevel,
          message: messageText(message),
          metadata
        });
      } else {
        client.log(id, timestamp, {
          message: messageText(message),
          level: normalizedLevel,
          logger,
          metadata
        });
      }

      if (options.flushOnCapture === true && options.transport) {
        state.pendingFlush = Promise.resolve(client.flush(options.transport)).catch((error) => {
          notifyCaptureError(error);
          return null;
        });
      }
    } catch (error) {
      notifyCaptureError(error);
    }
  }

  return {
    client,
    transport: options.transport,
    log(message, context) {
      forwardLoggerCall(baseLogger, "log", [message, context]);
      capture("info", message, context);
    },
    error(message, stack, context) {
      forwardLoggerCall(baseLogger, "error", [message, stack, context]);
      capture("error", message, context);
    },
    warn(message, context) {
      forwardLoggerCall(baseLogger, "warn", [message, context]);
      capture("warning", message, context);
    },
    debug(message, context) {
      forwardLoggerCall(baseLogger, "debug", [message, context]);
      capture("info", message, context);
    },
    verbose(message, context) {
      forwardLoggerCall(baseLogger, "verbose", [message, context]);
      capture("info", message, context);
    },
    fatal(message, stack, context) {
      forwardLoggerCall(baseLogger, "fatal", [message, stack, context]);
      capture("critical", message, context);
    },
    setLogLevels(levels) {
      forwardLoggerCall(baseLogger, "setLogLevels", [levels]);
    },
    flush() {
      if (options.transport && client.pendingEvents() > 0) {
        state.pendingFlush = Promise.resolve(client.flush(options.transport)).catch((error) => {
          notifyCaptureError(error);
          return null;
        });
      }
      return state.pendingFlush;
    },
    shutdown() {
      if (options.transport) {
        state.pendingFlush = Promise.resolve(client.shutdown(options.transport)).catch((error) => {
          notifyCaptureError(error);
          return null;
        });
      }
      return state.pendingFlush;
    }
  };
}

function createRequestEvent(request, response, {
  now = () => new Date().toISOString(),
  durationMs = 0,
  idFactory = defaultRequestEventId,
  spanIdFactory = defaultSpanIdFactory,
  trace
} = {}) {
  const method = request.method ?? "GET";
  const path = getRequestPath(request);
  const statusCode = Number(response.statusCode ?? 0);
  const id = idFactory(request, response);
  const requestTrace = trace ?? getRequestTraceContext(request) ?? createRequestTraceContext(request, response, { spanIdFactory });
  const spanEvent = requestTrace
    ? createTraceparentRequestSpan(requestTrace, {
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

function createErrorEvent(error, request, {
  now = () => new Date().toISOString(),
  idFactory = defaultErrorEventId,
  trace
} = {}) {
  const method = request.method ?? "GET";
  const path = getRequestPath(request);
  const message = error instanceof Error ? error.message : String(error);
  const requestTrace = trace ?? getRequestTraceContext(request);
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
        ...traceMetadata(requestTrace)
      }
    }
  };
}

function createRequestMetricEvent(request, response, {
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

function createRequestContext(client, transport, trace, shutdownClient) {
  return {
    client,
    logbrew: client,
    trace,
    transport,
    previewJson: () => client.previewJson(),
    flush: () => client.flush(transport),
    shutdown: () => flushCapturedClient(client, transport, shutdownClient)
  };
}

async function captureRequestFinish(options, {
  client,
  executionContext,
  request,
  response,
  shutdownClient,
  startedAt,
  trace,
  transport
}) {
  try {
    const durationMs = Math.max(0, Math.round(nowMs(options) - startedAt));
    if (options.captureRequests !== false) {
      const event = typeof options.requestEvent === "function"
        ? options.requestEvent(request, response, { client, durationMs, executionContext, trace })
        : createRequestEvent(request, response, { ...options, durationMs, trace });
      captureRequestEvent(client, event);
    }
    if (options.captureRequestMetrics === true) {
      const metricEvent = typeof options.requestMetricEvent === "function"
        ? options.requestMetricEvent(request, response, { client, durationMs, executionContext, trace })
        : createRequestMetricEvent(request, response, {
          ...options,
          durationMs,
          idFactory: options.metricIdFactory
        });
      captureRequestMetricEvent(client, metricEvent);
    }
    const transportResponse = await flushCapturedClient(client, transport, shutdownClient);
    await notifyFlush(options, transportResponse, { client, executionContext, request, response, trace });
  } catch (error) {
    await notifyFailure(options, error, { client, executionContext, request, response, trace });
  }
}

async function captureRequestError(options, {
  client,
  error,
  executionContext,
  request,
  response,
  shutdownClient,
  trace,
  transport
}) {
  const requestTrace = trace ?? getRequestTraceContext(request) ?? getActiveLogBrewTrace();
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, { client, executionContext, request, response, trace: requestTrace })
    : createErrorEvent(error, request, { ...options, trace: requestTrace });

  try {
    client.issue(event.id, event.timestamp, event.attributes);
    const transportResponse = await flushCapturedClient(client, transport, shutdownClient);
    await notifyFlush(options, transportResponse, { client, executionContext, request, response, trace: requestTrace });
  } catch (captureError) {
    await notifyFailure(options, captureError, { client, executionContext, request, response, trace: requestTrace });
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

function shouldShutdownClient(options) {
  return !options.client;
}

function flushCapturedClient(client, transport, shutdownClient) {
  return shutdownClient ? client.shutdown(transport) : client.flush(transport);
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

function defaultLoggerEventId(level, _message, context, sequence) {
  return `evt_nestjs_logger_${level}_${slugify(context || "app")}_${sequence}`;
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

function createRequestTraceContext(request, response, {
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

function loggerMetadata({ context, logger, message, trace }) {
  return {
    framework: "nestjs",
    logger,
    ...(context ? { context } : {}),
    ...errorMetadata(message),
    ...traceMetadata(trace)
  };
}

function errorMetadata(message) {
  if (message instanceof Error) {
    return { errorType: message.name || "Error" };
  }
  return {};
}

function normalizeLoggerLevel(level) {
  if (level === "warning" || level === "error" || level === "critical") {
    return level;
  }
  return "info";
}

function messageText(message) {
  if (message instanceof Error) {
    return message.message;
  }
  if (typeof message === "string") {
    return message;
  }
  if (typeof message === "number" || typeof message === "boolean" || typeof message === "bigint") {
    return String(message);
  }
  if (message === undefined || message === null) {
    return String(message);
  }
  return Object.prototype.toString.call(message);
}

function forwardLoggerCall(baseLogger, method, args) {
  const target = baseLogger?.[method];
  if (typeof target === "function") {
    target.apply(baseLogger, args);
  }
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
        framework: "nestjs",
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

module.exports = {
  createErrorEvent,
  getActiveLogBrewTrace,
  createLogBrewNestLogger,
  createLogBrewNestClient,
  createRequestMetricEvent,
  createRequestEvent,
  default: {
    createErrorEvent,
    getActiveLogBrewTrace,
    createLogBrewNestLogger,
    createLogBrewNestClient,
    createRequestMetricEvent,
    createRequestEvent,
    LogBrewInterceptor
  },
  LogBrewInterceptor
};
