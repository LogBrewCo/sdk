const {
  LogBrewClient,
  RecordingTransport,
  SdkError,
  parseTraceparent,
  spanAttributesFromTraceparent
} = require("@logbrew/sdk");

const DEFAULT_SDK_NAME = "logbrew-next";
const DEFAULT_SDK_VERSION = "0.1.0";

function createLogBrewNextClient({
  apiKey,
  serverApiKey,
  sdkName = DEFAULT_SDK_NAME,
  sdkVersion = DEFAULT_SDK_VERSION,
  maxRetries = 2
} = {}) {
  const authKey = serverApiKey ?? apiKey ?? readEnvServerApiKey() ?? readEnvApiKey();
  if (!authKey) {
    throw new SdkError(
      "configuration_error",
      "createLogBrewNextClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
    );
  }
  return LogBrewClient.create({ apiKey: authKey, sdkName, sdkVersion, maxRetries });
}

function withLogBrewRouteHandler(handler, options = {}) {
  if (typeof handler !== "function") {
    throw new SdkError("configuration_error", "withLogBrewRouteHandler requires a handler function");
  }

  return async function logBrewRouteHandler(request, context = {}) {
    const client = resolveClient(options, request, context);
    const transport = resolveTransport(options, request, context, client);
    const helpers = createRouteHelpers(client, transport);
    const startedAt = nowMs(options);

    try {
      const response = await handler(request, context, helpers);
      ensureResponse(response);
      await captureRouteSuccess(options, { request, response, context, client, transport, startedAt });
      return response;
    } catch (error) {
      await recordRouteError(options, error, { request, context, client, transport });
      throw error;
    }
  };
}

function createRouteRequestEvent(request, response, {
  now = () => new Date().toISOString(),
  durationMs = 0,
  idFactory = defaultRouteRequestId,
  spanIdFactory = defaultSpanIdFactory
} = {}) {
  const url = safeUrl(request);
  const method = request?.method ?? "GET";
  const statusCode = Number(response?.status ?? 0);
  const id = idFactory(request, response);
  const traceparent = getTraceparentHeader(request);
  const spanEvent = traceparent
    ? createTraceparentRouteSpan(traceparent, {
      durationMs,
      id,
      method,
      now,
      pathname: url.pathname,
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
      message: `${method} ${url.pathname} ${statusCode}`,
      level: statusCode >= 500 ? "error" : "info",
      logger: "next",
      metadata: {
        framework: "nextjs",
        method,
        pathname: url.pathname,
        statusCode,
        durationMs
      }
    }
  };
}

function createRouteErrorEvent(error, request, {
  includeSearchParams = false,
  now = () => new Date().toISOString(),
  idFactory = defaultRouteErrorId
} = {}) {
  const url = safeUrl(request);
  const method = request?.method ?? "GET";
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: idFactory(request),
    timestamp: now(),
    attributes: {
      title: `${method} ${url.pathname} failed`,
      level: "error",
      message,
      metadata: {
        method,
        pathname: url.pathname,
        ...(includeSearchParams ? { search: url.search || null } : {})
      }
    }
  };
}

function resolveClient(options, request, context) {
  if (typeof options.client === "function") {
    return options.client({ request, context });
  }
  if (options.client) {
    return options.client;
  }
  return createLogBrewNextClient(options);
}

function resolveTransport(options, request, context, client) {
  if (typeof options.transport === "function") {
    return options.transport({ request, context, client });
  }
  return options.transport ?? RecordingTransport.alwaysAccept();
}

function createRouteHelpers(client, transport) {
  return {
    client,
    logbrew: client,
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
    await options.onCaptureError(error, context);
  }
}

async function captureRouteSuccess(options, { request, response, context, client, transport, startedAt }) {
  try {
    if (options.captureRequests !== false) {
      recordRouteRequest(options, { request, response, context, client, startedAt });
    }
    const flushResponse = await client.shutdown(transport);
    await notifyFlush(options, flushResponse, { request, context, client });
  } catch (error) {
    await notifyFailure(options, error, { request, context, client });
  }
}

function recordRouteRequest(options, { request, response, context, client, startedAt }) {
  const durationMs = Math.max(0, Math.round(nowMs(options) - startedAt));
  const event = typeof options.requestEvent === "function"
    ? options.requestEvent(request, response, { client, context, durationMs, request, response })
    : createRouteRequestEvent(request, response, {
      ...options,
      durationMs,
      idFactory: options.requestIdFactory
    });
  captureRouteRequestEvent(client, event);
}

async function recordRouteError(options, error, { request, context, client, transport }) {
  if (options.captureErrors === false) {
    return;
  }
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, { request, context, client })
    : createRouteErrorEvent(error, request, options);
  try {
    client.issue(event.id, event.timestamp, event.attributes);
    const flushResponse = await client.shutdown(transport);
    await notifyFlush(options, flushResponse, { request, context, client });
  } catch (captureError) {
    await notifyFailure(options, captureError, { request, context, client });
  }
}

function captureRouteRequestEvent(client, event) {
  if (event.type === "span") {
    client.span(event.id, event.timestamp, event.attributes);
    return;
  }
  client.log(event.id, event.timestamp, event.attributes);
}

function defaultRouteRequestId(request, response) {
  const url = safeUrl(request);
  const slug = `${request?.method ?? "GET"}-${url.pathname}-${response?.status ?? 0}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `evt_next_request_${slug || "route"}`;
}

function defaultSpanIdFactory() {
  return randomHex(8);
}

function defaultRouteErrorId(request) {
  const url = safeUrl(request);
  const slug = `${request?.method ?? "GET"}-${url.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `evt_next_error_${slug || "route"}`;
}

function safeUrl(request) {
  try {
    return new URL(request?.url ?? "http://localhost/");
  } catch {
    return new URL("http://localhost/");
  }
}

function getTraceparentHeader(request) {
  if (!request?.headers || typeof request.headers.get !== "function") {
    return undefined;
  }
  const value = request.headers.get("traceparent");
  return typeof value === "string" ? value : undefined;
}

function createTraceparentRouteSpan(traceparent, {
  durationMs,
  id,
  method,
  now,
  pathname,
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
          framework: "nextjs",
          method,
          pathname,
          statusCode
        },
        name: `${method} ${pathname}`,
        spanId,
        status: statusCode >= 500 ? "error" : "ok"
      })
    };
  } catch {
    return undefined;
  }
}

function nowMs(options) {
  if (typeof options.nowMs === "function") {
    return options.nowMs();
  }
  return performance.now();
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

function readEnvApiKey() {
  return globalThis.process?.env?.LOGBREW_API_KEY;
}

function readEnvServerApiKey() {
  return globalThis.process?.env?.LOGBREW_SERVER_API_KEY;
}

module.exports = {
  createLogBrewNextClient,
  createRouteErrorEvent,
  createRouteRequestEvent,
  withLogBrewRouteHandler
};
