"use strict";

const { getContext, hasContext, setContext } = require("svelte");
const {
  createTraceparent,
  LogBrewClient,
  parseTraceparent,
  RecordingTransport,
  SdkError
} = require("@logbrew/sdk");

const DEFAULT_SDK_NAME = "logbrew-svelte";
const DEFAULT_SDK_VERSION = "0.1.0";
const LOG_BREW_SVELTE_KEY = Symbol.for("logbrew.svelte");

function createLogBrewSvelteClient({
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
      "createLogBrewSvelteClient requires clientKey, apiKey, LOGBREW_CLIENT_KEY, or LOGBREW_API_KEY"
    );
  }
  return LogBrewClient.create({ apiKey: authKey, sdkName, sdkVersion, maxRetries });
}

function createSvelteTraceparent({
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

function createLogBrewSvelteContext(options = {}) {
  const client = resolveClient(options);
  const transport = resolveTransport(options, client);
  return createSvelteContext(client, transport);
}

function setLogBrewContext(options = {}) {
  const context = isLogBrewSvelteContext(options)
    ? options
    : createLogBrewSvelteContext(options);
  setContext(LOG_BREW_SVELTE_KEY, context);
  return context;
}

function useLogBrew() {
  if (!hasContext(LOG_BREW_SVELTE_KEY)) {
    throw new SdkError(
      "configuration_error",
      "useLogBrew requires setLogBrewContext to run in a parent Svelte component"
    );
  }
  return getContext(LOG_BREW_SVELTE_KEY);
}

const getLogBrewContext = useLogBrew;

function createSvelteViewEvent(name, {
  now = () => new Date().toISOString(),
  path = "",
  idFactory = defaultViewEventId,
  metadata = {}
} = {}) {
  return {
    id: idFactory(name, path),
    timestamp: now(),
    attributes: {
      message: path ? `Svelte view ${name} at ${path}` : `Svelte view ${name}`,
      level: "info",
      logger: "svelte",
      metadata: {
        ...metadata,
        name,
        path
      }
    }
  };
}

function createSvelteErrorEvent(error, {
  component = "",
  info = "",
  now = () => new Date().toISOString(),
  idFactory = defaultErrorEventId
} = {}) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: idFactory(error, { component, info }),
    timestamp: now(),
    attributes: {
      title: component ? `${component} failed` : "Svelte component failed",
      level: "error",
      message,
      metadata: {
        component,
        info
      }
    }
  };
}

async function captureSvelteError(error, context, options = {}) {
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, { context })
    : createSvelteErrorEvent(error, options);

  try {
    context.client.issue(event.id, event.timestamp, event.attributes);
    const response = await context.client.shutdown(context.transport);
    await notifyFlush(options, response, { context });
    return response;
  } catch (captureError) {
    await notifyFailure(options, captureError, { context });
    throw captureError;
  }
}

function createSvelteContext(client, transport) {
  return {
    client,
    logbrew: client,
    transport,
    previewJson: () => client.previewJson(),
    flush: () => client.flush(transport),
    shutdown: () => client.shutdown(transport)
  };
}

function resolveClient(options) {
  if (typeof options.client === "function") {
    return options.client();
  }
  if (options.client) {
    return options.client;
  }
  return createLogBrewSvelteClient(options);
}

function resolveTransport(options, client) {
  if (typeof options.transport === "function") {
    return options.transport({ client });
  }
  return options.transport ?? RecordingTransport.alwaysAccept();
}

function isLogBrewSvelteContext(value) {
  return Boolean(value?.client && value?.transport && typeof value.previewJson === "function");
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
  return `evt_svelte_view_${slugify(`${name}_${path}`)}`;
}

function defaultErrorEventId(error, { component, info }) {
  const message = error instanceof Error ? error.message : String(error);
  return `evt_svelte_error_${slugify(`${component}_${info}_${message}`)}`;
}

function defaultFetch() {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
}

function defaultRandomValues(length) {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new SdkError("configuration_error", "createSvelteTraceparent requires crypto.getRandomValues or randomValues");
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
    : traceparent ?? createSvelteTraceparent({ randomValues, traceFlags });
  parseTraceparent(nextTraceparent);
  return nextTraceparent;
}

module.exports = {
  captureSvelteError,
  createLogBrewSvelteClient,
  createLogBrewSvelteContext,
  createSvelteErrorEvent,
  createSvelteTraceparent,
  createSvelteViewEvent,
  createTraceparentFetch,
  default: {
    captureSvelteError,
    createLogBrewSvelteClient,
    createLogBrewSvelteContext,
    createSvelteErrorEvent,
    createSvelteTraceparent,
    createSvelteViewEvent,
    createTraceparentFetch,
    getLogBrewContext,
    LOG_BREW_SVELTE_KEY,
    setLogBrewContext,
    shouldPropagateTraceparent,
    useLogBrew
  },
  getLogBrewContext,
  LOG_BREW_SVELTE_KEY,
  setLogBrewContext,
  shouldPropagateTraceparent,
  useLogBrew
};
