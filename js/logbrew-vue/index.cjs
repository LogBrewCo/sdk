"use strict";

const { inject } = require("vue");
const {
  createTraceparent,
  LogBrewClient,
  parseTraceparent,
  RecordingTransport,
  SdkError
} = require("@logbrew/sdk");

const DEFAULT_SDK_NAME = "logbrew-vue";
const DEFAULT_SDK_VERSION = "0.1.0";
const LOG_BREW_VUE_KEY = Symbol.for("logbrew.vue");

function createLogBrewVueClient({
  apiKey = readEnvApiKey(),
  clientKey = readEnvClientKey(),
  sdkName = DEFAULT_SDK_NAME,
  sdkVersion = DEFAULT_SDK_VERSION,
  maxRetries = 2
} = {}) {
  const authKey = clientKey ?? apiKey;
  if (!authKey) {
    throw new SdkError(
      "configuration_error",
      "createLogBrewVueClient requires clientKey, apiKey, LOGBREW_CLIENT_KEY, or LOGBREW_API_KEY"
    );
  }
  return LogBrewClient.create({ apiKey: authKey, sdkName, sdkVersion, maxRetries });
}

function createVueTraceparent({
  randomValues = defaultRandomValues,
  spanId,
  traceFlags = "01",
  traceId
} = {}) {
  return createTraceparent({
    spanId: spanId ?? randomHex(8, randomValues),
    traceFlags,
    traceId: traceId ?? randomHex(16, randomValues)
  });
}

function createTraceparentFetch({
  fetchImpl = defaultFetch(),
  randomValues = defaultRandomValues,
  traceFlags = "01",
  traceparent,
  traceparentFactory,
  tracePropagationTargets = []
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new SdkError("configuration_error", "createTraceparentFetch requires fetch");
  }
  if (!Array.isArray(tracePropagationTargets)) {
    throw new SdkError("configuration_error", "tracePropagationTargets must be an array");
  }
  if (traceparentFactory !== undefined && typeof traceparentFactory !== "function") {
    throw new SdkError("configuration_error", "traceparentFactory must be a function");
  }

  return async function tracedFetch(input, init) {
    const url = requestUrl(input);
    if (!shouldPropagateTraceparent(url, tracePropagationTargets)) {
      return init === undefined ? fetchImpl(input) : fetchImpl(input, init);
    }

    const requestInit = init ?? {};
    const nextTraceparent = traceparentForRequest({
      init,
      input,
      randomValues,
      traceFlags,
      traceparent,
      traceparentFactory,
      url
    });
    const nextInit = {
      ...requestInit,
      headers: headersWithTraceparent(requestHeaders(input, requestInit), nextTraceparent)
    };
    return fetchImpl(input, nextInit);
  };
}

function shouldPropagateTraceparent(url, tracePropagationTargets = []) {
  if (!Array.isArray(tracePropagationTargets)) {
    throw new SdkError("configuration_error", "tracePropagationTargets must be an array");
  }
  return tracePropagationTargets.some((target) => {
    if (typeof target === "string") {
      return url.includes(target);
    }
    if (target instanceof RegExp) {
      target.lastIndex = 0;
      const matched = target.test(url);
      target.lastIndex = 0;
      return matched;
    }
    if (typeof target === "function") {
      return target(url) === true;
    }
    throw new SdkError("configuration_error", "tracePropagationTargets entries must be strings, RegExp values, or functions");
  });
}

function createLogBrewVuePlugin(options = {}) {
  return {
    install(app) {
      const client = resolveClient(options, app);
      const transport = resolveTransport(options, app, client);
      const context = createVueContext(client, transport);

      app.provide(LOG_BREW_VUE_KEY, context);
      app.config.globalProperties.$logbrew = context;

      if (options.captureErrors !== false) {
        const previousErrorHandler = app.config.errorHandler;
        app.config.errorHandler = (error, instance, info) => {
          void captureVueError(error, instance, info, context, options);
          if (typeof previousErrorHandler === "function") {
            previousErrorHandler(error, instance, info);
          }
        };
      }
    }
  };
}

function useLogBrew() {
  const context = inject(LOG_BREW_VUE_KEY, null);
  if (!context) {
    throw new SdkError(
      "configuration_error",
      "useLogBrew requires createLogBrewVuePlugin to be installed on the Vue app"
    );
  }
  return context;
}

function createVueViewEvent(name, {
  now = () => new Date().toISOString(),
  path = "",
  idFactory = defaultViewEventId,
  metadata = {}
} = {}) {
  return {
    id: idFactory(name, path),
    timestamp: now(),
    attributes: {
      message: path ? `Vue view ${name} at ${path}` : `Vue view ${name}`,
      level: "info",
      logger: "vue",
      metadata: {
        ...metadata,
        name,
        path
      }
    }
  };
}

function createVueErrorEvent(error, instance, info, {
  now = () => new Date().toISOString(),
  idFactory = defaultErrorEventId
} = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const component = getComponentName(instance);
  return {
    id: idFactory(error, instance, info),
    timestamp: now(),
    attributes: {
      title: component ? `${component} failed` : "Vue component failed",
      level: "error",
      message,
      metadata: {
        component,
        info
      }
    }
  };
}

async function captureVueError(error, instance, info, context, options = {}) {
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, { context, info, instance })
    : createVueErrorEvent(error, instance, info, options);

  try {
    context.client.issue(event.id, event.timestamp, event.attributes);
    const response = await context.client.shutdown(context.transport);
    await notifyFlush(options, response, { context, info, instance });
    return response;
  } catch (captureError) {
    await notifyFailure(options, captureError, { context, info, instance });
    throw captureError;
  }
}

function createVueContext(client, transport) {
  return {
    client,
    logbrew: client,
    transport,
    previewJson: () => client.previewJson(),
    flush: () => client.flush(transport),
    shutdown: () => client.shutdown(transport)
  };
}

function resolveClient(options, app) {
  if (typeof options.client === "function") {
    return options.client({ app });
  }
  if (options.client) {
    return options.client;
  }
  return createLogBrewVueClient(options);
}

function resolveTransport(options, app, client) {
  if (typeof options.transport === "function") {
    return options.transport({ app, client });
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

function defaultViewEventId(name, path) {
  return `evt_vue_view_${slugify(`${name}_${path}`)}`;
}

function defaultErrorEventId(error, instance, info) {
  const message = error instanceof Error ? error.message : String(error);
  const component = getComponentName(instance);
  return `evt_vue_error_${slugify(`${component}_${info}_${message}`)}`;
}

function getComponentName(instance) {
  const type = instance?.type;
  return type?.name ?? type?.__name ?? instance?.$options?.name ?? "";
}

function defaultFetch() {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
}

function defaultRandomValues(length) {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new SdkError("configuration_error", "createVueTraceparent requires crypto.getRandomValues or randomValues");
  }
  const bytes = new Uint8Array(length);
  return globalThis.crypto.getRandomValues(bytes);
}

function headersWithTraceparent(headers, traceparent) {
  const nextHeaders = {};
  for (const [key, value] of headerEntries(headers)) {
    if (String(key).toLowerCase() !== "traceparent") {
      nextHeaders[key] = value;
    }
  }
  nextHeaders.traceparent = traceparent;
  return nextHeaders;
}

function headerEntries(headers) {
  if (headers === undefined || headers === null) {
    return [];
  }
  const HeadersConstructor = globalThis.Headers;
  if (typeof HeadersConstructor === "function" && headers instanceof HeadersConstructor) {
    const entries = [];
    headers.forEach((value, key) => {
      entries.push([key, value]);
    });
    return entries;
  }
  if (Array.isArray(headers)) {
    return headers;
  }
  if (typeof headers !== "string" && typeof headers[Symbol.iterator] === "function") {
    return Array.from(headers);
  }
  if (typeof headers === "object") {
    return Object.entries(headers);
  }
  return [];
}

function randomHex(length, randomValues) {
  if (typeof randomValues !== "function") {
    throw new SdkError("configuration_error", "randomValues must be a function");
  }
  const bytes = Array.from(randomValues(length));
  if (bytes.length !== length || bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new SdkError("configuration_error", "randomValues must return byte values for the requested length");
  }
  return bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
}

function readEnvApiKey() {
  return globalThis.process?.env?.LOGBREW_API_KEY;
}

function readEnvClientKey() {
  return globalThis.process?.env?.LOGBREW_CLIENT_KEY;
}

function requestHeaders(input, init) {
  if (init && init.headers !== undefined) {
    return init.headers;
  }
  return input?.headers;
}

function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor === "function" && input instanceof URLConstructor) {
    return input.toString();
  }
  if (typeof input?.url === "string") {
    return input.url;
  }
  return String(input);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

function traceparentForRequest({
  init,
  input,
  randomValues,
  traceFlags,
  traceparent,
  traceparentFactory,
  url
}) {
  const nextTraceparent = typeof traceparentFactory === "function"
    ? traceparentFactory({ init, input, url })
    : traceparent ?? createVueTraceparent({ randomValues, traceFlags });
  parseTraceparent(nextTraceparent);
  return nextTraceparent;
}

module.exports = {
  captureVueError,
  createLogBrewVueClient,
  createLogBrewVuePlugin,
  createTraceparentFetch,
  createVueErrorEvent,
  createVueTraceparent,
  createVueViewEvent,
  default: {
    captureVueError,
    createLogBrewVueClient,
    createLogBrewVuePlugin,
    createTraceparentFetch,
    createVueErrorEvent,
    createVueTraceparent,
    createVueViewEvent,
    LOG_BREW_VUE_KEY,
    shouldPropagateTraceparent,
    useLogBrew
  },
  LOG_BREW_VUE_KEY,
  shouldPropagateTraceparent,
  useLogBrew
};
