import {
  LogBrewClient,
  RecordingTransport,
  parseTraceparent,
  SdkError,
  spanAttributesFromTraceparent,
  TransportError
} from "@logbrew/sdk";

const DEFAULT_SDK_NAME = "logbrew-node";
const DEFAULT_SDK_VERSION = "0.1.0";
const DEFAULT_ENDPOINT = "https://api.logbrew.com/v1/events";

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
    const context = createLogBrewNodeContext(client, transport);
    let errorCaptured = false;

    req.logbrew = context;

    if (options.captureRequests !== false) {
      res.once("finish", () => {
        if (!errorCaptured) {
          void captureHttpRequestFinish(options, { req, res, client, transport, startedAt });
        }
      });
    }

    try {
      const result = handler(req, res, context);
      if (isPromiseLike(result)) {
        void result.catch((error) => {
          errorCaptured = true;
          return handleHttpHandlerError(options, { error, req, res, client, transport });
        });
      }
    } catch (error) {
      errorCaptured = true;
      void handleHttpHandlerError(options, { error, req, res, client, transport });
    }
  };
}

export function createLogBrewNodeContext(client, transport) {
  return {
    client,
    logbrew: client,
    transport,
    previewJson: () => client.previewJson(),
    flush: () => client.flush(transport),
    shutdown: () => client.shutdown(transport)
  };
}

export function createHttpRequestEvent(req, res, {
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

export async function captureHttpError(error, req, res, context, options = {}) {
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, { req, res, client: context.client })
    : createHttpErrorEvent(error, req, options);

  try {
    context.client.issue(event.id, event.timestamp, event.attributes);
    const response = await context.client.shutdown(context.transport);
    await notifyFlush(options, response, { req, res, client: context.client });
    return response;
  } catch (captureError) {
    await notifyFailure(options, captureError, { req, res, client: context.client });
    throw captureError;
  }
}

async function captureHttpRequestFinish(options, { req, res, client, transport, startedAt }) {
  try {
    const durationMs = Math.max(0, Math.round(nowMs(options) - startedAt));
    const event = typeof options.requestEvent === "function"
      ? options.requestEvent(req, res, { client, durationMs })
      : createHttpRequestEvent(req, res, { ...options, durationMs });
    captureRequestEvent(client, event);
    const response = await client.shutdown(transport);
    await notifyFlush(options, response, { req, res, client });
  } catch (error) {
    await notifyFailure(options, error, { req, res, client });
  }
}

async function handleHttpHandlerError(options, { error, req, res, client, transport }) {
  await captureHttpError(error, req, res, createLogBrewNodeContext(client, transport), options)
    .catch(() => undefined);

  if (typeof options.onError === "function") {
    await options.onError(error, { req, res, client });
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
          framework: "node:http",
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
  withLogBrewHttpHandler
};
