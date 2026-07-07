import {
  LogBrewClient,
  RecordingTransport,
  createTraceparentHeaders,
  parseTraceparent,
  SdkError,
  TransportError
} from "@logbrew/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { errorMonitor } from "node:events";
import {
  createLogBrewQueueBatchSpanOptions as createQueueBatchSpanOptions,
  createLogBrewQueueTraceHeaders as createQueueTraceHeaders,
  createLogBrewQueueTraceLinks as createQueueTraceLinks,
  normalizeSpanId,
  normalizeTraceId,
  resolveOperationTrace
} from "./trace-context.js";
import { instrumentLogBrewMongoCollection as instrumentMongoCollection } from "./mongo.js";
import { instrumentLogBrewMongooseModel as instrumentMongooseModel } from "./mongoose.js";
import { instrumentLogBrewPgClient as instrumentPgClient } from "./pg.js";
import { instrumentLogBrewRedisClient as instrumentRedisClient } from "./redis.js";
import { installLogBrewUndiciInstrumentation as installUndiciInstrumentation } from "./undici.js";

const DEFAULT_SDK_NAME = "logbrew-node";
const DEFAULT_SDK_VERSION = "0.1.0";
const DEFAULT_ENDPOINT = "https://api.logbrew.com/v1/events";
const MAX_SPAN_EVENTS = 8;
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
const activeTraceContext = new AsyncLocalStorage();
const axiosInstrumentationHandles = new WeakMap();
const httpClientInstrumentationHandles = new WeakMap();

export function createLogBrewNodeClient({
  serverApiKey,
  apiKey,
  sdkName = DEFAULT_SDK_NAME,
  sdkVersion = DEFAULT_SDK_VERSION,
  maxRetries = 2,
  maxQueueSize,
  onEventDropped
} = {}) {
  const authKey = serverApiKey ?? apiKey ?? readEnvServerApiKey() ?? readEnvApiKey();
  if (!authKey) {
    throw new SdkError(
      "configuration_error",
      "createLogBrewNodeClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
    );
  }
  return LogBrewClient.create({
    apiKey: authKey,
    sdkName,
    sdkVersion,
    maxRetries,
    ...(maxQueueSize !== undefined ? { maxQueueSize } : {}),
    ...(onEventDropped !== undefined ? { onEventDropped } : {})
  });
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

export function instrumentLogBrewMongoCollection(mongoCollection, options = {}) {
  return instrumentMongoCollection(mongoCollection, {
    ...options,
    activeTraceProvider: getActiveLogBrewTrace,
    runWithTrace: (trace, callback) => activeTraceContext.run(trace, callback)
  });
}

export function instrumentLogBrewMongooseModel(mongooseModel, options = {}) {
  return instrumentMongooseModel(mongooseModel, {
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

export async function axiosRequestWithLogBrewSpan(axiosInstance, config = {}, options = {}) {
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

export function instrumentLogBrewAxiosInstance(axiosInstance, options = {}) {
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
    const response = await activeTraceContext.run(trace, () => requester(requestConfig));
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

export function installLogBrewFetchInstrumentation({
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

export function installLogBrewHttpClientInstrumentation({
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

export function installLogBrewUndiciInstrumentation(options = {}) {
  return installUndiciInstrumentation({
    ...options,
    activeTraceProvider: getActiveLogBrewTrace
  });
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
      return activeTraceContext.run(trace, () => Reflect.apply(normalized.callback, undefined, [response]));
    }
    : undefined;

  let request;
  try {
    request = activeTraceContext.run(trace, () => originalRequest.call(thisArg, requestOptions, callback));
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
  return `evt_node_axios_${slugify(`${method}_${path}`)}`;
}

function defaultHttpClientSpanId({ method, path }) {
  return `evt_node_http_client_${slugify(`${method}_${path}`)}`;
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

function fetchInstrumentationMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(primitiveMetadata(metadata)).filter(([key]) => isSafeFetchInstrumentationMetadataKey(key))
  );
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

function isSafeFetchInstrumentationMetadataKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ![
    "authorization",
    "body",
    "cookie",
    "error",
    "errormessage",
    "headers",
    "host",
    "message",
    "payload",
    "query",
    "rawurl",
    ["se", "cret"].join(""),
    ["to", "ken"].join(""),
    "traceparent",
    "url"
  ].includes(normalized);
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

function defaultFetchRouteTemplateFactory({ path }) {
  return path;
}

function normalizeFetchTargetMatchers(value) {
  const matchers = fetchTargetMatcherValues(value);
  return matchers.filter((matcher) => matcher !== undefined && matcher !== null).map((matcher) => {
    if (typeof matcher === "string") {
      const trimmed = matcher.trim();
      if (trimmed === "") {
        throw new SdkError("configuration_error", "tracePropagationTargets must not contain empty strings");
      }
      return trimmed;
    }
    if (matcher instanceof RegExp || typeof matcher === "function") {
      return matcher;
    }
    throw new SdkError("configuration_error", "tracePropagationTargets entries must be strings, RegExp values, or functions");
  });
}

function fetchTargetMatcherValues(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function matchesFetchTarget(context, matchers) {
  if (matchers.length === 0) {
    return false;
  }
  const candidates = fetchTargetCandidates(context.url);
  return matchers.some((matcher) => {
    if (typeof matcher === "string") {
      return candidates.some((candidate) => candidate.startsWith(matcher));
    }
    if (matcher instanceof RegExp) {
      return candidates.some((candidate) => {
        matcher.lastIndex = 0;
        const matched = matcher.test(candidate);
        matcher.lastIndex = 0;
        return matched;
      });
    }
    return matcher(context) === true;
  });
}

function fetchTargetCandidates(value) {
  const rawValue = typeof value === "string" ? value : String(value);
  const withoutQuery = rawValue.split(/[?#]/u, 1)[0];
  const candidates = new Set([withoutQuery]);
  try {
    const parsed = new URL(rawValue, "http://localhost");
    candidates.add(parsed.pathname || "/");
    if (/^https?:\/\//iu.test(rawValue)) {
      candidates.add(`${parsed.origin}${parsed.pathname || "/"}`);
    }
  } catch {
    // The query-free raw value above is enough for non-standard request keys.
  }
  return Array.from(candidates);
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
  axiosRequestWithLogBrewSpan,
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
  installLogBrewFetchInstrumentation,
  installLogBrewHttpClientInstrumentation,
  installLogBrewUndiciInstrumentation,
  instrumentLogBrewAxiosInstance,
  instrumentLogBrewMongoCollection,
  instrumentLogBrewMongooseModel,
  instrumentLogBrewPgClient,
  instrumentLogBrewRedisClient,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan,
  withLogBrewHttpHandler
};
