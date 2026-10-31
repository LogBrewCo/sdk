"use strict";

const {
  LogBrewClient,
  RecordingTransport,
  createTraceparentHeaders,
  SdkError,
  TransportError
} = require("@logbrew/sdk");
const { errorMonitor } = require("node:events");
const { createAutomaticEventId } = require("./automatic-event-id.cjs");
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
  createChildTraceContext,
  createLogBrewTraceContext,
  defaultSpanIdFactory,
  defaultTraceIdFactory,
  enterWithLogBrewTrace,
  getActiveLogBrewTrace,
  runWithLogBrewTrace,
  setLogBrewUser
} = require("./active-trace.cjs");
const {
  errorMessage,
  errorType,
  fetchInstrumentationMetadata,
  notifyFailure,
  nowMs,
  pathOnly,
  primitiveMetadata,
  slugify,
  spanEvents
} = require("./span-support.cjs");
const { fetchTargetMatcherValues, matchesFetchTarget, normalizeFetchTargetMatchers } = require("./target-matchers.cjs");
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
const FETCH_TIMING_METADATA_KEYS = Object.freeze({
  connectMs: "http.phase.connect_ms",
  decodedBodySize: "http.response.decoded_size",
  encodedBodySize: "http.response.encoded_size",
  nameLookupMs: "http.phase.name_lookup_ms",
  redirectMs: "http.phase.redirect_ms",
  requestBodyBytes: "http.request_content_length",
  requestMs: "http.phase.request_ms",
  responseBodyBytes: "http.response_content_length",
  responseMs: "http.phase.response_ms",
  tlsMs: "http.phase.tls_ms",
  waitMs: "http.phase.wait_ms"
});
const LOGBREW_FETCH_INSTRUMENTATION = Symbol.for("@logbrew/node.fetchInstrumentation");
const LOGBREW_AXIOS_STATE = Symbol("@logbrew/node.axiosState");
const LOGBREW_HTTP_CLIENT_INSTRUMENTATION = Symbol("@logbrew/node.httpClientInstrumentation");
const HTTP_CLIENT_AUTHORITY_NAME_KEY = ["host", "name"].join("");
const HTTP_CLIENT_LEGACY_AUTHORITY_KEY = ["ho", "st"].join("");
const HTTP_CLIENT_URL_USER_KEY = ["user", "name"].join("");
const HTTP_CLIENT_URL_ACCESS_KEY = ["pass", "word"].join("");
const HTTP_CLIENT_DEFAULT_AUTHORITY = ["local", "host"].join("");
const EVENT_QUEUE_FACTORY = Symbol.for("@logbrew/sdk.eventQueueFactory");
const CONTEXT_PROVIDER = Symbol.for("@logbrew/sdk.contextProvider");
const BREADCRUMB_PROVIDER = Symbol.for("@logbrew/sdk.breadcrumbProvider");
const axiosInstrumentationHandles = new WeakMap();
const httpClientInstrumentationHandles = new WeakMap();

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

async function fetchWithLogBrewSpan(input, init = {}, options = {}) {
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
    const response = await runWithLogBrewTrace(trace, () => fetchImpl(input, fetchInit));
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

async function axiosRequestWithLogBrewSpan(axiosInstance, config = {}, options = {}) {
  if (!axiosInstance || typeof axiosInstance.request !== "function") {
    throw new SdkError("configuration_error", "axiosRequestWithLogBrewSpan requires an Axios instance");
  }
  return axiosRequestWithLogBrewSpanInternal(
    (requestConfig) => axiosInstance.request(requestConfig),
    normalizeAxiosRequestConfig(config),
    {
      ...options,
      captureSpan: true,
      propagateTrace: true
    }
  );
}

function instrumentLogBrewAxiosInstance(axiosInstance, options = {}) {
  if (!axiosInstance || (typeof axiosInstance !== "object" && typeof axiosInstance !== "function")) {
    throw new SdkError("configuration_error", "instrumentLogBrewAxiosInstance requires an Axios instance");
  }
  if (typeof axiosInstance.request !== "function") {
    throw new SdkError("configuration_error", "instrumentLogBrewAxiosInstance requires axios.request");
  }
  if (
    typeof axiosInstance.interceptors?.request?.use !== "function" ||
    typeof axiosInstance.interceptors?.response?.use !== "function" ||
    typeof axiosInstance.interceptors?.request?.eject !== "function" ||
    typeof axiosInstance.interceptors?.response?.eject !== "function"
  ) {
    throw new SdkError("configuration_error", "instrumentLogBrewAxiosInstance requires Axios interceptors");
  }
  if (!options.client) {
    throw new SdkError("configuration_error", "instrumentLogBrewAxiosInstance requires client");
  }

  const existing = axiosInstrumentationHandles.get(axiosInstance);
  if (existing?.isInstalled()) {
    return existing;
  }

  let installed = true;
  const captureMatchers = normalizeFetchTargetMatchers(options.captureTargets);
  const propagationMatchers = normalizeFetchTargetMatchers(options.tracePropagationTargets);

  const requestInterceptorId = axiosInstance.interceptors.request.use((config) => {
    return prepareAxiosRequestConfig(config, options, captureMatchers, propagationMatchers);
  });
  const responseInterceptorId = axiosInstance.interceptors.response.use(
    async (response) => {
      await captureAxiosInterceptorSpan(options, response?.config?.[LOGBREW_AXIOS_STATE], { response });
      return response;
    },
    async (error) => {
      await captureAxiosInterceptorSpan(options, (error?.config ?? error?.response?.config)?.[LOGBREW_AXIOS_STATE], {
        error,
        response: error?.response
      });
      throw error;
    }
  );

  const handle = {
    isInstalled() {
      return installed;
    },
    uninstall() {
      if (!installed) {
        return;
      }
      axiosInstance.interceptors.request.eject(requestInterceptorId);
      axiosInstance.interceptors.response.eject(responseInterceptorId);
      installed = false;
      axiosInstrumentationHandles.delete(axiosInstance);
    }
  };

  axiosInstrumentationHandles.set(axiosInstance, handle);
  return handle;
}

async function axiosRequestWithLogBrewSpanInternal(requester, config, options = {}) {
  if (!options.client) {
    throw new SdkError("configuration_error", "axiosRequestWithLogBrewSpan requires client");
  }
  const method = getAxiosMethod(config);
  const path = pathOnly(options.routeTemplate ?? getAxiosPath(config));
  const startedAt = nowMs(options);
  const trace = createChildTraceContext("axiosRequestWithLogBrewSpan", options.trace ?? getActiveLogBrewTrace(), options);
  const traceFlags = trace.sampled ? "01" : "00";
  const traceparent = createTraceparentHeaders({
    traceId: trace.traceId,
    spanId: trace.spanId,
    traceFlags
  }).traceparent;
  const requestConfig = options.propagateTrace === false ? { ...config } : withAxiosTraceparent(config, traceparent);
  const id = options.id ?? defaultAxiosSpanId({ method, path });

  try {
    const response = await runWithLogBrewTrace(trace, () => requester(requestConfig));
    if (options.captureSpan !== false) {
      await captureAxiosSpan(options, {
        durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
        id,
        method,
        path,
        response,
        trace
      });
    }
    return response;
  } catch (error) {
    if (options.captureSpan !== false) {
      await captureAxiosSpan(options, {
        durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
        error,
        id,
        method,
        path,
        response: error?.response,
        trace
      });
    }
    throw error;
  }
}

function installLogBrewFetchInstrumentation({
  captureTargets,
  globalObject = globalThis,
  routeTemplate,
  routeTemplateFactory = defaultFetchRouteTemplateFactory,
  tracePropagationTargets = [],
  ...options
} = {}) {
  if (!options.client) {
    throw new SdkError("configuration_error", "installLogBrewFetchInstrumentation requires client");
  }
  if (!globalObject || typeof globalObject !== "object") {
    throw new SdkError("configuration_error", "installLogBrewFetchInstrumentation requires globalObject");
  }
  const originalFetch = globalObject.fetch;
  if (typeof originalFetch !== "function") {
    throw new SdkError("configuration_error", "installLogBrewFetchInstrumentation requires fetch");
  }
  if (originalFetch[LOGBREW_FETCH_INSTRUMENTATION]) {
    throw new SdkError("configuration_error", "installLogBrewFetchInstrumentation requires uninstrumented fetch");
  }
  if (routeTemplateFactory !== undefined && typeof routeTemplateFactory !== "function") {
    throw new SdkError("configuration_error", "routeTemplateFactory must be a function");
  }

  const callOriginalFetch = originalFetch.bind(globalObject);
  const matchers = normalizeFetchTargetMatchers([
    ...fetchTargetMatcherValues(tracePropagationTargets),
    ...fetchTargetMatcherValues(captureTargets)
  ]);
  let installed = true;

  function logBrewInstrumentedFetch(input, init) {
    const url = getFetchUrl(input);
    const method = getFetchMethod(input, init);
    const path = pathOnly(url);
    if (!matchesFetchTarget({ init, input, method, path, url }, matchers)) {
      return callOriginalFetch(input, init);
    }

    return fetchWithLogBrewSpan(input, init, {
      ...options,
      fetchImpl: callOriginalFetch,
      includeErrorMessage: false,
      metadata: fetchInstrumentationMetadata(options.metadata),
      routeTemplate: routeTemplate ?? routeTemplateFactory({ init, input, method, path, url }),
      trace: options.trace ?? getActiveLogBrewTrace()
    });
  }

  Object.defineProperty(logBrewInstrumentedFetch, LOGBREW_FETCH_INSTRUMENTATION, { value: true });
  globalObject.fetch = logBrewInstrumentedFetch;

  return Object.freeze({
    isInstalled() {
      return installed && globalObject.fetch === logBrewInstrumentedFetch;
    },
    uninstall() {
      if (!installed) {
        return;
      }
      if (globalObject.fetch === logBrewInstrumentedFetch) {
        globalObject.fetch = originalFetch;
      }
      installed = false;
    }
  });
}

function installLogBrewHttpClientInstrumentation({
  captureTargets,
  modules,
  routeTemplate,
  routeTemplateFactory,
  tracePropagationTargets,
  ...options
} = {}) {
  if (!options.client) {
    throw new SdkError("configuration_error", "installLogBrewHttpClientInstrumentation requires client");
  }
  if (!modules || typeof modules !== "object") {
    throw new SdkError("configuration_error", "installLogBrewHttpClientInstrumentation requires modules");
  }

  const moduleEntries = [
    ["http", modules.http],
    ["https", modules.https]
  ].filter(([, moduleValue]) => moduleValue !== undefined && moduleValue !== null);
  if (moduleEntries.length === 0) {
    throw new SdkError("configuration_error", "installLogBrewHttpClientInstrumentation requires at least one http or https module");
  }
  if (routeTemplateFactory !== undefined && typeof routeTemplateFactory !== "function") {
    throw new SdkError("configuration_error", "routeTemplateFactory must be a function");
  }

  const captureValues = fetchTargetMatcherValues(captureTargets);
  const propagationValues = fetchTargetMatcherValues(tracePropagationTargets);
  const captureMatchers = normalizeFetchTargetMatchers(captureValues.length > 0 ? captureValues : propagationValues);
  const propagationMatchers = normalizeFetchTargetMatchers(propagationValues.length > 0 ? propagationValues : captureValues);
  const installedModules = [];
  try {
    for (const [name, moduleValue] of moduleEntries) {
      installedModules.push(instrumentHttpClientModule(name, moduleValue, {
        ...options,
        captureMatchers,
        propagationMatchers,
        routeTemplate,
        routeTemplateFactory
      }));
    }
  } catch (error) {
    for (const { moduleValue, originalRequest, originalGet, request, get } of installedModules) {
      if (moduleValue.request === request) {
        moduleValue.request = originalRequest;
      }
      if (moduleValue.get === get) {
        moduleValue.get = originalGet;
      }
      httpClientInstrumentationHandles.delete(moduleValue);
    }
    throw error;
  }
  let installed = true;

  const handle = Object.freeze({
    isInstalled() {
      return installed && installedModules.every(({ moduleValue, request, get }) => (
        moduleValue.request === request && moduleValue.get === get
      ));
    },
    uninstall() {
      if (!installed) {
        return;
      }
      for (const { moduleValue, originalRequest, originalGet, request, get } of installedModules) {
        if (moduleValue.request === request) {
          moduleValue.request = originalRequest;
        }
        if (moduleValue.get === get) {
          moduleValue.get = originalGet;
        }
        httpClientInstrumentationHandles.delete(moduleValue);
      }
      installed = false;
    }
  });

  for (const { moduleValue } of installedModules) {
    httpClientInstrumentationHandles.set(moduleValue, handle);
  }
  return handle;
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
    ...fetchTimingMetadata(options.timings, { durationMs, error, method, path, response, trace }),
    framework: "node:fetch",
    "http.request.method": method,
    "http.route": path,
    method,
    path,
    sampled: trace.sampled,
    "url.path": path,
    ...(statusCode !== undefined ? { "http.response.status_code": statusCode, statusCode } : {}),
    ...(error !== undefined ? {
      ...(options.includeErrorMessage === false ? {} : { errorMessage: errorMessage(error) }),
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

async function captureAxiosSpan(options, {
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
    ...fetchInstrumentationMetadata(options.metadata),
    framework: "node:axios",
    "http.request.method": method,
    "http.route": path,
    method,
    path,
    sampled: trace.sampled,
    "url.path": path,
    ...(statusCode !== undefined ? { "http.response.status_code": statusCode, statusCode } : {}),
    ...(error !== undefined ? { errorType: errorType(error) } : {})
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
      // Axios ownership stays with the app; telemetry callbacks must not replace HTTP outcomes.
    }
  }
}

async function captureHttpClientSpan(options, {
  durationMs,
  error,
  id,
  method,
  path,
  response,
  trace
}) {
  const statusCode = response?.statusCode;
  const statusError = error === undefined && Number(statusCode ?? 0) >= 400
    ? httpStatusError()
    : undefined;
  const spanError = error ?? statusError;
  const metadata = {
    ...fetchInstrumentationMetadata(options.metadata),
    framework: options.framework ?? "node:http",
    "http.request.method": method,
    "http.route": path,
    method,
    path,
    sampled: trace.sampled,
    "url.path": path,
    ...(statusCode !== undefined ? { "http.response.status_code": statusCode, statusCode } : {}),
    ...(spanError !== undefined ? { errorType: errorType(spanError) } : {})
  };
  const events = spanEvents(options.events, spanError);
  try {
    options.client.span(id, typeof options.now === "function" ? options.now() : new Date().toISOString(), {
      name: `${method} ${path}`,
      traceId: trace.traceId,
      spanId: trace.spanId,
      ...(trace.parentSpanId !== undefined ? { parentSpanId: trace.parentSpanId } : {}),
      status: spanError !== undefined ? "error" : "ok",
      durationMs,
      ...(events !== undefined ? { events } : {}),
      ...(options.links !== undefined ? { links: options.links } : {}),
      metadata
    });
  } catch (captureError) {
    try {
      await notifyFailure(options, captureError, { client: options.client, error: spanError, response, trace });
    } catch {
      // Node HTTP ownership stays with the app; telemetry callbacks must not replace HTTP outcomes.
    }
  }
}

function createFetchTraceContext(trace, {
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory
} = {}) {
  return createChildTraceContext("fetchWithLogBrewSpan", trace, { spanIdFactory, traceIdFactory });
}

function withFetchTraceparent(input, init = {}, traceparent) {
  return {
    ...(init ?? {}),
    headers: fetchHeadersWithTraceparent(init?.headers ?? getFetchInputHeaders(input), traceparent)
  };
}

function normalizeAxiosRequestConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new SdkError("configuration_error", "axiosRequestWithLogBrewSpan requires an Axios request config");
  }
  return { ...config };
}

function createAxiosInstrumentationContext(config, options) {
  const method = getAxiosMethod(config);
  const url = getAxiosUrl(config);
  const path = pathOnly(getAxiosPath(config));
  return {
    config,
    method,
    path,
    url,
    routeTemplate: resolveAxiosRouteTemplate(options, { config, method, path, url })
  };
}

function prepareAxiosRequestConfig(config, options, captureMatchers, propagationMatchers) {
  const requestConfig = normalizeAxiosRequestConfig(config);
  const context = createAxiosInstrumentationContext(requestConfig, options);
  const captureSpan = captureMatchers.length === 0 || matchesFetchTarget(context, captureMatchers);
  const propagateTrace = propagationMatchers.length === 0 || matchesFetchTarget(context, propagationMatchers);
  if (!captureSpan && !propagateTrace) {
    return requestConfig;
  }
  const trace = createChildTraceContext("instrumentLogBrewAxiosInstance", options.trace ?? getActiveLogBrewTrace(), options);
  const traceFlags = trace.sampled ? "01" : "00";
  const traceparent = createTraceparentHeaders({
    traceId: trace.traceId,
    spanId: trace.spanId,
    traceFlags
  }).traceparent;
  const nextConfig = propagateTrace ? withAxiosTraceparent(requestConfig, traceparent) : requestConfig;
  Object.defineProperty(nextConfig, LOGBREW_AXIOS_STATE, {
    configurable: true,
    enumerable: false,
    value: {
      captureSpan,
      id: options.id ?? defaultAxiosSpanId({ method: context.method, path: context.routeTemplate ?? context.path }),
      method: context.method,
      path: pathOnly(context.routeTemplate ?? context.path),
      startedAt: nowMs(options),
      trace
    }
  });
  return nextConfig;
}

async function captureAxiosInterceptorSpan(options, state, { error, response }) {
  if (!state?.captureSpan) {
    return;
  }
  await captureAxiosSpan(options, {
    durationMs: Math.max(0, Math.round(nowMs(options) - state.startedAt)),
    error,
    id: state.id,
    method: state.method,
    path: state.path,
    response,
    trace: state.trace
  });
}

function resolveAxiosRouteTemplate(options, context) {
  if (typeof options.routeTemplate === "string" && options.routeTemplate.trim() !== "") {
    return options.routeTemplate;
  }
  if (typeof options.routeTemplateFactory === "function") {
    const value = options.routeTemplateFactory(context);
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return context.path;
}

function getAxiosMethod(config) {
  return String(config.method ?? "GET").toUpperCase();
}

function getAxiosPath(config) {
  return pathOnly(getAxiosUrl(config));
}

function getAxiosUrl(config) {
  const rawUrl = config.url === undefined || config.url === null ? "/" : String(config.url);
  const baseURL = typeof config.baseURL === "string" && config.baseURL.trim() !== "" ? config.baseURL : undefined;
  if (baseURL && !/^[a-z][a-z0-9+.-]*:/iu.test(rawUrl)) {
    try {
      return new URL(rawUrl, baseURL).toString();
    } catch {
      return rawUrl;
    }
  }
  return rawUrl;
}

function withAxiosTraceparent(config, traceparent) {
  return {
    ...config,
    headers: axiosHeadersWithTraceparent(config.headers, traceparent)
  };
}

function axiosHeadersWithTraceparent(headers, traceparent) {
  if (Array.isArray(headers)) {
    return [
      ...headers.filter(([key]) => String(key).toLowerCase() !== "traceparent"),
      ["traceparent", traceparent]
    ];
  }
  if (headers && typeof headers.set === "function") {
    try {
      if (typeof headers.constructor === "function") {
        const nextHeaders = new headers.constructor(headers);
        if (nextHeaders && typeof nextHeaders.set === "function") {
          nextHeaders.set("traceparent", traceparent);
          return nextHeaders;
        }
      }
    } catch {
      // Fall back to a plain clone rather than mutating the caller's header owner.
    }
  }
  return {
    ...(headers ?? {}),
    traceparent
  };
}

function instrumentHttpClientModule(name, moduleValue, options) {
  if (!moduleValue || typeof moduleValue !== "object") {
    throw new SdkError("configuration_error", `installLogBrewHttpClientInstrumentation requires ${name} module`);
  }
  if (typeof moduleValue.request !== "function" || typeof moduleValue.get !== "function") {
    throw new SdkError("configuration_error", `installLogBrewHttpClientInstrumentation requires ${name}.request and ${name}.get`);
  }
  if (httpClientInstrumentationHandles.get(moduleValue)?.isInstalled()) {
    throw new SdkError("configuration_error", `installLogBrewHttpClientInstrumentation requires uninstrumented ${name} module`);
  }
  if (moduleValue.request[LOGBREW_HTTP_CLIENT_INSTRUMENTATION] || moduleValue.get[LOGBREW_HTTP_CLIENT_INSTRUMENTATION]) {
    throw new SdkError("configuration_error", `installLogBrewHttpClientInstrumentation requires uninstrumented ${name} module`);
  }

  const originalRequest = moduleValue.request;
  const originalGet = moduleValue.get;
  const defaultProtocol = name === "https" ? "https:" : "http:";
  const framework = `node:${name}`;

  function request(...args) {
    return callHttpClientRequest(originalRequest, originalRequest, moduleValue, args, {
      ...options,
      defaultProtocol,
      endRequest: false,
      framework,
      moduleName: name
    });
  }

  function get(...args) {
    return callHttpClientRequest(originalRequest, originalGet, moduleValue, args, {
      ...options,
      defaultProtocol,
      endRequest: true,
      framework,
      moduleName: name
    });
  }

  Object.defineProperty(request, LOGBREW_HTTP_CLIENT_INSTRUMENTATION, { value: true });
  Object.defineProperty(get, LOGBREW_HTTP_CLIENT_INSTRUMENTATION, { value: true });
  moduleValue.request = request;
  moduleValue.get = get;
  return { moduleValue, originalRequest, originalGet, request, get };
}

function callHttpClientRequest(originalRequest, originalFallback, thisArg, args, options) {
  const normalized = normalizeHttpClientArgs(args, options.defaultProtocol);
  if (!normalized) {
    return originalFallback.apply(thisArg, args);
  }
  const context = createHttpClientInstrumentationContext(normalized.options, options.moduleName);
  const captureSpan = matchesFetchTarget(context, options.captureMatchers);
  const propagateTrace = matchesFetchTarget(context, options.propagationMatchers);
  if (!captureSpan && !propagateTrace) {
    return originalFallback.apply(thisArg, args);
  }

  const trace = createChildTraceContext("installLogBrewHttpClientInstrumentation", options.trace ?? getActiveLogBrewTrace(), options);
  const traceFlags = trace.sampled ? "01" : "00";
  const traceparent = createTraceparentHeaders({
    traceId: trace.traceId,
    spanId: trace.spanId,
    traceFlags
  }).traceparent;
  const requestOptions = propagateTrace
    ? withHttpClientTraceparent(normalized.options, traceparent)
    : normalized.options;
  const path = pathOnly(resolveHttpClientRouteTemplate(options, context));
  const method = context.method;
  const id = options.id ?? defaultHttpClientSpanId({ method, path });
  const startedAt = nowMs(options);
  let finalized = false;

  function finalize({ error, response } = {}) {
    if (finalized || !captureSpan) {
      return;
    }
    finalized = true;
    void captureHttpClientSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      error,
      id,
      method,
      path,
      response,
      trace
    });
  }

  function observeResponse(response) {
    if (!response || typeof response.once !== "function") {
      finalize({ response });
      return;
    }
    response.once("end", () => finalize({ response }));
    response.once("close", () => finalize({ response }));
    response.once(errorMonitor, (error) => finalize({ error, response }));
  }

  const callback = typeof normalized.callback === "function"
    ? function logBrewHttpClientCallback(response) {
      observeResponse(response);
      return runWithLogBrewTrace(trace, () => Reflect.apply(normalized.callback, undefined, [response]));
    }
    : undefined;

  let request;
  try {
    request = runWithLogBrewTrace(trace, () => originalRequest.call(thisArg, requestOptions, callback));
  } catch (error) {
    finalize({ error });
    throw error;
  }
  if (!callback && request && typeof request.once === "function") {
    request.once("response", observeResponse);
  }
  if (request && typeof request.once === "function") {
    request.once(errorMonitor, (error) => finalize({ error }));
  }
  if (options.endRequest && request && typeof request.end === "function") {
    request.end();
  }
  return request;
}

function normalizeHttpClientArgs(args, defaultProtocol) {
  const [input, inputOptions, inputCallback] = args;
  const callback = typeof inputOptions === "function"
    ? inputOptions
    : (typeof inputCallback === "function" ? inputCallback : undefined);
  const extraOptions = inputOptions && typeof inputOptions === "object" && typeof inputOptions !== "function"
    ? cloneHttpClientOptions(inputOptions)
    : {};
  let options;
  if (input === undefined) {
    options = extraOptions;
  } else if (typeof input === "string" || isUrlObject(input)) {
    options = { ...httpClientOptionsFromUrl(input), ...extraOptions };
  } else if (input && typeof input === "object") {
    options = { ...cloneHttpClientOptions(input), ...extraOptions };
  } else {
    return undefined;
  }
  options.protocol = typeof options.protocol === "string" && options.protocol.trim() !== ""
    ? options.protocol
    : defaultProtocol;
  options.path = httpClientPathFromOptions(options);
  options.method = getHttpClientMethod(options);
  if (options.headers !== undefined) {
    options.headers = cloneHttpClientHeaders(options.headers);
  }
  return { callback, options };
}

function cloneHttpClientOptions(options) {
  const clone = { ...options };
  if (clone.headers !== undefined) {
    clone.headers = cloneHttpClientHeaders(clone.headers);
  }
  return clone;
}

function httpClientOptionsFromUrl(value) {
  let parsed;
  try {
    parsed = isUrlObject(value) ? value : new URL(String(value));
  } catch {
    return { path: String(value) };
  }
  return {
    protocol: parsed.protocol,
    [HTTP_CLIENT_AUTHORITY_NAME_KEY]: parsed[HTTP_CLIENT_AUTHORITY_NAME_KEY],
    ...(parsed.port ? { port: parsed.port } : {}),
    path: `${parsed.pathname || "/"}${parsed.search || ""}`,
    ...(parsed[HTTP_CLIENT_URL_USER_KEY] || parsed[HTTP_CLIENT_URL_ACCESS_KEY] ? {
      auth: `${parsed[HTTP_CLIENT_URL_USER_KEY]}:${parsed[HTTP_CLIENT_URL_ACCESS_KEY]}`
    } : {})
  };
}

function isUrlObject(value) {
  return typeof URL === "function" && value instanceof URL;
}

function cloneHttpClientHeaders(headers) {
  if (headers === undefined || headers === null) {
    return {};
  }
  if (typeof headers.entries === "function") {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
  }
  if (typeof headers === "object") {
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])
    );
  }
  return {};
}

function withHttpClientTraceparent(options, traceparent) {
  const headers = cloneHttpClientHeaders(options.headers);
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "traceparent") {
      delete headers[key];
    }
  }
  return {
    ...options,
    headers: {
      ...headers,
      traceparent
    }
  };
}

function createHttpClientInstrumentationContext(options, moduleName) {
  const method = getHttpClientMethod(options);
  const path = pathOnly(httpClientPathFromOptions(options));
  return {
    method,
    module: moduleName,
    path,
    protocol: options.protocol ?? (moduleName === "https" ? "https:" : "http:"),
    url: httpClientUrlFromOptions(options)
  };
}

function resolveHttpClientRouteTemplate(options, context) {
  if (typeof options.routeTemplate === "string" && options.routeTemplate.trim() !== "") {
    return options.routeTemplate;
  }
  if (typeof options.routeTemplateFactory === "function") {
    const value = options.routeTemplateFactory(context);
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return context.path;
}

function getHttpClientMethod(options) {
  return String(options.method ?? "GET").toUpperCase();
}

function httpClientPathFromOptions(options) {
  const path = options.path ?? `${options.pathname ?? ""}${options.search ?? ""}`;
  const normalizedPath = typeof path === "string" && path.trim() !== "" ? path : "/";
  return normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
}

function httpClientUrlFromOptions(options) {
  const protocol = typeof options.protocol === "string" && options.protocol.trim() !== "" ? options.protocol : "http:";
  const authority = httpClientAuthorityFromOptions(options);
  return `${protocol}//${authority}${httpClientPathFromOptions(options)}`;
}

function httpClientAuthorityFromOptions(options) {
  const authorityName = options[HTTP_CLIENT_AUTHORITY_NAME_KEY] ?? options[HTTP_CLIENT_LEGACY_AUTHORITY_KEY] ?? HTTP_CLIENT_DEFAULT_AUTHORITY;
  const authority = String(authorityName).split("/")[0];
  if (String(authority).includes(":") || options.port === undefined || options.port === "") {
    return authority;
  }
  return `${authority}:${options.port}`;
}

function httpStatusError() {
  const error = new Error("HTTP status error");
  error.name = "HttpStatusError";
  return error;
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

function defaultAxiosSpanId({ method, path }) {
  return createAutomaticEventId("evt_node_axios", slugify(`${method}_${path}`));
}

function defaultHttpClientSpanId({ method, path }) {
  return createAutomaticEventId("evt_node_http_client", slugify(`${method}_${path}`));
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
  return createAutomaticEventId("evt_node_fetch", slugify(`${method}_${path}`));
}

function fetchTimingMetadata(timings, context) {
  const resolvedTimings = resolveFetchTimings(timings, context);
  if (!resolvedTimings || Array.isArray(resolvedTimings) || typeof resolvedTimings !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(FETCH_TIMING_METADATA_KEYS).flatMap(([sourceKey, metadataKey]) => {
      const value = resolvedTimings[sourceKey];
      return Number.isFinite(value) && value >= 0 ? [[metadataKey, roundTimingValue(value)]] : [];
    })
  );
}

function resolveFetchTimings(timings, context) {
  if (typeof timings === "function") {
    try {
      return timings(context);
    } catch {
      return undefined;
    }
  }
  return timings;
}

function roundTimingValue(value) {
  return Math.round(value * 1000) / 1000;
}

function defaultFetchRouteTemplateFactory({ path }) {
  return path;
}

function captureRequestEvent(client, event) {
  if (event.type === "span") {
    client.span(event.id, event.timestamp, event.attributes);
    return;
  }
  client.log(event.id, event.timestamp, event.attributes);
}

function defaultFetch() {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
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
