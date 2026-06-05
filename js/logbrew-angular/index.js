import { ErrorHandler, InjectionToken, Injector, inject } from "@angular/core";
import {
  createTraceparent,
  LogBrewClient,
  parseTraceparent,
  RecordingTransport,
  SdkError
} from "@logbrew/sdk";

const DEFAULT_SDK_NAME = "logbrew-angular";
const DEFAULT_SDK_VERSION = "0.1.0";

export const LOG_BREW_ANGULAR_CONTEXT = new InjectionToken("LogBrew Angular context");

export function createLogBrewAngularClient({
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
      "createLogBrewAngularClient requires clientKey, apiKey, LOGBREW_CLIENT_KEY, or LOGBREW_API_KEY"
    );
  }
  return LogBrewClient.create({ apiKey: authKey, sdkName, sdkVersion, maxRetries });
}

export function createAngularTraceparent({
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

export function createTraceparentFetch({
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

export function shouldPropagateTraceparent(url, tracePropagationTargets = []) {
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

export function provideLogBrew(options = {}) {
  const providers = [
    {
      provide: LOG_BREW_ANGULAR_CONTEXT,
      useFactory: () => {
        const injector = inject(Injector);
        const client = resolveClient(options, injector);
        const transport = resolveTransport(options, injector, client);
        return createLogBrewAngularContext(client, transport);
      }
    }
  ];

  if (options.captureErrors !== false) {
    providers.push({
      provide: ErrorHandler,
      useFactory: () => new LogBrewErrorHandler(
        inject(LOG_BREW_ANGULAR_CONTEXT),
        options,
        resolveDelegateErrorHandler(options)
      )
    });
  }

  return providers;
}

export function injectLogBrew() {
  const context = inject(LOG_BREW_ANGULAR_CONTEXT, { optional: true });
  if (!context) {
    throw new SdkError(
      "configuration_error",
      "injectLogBrew requires provideLogBrew() in the Angular provider tree"
    );
  }
  return context;
}

export class LogBrewErrorHandler {
  constructor(context, options = {}, delegate = null) {
    this.context = context;
    this.options = options;
    this.delegate = delegate;
  }

  handleError(error) {
    void captureAngularError(error, this.context, this.options).catch(() => undefined);
    if (this.delegate && typeof this.delegate.handleError === "function") {
      this.delegate.handleError(error);
    }
  }
}

export function createLogBrewAngularContext(client, transport) {
  return {
    client,
    logbrew: client,
    transport,
    previewJson: () => client.previewJson(),
    flush: () => client.flush(transport),
    shutdown: () => client.shutdown(transport)
  };
}

export function createAngularViewEvent(name, {
  now = () => new Date().toISOString(),
  path = "",
  route = "",
  idFactory = defaultViewEventId,
  metadata = {}
} = {}) {
  const viewPath = path || route;
  return {
    id: idFactory(name, viewPath),
    timestamp: now(),
    attributes: {
      message: viewPath ? `Angular view ${name} at ${viewPath}` : `Angular view ${name}`,
      level: "info",
      logger: "angular",
      metadata: {
        ...metadata,
        name,
        path: viewPath
      }
    }
  };
}

export function createAngularErrorEvent(error, context = {}, {
  now = () => new Date().toISOString(),
  idFactory = defaultErrorEventId
} = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const component = context.component ?? "";
  const route = context.route ?? context.path ?? "";
  return {
    id: idFactory(error, context),
    timestamp: now(),
    attributes: {
      title: component ? `${component} failed` : "Angular error",
      level: "error",
      message,
      metadata: {
        component,
        info: context.info ?? "",
        route
      }
    }
  };
}

export async function captureAngularError(error, context, options = {}) {
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, { context })
    : createAngularErrorEvent(error, options, options);

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

function resolveClient(options, injector) {
  if (typeof options.client === "function") {
    return options.client({ injector });
  }
  if (options.client) {
    return options.client;
  }
  return createLogBrewAngularClient(options);
}

function resolveTransport(options, injector, client) {
  if (typeof options.transport === "function") {
    return options.transport({ client, injector });
  }
  return options.transport ?? RecordingTransport.alwaysAccept();
}

function resolveDelegateErrorHandler(options) {
  if (typeof options.delegateErrorHandler === "function") {
    return { handleError: options.delegateErrorHandler };
  }
  return options.delegateErrorHandler ?? null;
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
  return `evt_angular_view_${slugify(`${name}_${path}`)}`;
}

function defaultErrorEventId(error, context) {
  const message = error instanceof Error ? error.message : String(error);
  return `evt_angular_error_${slugify(`${context.component ?? ""}_${context.route ?? ""}_${message}`)}`;
}

function defaultFetch() {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
}

function defaultRandomValues(length) {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new SdkError("configuration_error", "createAngularTraceparent requires crypto.getRandomValues or randomValues");
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
    : traceparent ?? createAngularTraceparent({ randomValues, traceFlags });
  parseTraceparent(nextTraceparent);
  return nextTraceparent;
}

export default {
  captureAngularError,
  createAngularErrorEvent,
  createAngularTraceparent,
  createAngularViewEvent,
  createLogBrewAngularClient,
  createLogBrewAngularContext,
  createTraceparentFetch,
  injectLogBrew,
  LogBrewErrorHandler,
  LOG_BREW_ANGULAR_CONTEXT,
  provideLogBrew,
  shouldPropagateTraceparent
};
