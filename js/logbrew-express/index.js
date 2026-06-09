import {
  LogBrewClient,
  RecordingTransport,
  parseTraceparent,
  SdkError,
  spanAttributesFromTraceparent
} from "@logbrew/sdk";

const DEFAULT_SDK_NAME = "logbrew-express";
const DEFAULT_SDK_VERSION = "0.1.0";

export function createLogBrewExpressClient({
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

export function logbrewMiddleware(options = {}) {
  return function logBrewExpressMiddleware(req, res, next) {
    const client = resolveClient(options, req, res);
    const transport = resolveTransport(options, req, res, client);
    const startedAt = nowMs(options);

    req.logbrew = createRequestContext(client, transport);

    if (options.captureRequests !== false || options.captureRequestMetrics === true) {
      res.once("finish", () => {
        void captureRequestFinish(options, { req, res, client, transport, startedAt });
      });
    }

    next();
  };
}

export function logbrewErrorHandler(options = {}) {
  return function logBrewExpressErrorHandler(error, req, res, next) {
    const existing = req.logbrew;
    const client = existing?.client ?? resolveClient(options, req, res);
    const transport = existing?.transport ?? resolveTransport(options, req, res, client);
    const event = typeof options.errorEvent === "function"
      ? options.errorEvent(error, { req, res, client })
      : createErrorEvent(error, req, options);

    try {
      client.issue(event.id, event.timestamp, event.attributes);
      void client.shutdown(transport)
        .then((response) => notifyFlush(options, response, { req, res, client }))
        .catch((flushError) => notifyFailure(options, flushError, { req, res, client }));
    } catch (captureError) {
      void notifyFailure(options, captureError, { req, res, client });
    }

    next(error);
  };
}

export function createRequestEvent(req, res, {
  now = () => new Date().toISOString(),
  durationMs = 0,
  idFactory = defaultRequestEventId,
  spanIdFactory = defaultSpanIdFactory
} = {}) {
  const method = req.method ?? "GET";
  const path = getRequestPath(req);
  const statusCode = Number(res.statusCode ?? 0);
  const id = idFactory(req, res);
  const traceparent = getTraceparentHeader(req);
  const spanEvent = traceparent
    ? createTraceparentRequestSpan(traceparent, {
      durationMs,
      id,
      method,
      now,
      path,
      spanIdFactory: () => spanIdFactory(req, res),
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

export function createErrorEvent(error, req, {
  now = () => new Date().toISOString(),
  idFactory = defaultErrorEventId
} = {}) {
  const method = req.method ?? "GET";
  const path = getRequestPath(req);
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: idFactory(error, req),
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

export function createRequestMetricEvent(req, res, {
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

async function captureRequestFinish(options, { req, res, client, transport, startedAt }) {
  try {
    const durationMs = Math.max(0, Math.round(nowMs(options) - startedAt));
    if (options.captureRequests !== false) {
      const event = typeof options.requestEvent === "function"
        ? options.requestEvent(req, res, { client, durationMs })
        : createRequestEvent(req, res, { ...options, durationMs });
      captureRequestEvent(client, event);
    }
    if (options.captureRequestMetrics === true) {
      const metricEvent = typeof options.requestMetricEvent === "function"
        ? options.requestMetricEvent(req, res, { client, durationMs })
        : createRequestMetricEvent(req, res, {
          ...options,
          durationMs,
          idFactory: options.metricIdFactory
        });
      captureRequestMetricEvent(client, metricEvent);
    }
    const response = await client.shutdown(transport);
    await notifyFlush(options, response, { req, res, client });
  } catch (error) {
    await notifyFailure(options, error, { req, res, client });
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
          framework: "express",
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

export default {
  createErrorEvent,
  createLogBrewExpressClient,
  createRequestMetricEvent,
  createRequestEvent,
  logbrewErrorHandler,
  logbrewMiddleware
};
