"use strict";

const {
  LogBrewClient,
  RecordingTransport,
  SdkError,
  TransportError
} = require("@logbrew/sdk");
const { addEnvironmentResourceContext, addNodeRuntimeContext } = require("./runtime-context.cjs");
const {
  createLogBrewQueueTraceHeaders: createQueueTraceHeaders,
  createLogBrewQueueTraceLinks: createQueueTraceLinks
} = require("./trace-context.cjs");
const { instrumentLogBrewMongoCollection: instrumentMongoCollection } = require("./mongo.cjs");
const { instrumentLogBrewMongooseModel: instrumentMongooseModel } = require("./mongoose.cjs");
const { instrumentLogBrewPgClient: instrumentPgClient } = require("./pg.cjs");
const { instrumentLogBrewRedisClient: instrumentRedisClient } = require("./redis.cjs");
const { installLogBrewUndiciInstrumentation: installUndiciInstrumentation } = require("./undici.cjs");
const { installLogBrewPinoInstrumentation: installPinoInstrumentation } = require("./pino.cjs");
const { installLogBrewProcessErrorCapture: installProcessErrorCapture } = require("./process-errors.cjs");
const {
  addLogBrewBreadcrumb: addScopedBreadcrumb,
  createBreadcrumbProvider,
  ignoreBreadcrumbUrl,
  installAutomaticBreadcrumbs
} = require("./breadcrumbs.cjs");
const { buildNodePersistentEventStore } = require("./persistent-event-store.cjs");
const {
  activeTraceTelemetryContext,
  createLogBrewTraceContext,
  enterWithLogBrewTrace,
  getActiveLogBrewTrace,
  runWithLogBrewTrace,
  setLogBrewUser
} = require("./active-trace.cjs");
const { errorMessage, notifyFailure, nowMs } = require("./span-support.cjs");
const {
  cacheOperationWithLogBrewSpan,
  databaseOperationWithLogBrewSpan,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
} = require("./operation-span.cjs");
const {
  createHttpErrorEvent,
  createHttpRequestEvent,
  createRequestTraceContext,
  getRequestTraceContext
} = require("./http-events.cjs");
const { defaultFetch, fetchWithLogBrewSpan } = require("./fetch-span.cjs");
const { installLogBrewFetchInstrumentation } = require("./fetch-instrumentation.cjs");
const { axiosRequestWithLogBrewSpan } = require("./axios-span.cjs");
const { instrumentLogBrewAxiosInstance } = require("./axios-instrumentation.cjs");
const { installLogBrewHttpClientInstrumentation } = require("./http-client-instrumentation.cjs");
const {
  createPersistentEventQueue,
  purgePersistentEventQueue
} = require("./persistent-queue.cjs");

const DEFAULT_ENDPOINT = "https://api.logbrew.co/v1/events";
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BATCH_EVENTS = 100;
const DEFAULT_MAX_BATCH_BYTES = 256 * 1024;
// Matches the process error capture default: one intake round trip, then Node exits.
const EXIT_FLUSH_TIMEOUT_MS = 2000;
const RATE_LIMIT_BODY_LIMIT_BYTES = 4096;
const exitFlushes = new Set();
const exitFlushRegistry = new FinalizationRegistry((entry) => {
  exitFlushes.delete(entry);
});
let exitFlushListening = false;
const EVENT_QUEUE_FACTORY = Symbol.for("@logbrew/sdk.eventQueueFactory");
const CONTEXT_PROVIDER = Symbol.for("@logbrew/sdk.contextProvider");
const BREADCRUMB_PROVIDER = Symbol.for("@logbrew/sdk.breadcrumbProvider");

function createLogBrewNodeClient({
  serverApiKey,
  apiKey,
  automaticDelivery,
  breadcrumbs = true,
  captureRuntimeContext = true,
  context,
  deliveryIntervalMs,
  deliveryQueueThreshold,
  endpoint,
  fetchImpl,
  headers,
  sdkName = "logbrew-node",
  sdkVersion = "0.1.23",
  maxBatchBytes,
  maxBatchEvents,
  maxRetries = 2,
  maxQueueBytes,
  maxQueueSize,
  onEventDropped,
  persistentQueue,
  persistentQueuePath,
  transport
} = {}) {
  const authKey = serverApiKey ?? apiKey ?? readEnvServerApiKey() ?? readEnvApiKey();
  if (!authKey) {
    throw new SdkError(
      "configuration_error",
      "createLogBrewNodeClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
    );
  }
  if (typeof captureRuntimeContext !== "boolean") {
    throw new SdkError("configuration_error", "captureRuntimeContext must be a boolean");
  }
  if (typeof breadcrumbs !== "boolean") {
    throw new SdkError("configuration_error", "breadcrumbs must be a boolean");
  }
  if (persistentQueue !== undefined && persistentQueuePath !== undefined) {
    throw new SdkError("configuration_error", "persistentQueue and persistentQueuePath are mutually exclusive");
  }
  if (persistentQueue !== undefined && (!persistentQueue || Array.isArray(persistentQueue) || typeof persistentQueue !== "object")) {
    throw new SdkError("configuration_error", "persistentQueue must be an object");
  }
  const limits = {
    maxBatchBytes: maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES,
    maxBatchEvents: maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS,
    maxQueueBytes: maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES,
    maxQueueSize: maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
  };
  const eventStore = persistentQueue === undefined
    ? undefined
    : buildNodePersistentEventStore({
      SdkError,
      directory: persistentQueue.directory,
      encryptionKey: persistentQueue.encryptionKey,
      limits,
      onWarning: persistentQueue.onWarning,
      sdkName
    });
  const exitAbort = transport === undefined ? new AbortController() : undefined;
  const ownedTransport = transport ?? createNodeFetchTransport({
    endpoint,
    fetchImpl: abortableFetch(fetchImpl ?? defaultFetch(), exitAbort.signal),
    headers
  });
  if (breadcrumbs) {
    installAutomaticBreadcrumbs(getActiveLogBrewTrace);
  }
  const environmentContext = addEnvironmentResourceContext(context);
  const clientContext = captureRuntimeContext ? addNodeRuntimeContext(environmentContext) : environmentContext;
  try {
    const client = LogBrewClient.create({
      apiKey: authKey,
      automaticDelivery,
      context: clientContext,
      deliveryIntervalMs,
      deliveryQueueThreshold,
      eventStore,
      [CONTEXT_PROVIDER]: activeTraceTelemetryContext,
      [BREADCRUMB_PROVIDER]: breadcrumbProvider,
      ...(persistentQueuePath !== undefined
        ? {
            [EVENT_QUEUE_FACTORY]: (queueConfig) => createPersistentEventQueue({
              ...queueConfig,
              persistentQueuePath
            })
          }
        : {}),
      sdkName,
      sdkVersion,
      maxRetries,
      transport: ownedTransport,
      ...limits,
      ...(onEventDropped !== undefined ? { onEventDropped } : {})
    });
    if (client.automaticDelivery) {
      flushOnExit(client, exitAbort);
    }
    return client;
  } catch (error) {
    try {
      eventStore?.close();
    } catch {
      // Preserve the client configuration or recovery failure.
    }
    throw error;
  }
}

function abortableFetch(fetchImpl, signal) {
  if (typeof fetchImpl !== "function") {
    return fetchImpl;
  }
  return (url, init) => fetchImpl(url, { ...init, signal });
}

// Sends what is still queued when the event loop empties, because the delivery timer does not keep Node running.
function flushOnExit(client, exitAbort) {
  const entry = { client: new WeakRef(client), exitAbort, failed: false, inFlight: false };
  exitFlushes.add(entry);
  exitFlushRegistry.register(client, entry);
  if (!exitFlushListening) {
    exitFlushListening = true;
    process.on("beforeExit", flushPendingClients);
  }
}

function flushPendingClients() {
  for (const entry of exitFlushes) {
    const client = entry.client.deref();
    if (client === undefined || client.closed) {
      exitFlushes.delete(entry);
      continue;
    }
    // A failed exit flush is not repeated, so a down intake cannot keep the process alive.
    if (entry.failed || entry.inFlight || client.closing || client.pendingEvents() === 0) {
      continue;
    }
    entry.inFlight = true;
    const deadline = entry.exitAbort === undefined
      ? undefined
      : setTimeout(() => entry.exitAbort.abort(), EXIT_FLUSH_TIMEOUT_MS).unref();
    client.flush()
      .catch(() => {
        entry.failed = true;
      })
      .finally(() => {
        clearTimeout(deadline);
        entry.inFlight = false;
      });
  }
}

function purgeLogBrewNodePersistentQueue({ persistentQueuePath } = {}) {
  return purgePersistentEventQueue({ persistentQueuePath });
}

function createNodeFetchTransport({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = defaultFetch(),
  headers = {}
} = {}) {
  ignoreBreadcrumbUrl(endpoint);
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
        const retryAfterMs = retryAfterMsFromHeaders(response.headers);
        const errorCode = response.status === 429 ? await rateLimitCode(response) : undefined;
        return {
          statusCode: response.status,
          attempts: 1,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          ...(errorCode === undefined ? {} : { errorCode })
        };
      } catch (error) {
        throw TransportError.network(`fetch failed: ${errorMessage(error)}`);
      }
    }
  };
}

function withLogBrewHttpHandler(handler, options = {}) {
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
    let handlerSettled = false;
    let finalized = false;
    let requestShutdown = false;
    let requestFlush;

    req.logbrew = context;

    if (options.captureRequests !== false) {
      const finalize = () => {
        if (finalized) {
          return;
        }
        finalized = true;
        res.removeListener("finish", finalize);
        res.removeListener("close", finalize);
        req.removeListener("aborted", finalize);
        if (!errorCaptured) {
          requestShutdown = handlerSettled;
          requestFlush = runWithLogBrewTrace(trace, () => (
            captureHttpRequestFinish(options, { req, res, client, transport, startedAt, shutdown: requestShutdown })
          )).catch(() => undefined);
        }
      };
      res.once("finish", finalize);
      res.once("close", finalize);
      req.once("aborted", finalize);
    }

    async function settleHandler() {
      handlerSettled = true;
      if (!finalized || requestShutdown || errorCaptured) {
        return;
      }
      await requestFlush;
      try {
        const hasTail = client.pendingEvents() > 0;
        const response = await client.shutdown(transport);
        if (hasTail) {
          await notifyFlush(options, response, { req, res, client, trace });
        }
      } catch (error) {
        await notifyFailure(options, error, { req, res, client, trace });
      }
    }

    function rejectHandler(error) {
      handlerSettled = true;
      errorCaptured = true;
      return handleHttpHandlerError(options, { error, req, res, context });
    }

    runWithLogBrewTrace(trace, () => {
      try {
        const result = handler(req, res, context);
        if (isPromiseLike(result)) {
          void Promise.resolve(result).then(settleHandler, rejectHandler).catch(() => undefined);
        } else {
          void settleHandler().catch(() => undefined);
        }
      } catch (error) {
        void rejectHandler(error).catch(() => undefined);
      }
    });
  };
}

function createLogBrewNodeContext(client, transport, trace) {
  return {
    client,
    logbrew: client,
    ...(trace ? { trace } : {}),
    setUser: (id, options = {}) => setLogBrewUser(id, { ...options, trace }),
    transport,
    previewJson: () => client.previewJson(),
    flush: () => client.flush(transport),
    shutdown: () => client.shutdown(transport)
  };
}

function createLogBrewQueueTraceHeaders(trace = getActiveLogBrewTrace()) {
  return createQueueTraceHeaders(trace);
}

function createLogBrewQueueTraceLinks(carriers, metadata) {
  return createQueueTraceLinks(carriers, metadata);
}

function instrumentLogBrewPgClient(pgClient, options = {}) {
  return instrumentPgClient(pgClient, {
    ...options,
    activeTraceProvider: getActiveLogBrewTrace,
    runWithTrace: (trace, callback) => runWithLogBrewTrace(trace, callback)
  });
}

function instrumentLogBrewRedisClient(redisClient, options = {}) {
  return instrumentRedisClient(redisClient, {
    ...options,
    activeTraceProvider: getActiveLogBrewTrace,
    runWithTrace: (trace, callback) => runWithLogBrewTrace(trace, callback)
  });
}

function instrumentLogBrewMongoCollection(mongoCollection, options = {}) {
  return instrumentMongoCollection(mongoCollection, {
    ...options,
    activeTraceProvider: getActiveLogBrewTrace,
    runWithTrace: (trace, callback) => runWithLogBrewTrace(trace, callback)
  });
}

function instrumentLogBrewMongooseModel(mongooseModel, options = {}) {
  return instrumentMongooseModel(mongooseModel, {
    ...options,
    activeTraceProvider: getActiveLogBrewTrace,
    runWithTrace: (trace, callback) => runWithLogBrewTrace(trace, callback)
  });
}

function installLogBrewUndiciInstrumentation(options = {}) {
  return installUndiciInstrumentation({
    ...options,
    activeTraceProvider: getActiveLogBrewTrace
  });
}

function installLogBrewPinoInstrumentation(options = {}) {
  return installPinoInstrumentation({
    ...options,
    traceProvider: options.traceProvider ?? getActiveLogBrewTrace
  });
}

const breadcrumbProvider = createBreadcrumbProvider(getActiveLogBrewTrace);

// Records an app-owned breadcrumb in the active request scope, or the process scope outside a request.
function addLogBrewBreadcrumb(breadcrumb) {
  addScopedBreadcrumb(breadcrumb, getActiveLogBrewTrace);
}

function installLogBrewProcessErrorCapture(options) {
  return installProcessErrorCapture(options, getActiveLogBrewTrace);
}

async function captureHttpError(error, req, res, context, options = {}) {
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

async function captureHttpRequestFinish(options, { req, res, client, transport, startedAt, shutdown = true }) {
  const trace = getRequestTraceContext(req);
  try {
    const durationMs = Math.max(0, Math.round(nowMs(options) - startedAt));
    const event = typeof options.requestEvent === "function"
      ? options.requestEvent(req, res, { client, durationMs, trace })
      : createHttpRequestEvent(req, res, { ...options, durationMs, trace });
    captureRequestEvent(client, event);
    const response = await (shutdown ? client.shutdown(transport) : client.flush(transport));
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
  const transport = typeof options.transport === "function"
    ? undefined
    : options.transport ?? RecordingTransport.alwaysAccept();
  return createLogBrewNodeClient({
    ...options,
    automaticDelivery: false,
    transport
  });
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

function captureRequestEvent(client, event) {
  if (event.type === "span") {
    client.span(event.id, event.timestamp, event.attributes);
    return;
  }
  client.log(event.id, event.timestamp, event.attributes);
}

function retryAfterMsFromHeaders(headers) {
  if (!headers || typeof headers.get !== "function") {
    return undefined;
  }
  const value = headers.get("retry-after");
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  // Only an HTTP date counts; a repeated header arrives comma-joined and is ignored.
  const timestamp = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(trimmed)
    ? Date.parse(trimmed)
    : Number.NaN;
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

// Reads at most 4 KiB of a 429 body, only to find a known `code`.
async function rateLimitCode(response) {
  try {
    const reader = response.body?.getReader?.();
    if (!reader) {
      return undefined;
    }
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > RATE_LIMIT_BODY_LIMIT_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const code = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.code;
    return code === "rate_limited" || code === "usage_limit_exceeded" ? code : undefined;
  } catch {
    return undefined;
  }
}

function readEnvApiKey() {
  return globalThis.process?.env?.LOGBREW_API_KEY;
}

function readEnvServerApiKey() {
  return globalThis.process?.env?.LOGBREW_SERVER_API_KEY;
}

function isPromiseLike(value) {
  return value !== null && typeof value === "object" && typeof value.then === "function";
}

const exported = {
  addLogBrewBreadcrumb,
  axiosRequestWithLogBrewSpan,
  cacheOperationWithLogBrewSpan,
  captureHttpError,
  createNodeFetchTransport,
  createHttpErrorEvent,
  createHttpRequestEvent,
  createLogBrewNodeClient,
  createLogBrewNodeContext,
  createLogBrewTraceContext,
  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  databaseOperationWithLogBrewSpan,
  fetchWithLogBrewSpan,
  enterWithLogBrewTrace,
  getActiveLogBrewTrace,
  installLogBrewFetchInstrumentation,
  installLogBrewHttpClientInstrumentation,
  installLogBrewPinoInstrumentation,
  installLogBrewProcessErrorCapture,
  installLogBrewUndiciInstrumentation,
  instrumentLogBrewAxiosInstance,
  instrumentLogBrewMongoCollection,
  instrumentLogBrewMongooseModel,
  instrumentLogBrewPgClient,
  instrumentLogBrewRedisClient,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan,
  purgeLogBrewNodePersistentQueue,
  runWithLogBrewTrace,
  setLogBrewUser,
  withLogBrewHttpHandler
};

module.exports = { ...exported, default: exported };
