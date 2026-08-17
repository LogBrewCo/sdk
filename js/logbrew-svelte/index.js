import { getContext, hasContext, setContext } from "svelte";
import {
  createIssueAttributesFromError,
  LogBrewClient,
  parseTraceparent,
  SdkError
} from "@logbrew/sdk";
import {
  createBrowserTraceparent,
  createFetchTransport,
  createTraceparentFetch,
  shouldPropagateTraceparent
} from "@logbrew/browser";

export const LOG_BREW_SVELTE_KEY = Symbol.for("logbrew.svelte");
export const createSvelteTraceparent = createBrowserTraceparent;
export { createTraceparentFetch, shouldPropagateTraceparent };

export function createLogBrewSvelteClient({
  apiKey = readEnv("LOGBREW_API_KEY"),
  clientKey = readEnv("LOGBREW_CLIENT_KEY"),
  serverApiKey = readEnv("LOGBREW_SERVER_API_KEY"),
  context,
  sdkName = "logbrew-svelte",
  sdkVersion = "0.1.1",
  maxRetries = 2
} = {}) {
  const authKey = clientKey ?? serverApiKey ?? apiKey;
  if (!authKey) {
    throw new SdkError(
      "configuration_error",
      "createLogBrewSvelteClient requires a browser client key or server API key"
    );
  }
  return LogBrewClient.create({ apiKey: authKey, context, sdkName, sdkVersion, maxRetries });
}

export function createLogBrewSvelteContext(options = {}) {
  const client = typeof options.client === "function"
    ? options.client() : options.client ?? createLogBrewSvelteClient(options);
  const transport = typeof options.transport === "function"
    ? options.transport({ client }) : options.transport ?? createFetchTransport(options);
  return {
    client,
    logbrew: client,
    transport,
    previewJson: () => client.previewJson(),
    flush: () => client.flush(transport),
    shutdown: () => client.shutdown(transport)
  };
}

export function setLogBrewContext(options = {}) {
  const context = isLogBrewSvelteContext(options)
    ? options
    : createLogBrewSvelteContext(options);
  setContext(LOG_BREW_SVELTE_KEY, context);
  return context;
}

export function useLogBrew() {
  if (!hasContext(LOG_BREW_SVELTE_KEY)) {
    throw new SdkError(
      "configuration_error",
      "useLogBrew requires setLogBrewContext to run in a parent Svelte component"
    );
  }
  return getContext(LOG_BREW_SVELTE_KEY);
}

export const getLogBrewContext = useLogBrew;

export function createSvelteViewEvent(name, {
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
      metadata: { ...metadata, name, path }
    }
  };
}

export function createSvelteErrorEvent(error, {
  component = "",
  debugIdMap,
  environment,
  fingerprint,
  handled = true,
  includeErrorStack = false,
  info = "",
  now = () => new Date().toISOString(),
  idFactory = defaultErrorEventId,
  mechanism = "svelte.error_boundary",
  metadata,
  platform,
  release,
  runtime,
  service,
  source = "svelte.error",
  title,
  trace
} = {}) {
  return {
    id: idFactory(error, { component, info }),
    timestamp: now(),
    attributes: createIssueAttributesFromError(error, {
      debugIdMap,
      environment,
      fingerprint,
      handled,
      includeErrorStack,
      mechanism,
      metadata: { ...metadata, component, info },
      platform,
      release,
      runtime,
      service,
      source,
      title: title ?? (component ? `${component} failed` : "Svelte component failed"),
      trace
    })
  };
}

export async function captureSvelteError(error, context, options = {}) {
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, { context })
    : createSvelteErrorEvent(error, options);

  try {
    const attributes = options.breadcrumbs === undefined
      ? event.attributes
      : { ...event.attributes, breadcrumbs: options.breadcrumbs };
    context.client.issue(event.id, event.timestamp, attributes);
    const response = await context.client.flush(context.transport);
    await notifyFlush(options, response, { context });
    return response;
  } catch (captureError) {
    await notifyFailure(options, captureError, { context });
    throw captureError;
  }
}

export function createLogBrewSvelteKitHooks(context, options = {}) {
  if (!isLogBrewSvelteContext(context)) {
    throw new SdkError("configuration_error", "createLogBrewSvelteKitHooks requires a LogBrew context");
  }
  const traces = new WeakMap();

  return {
    async handle({ event, resolve }) {
      if (!event || typeof resolve !== "function") {
        throw new SdkError("configuration_error", "SvelteKit handle requires event and resolve");
      }
      const trace = createSvelteKitTrace(event.request, options);
      traces.set(event, trace);
      const startedAt = nowMs(options);
      let response;
      try {
        response = await resolve(event);
      } catch (error) {
        await captureSvelteKitRequest(context, event, 500, trace, startedAt, options);
        throw error;
      }
      await captureSvelteKitRequest(context, event, response?.status, trace, startedAt, options);
      return response;
    },
    async handleError(input) {
      const event = input?.event;
      const trace = traces.get(event) ?? createSvelteKitTrace(event?.request, options);
      try {
        await captureSvelteError(input?.error, context, {
          ...options,
          breadcrumbs: [{
            category: "sveltekit.request",
            message: `${svelteKitMethod(event)} ${svelteKitRoute(event)}`,
            timestamp: now(options),
            type: "http"
          }],
          component: svelteKitRoute(event),
          errorEvent: undefined,
          handled: false,
          info: "sveltekit.handle_error",
          mechanism: "sveltekit.handle_error",
          metadata: svelteKitMetadata(event, input?.status, options.metadata),
          source: "sveltekit.handle_error",
          trace
        });
      } catch (error) {
        if (options.raiseCaptureErrors === true) {
          throw error;
        }
      }
      return typeof options.mapError === "function" ? options.mapError(input) : undefined;
    }
  };
}

function isLogBrewSvelteContext(value) {
  return Boolean(value?.client && value?.transport && typeof value.previewJson === "function");
}

async function notifyFlush(options, response, context) {
  return typeof options.onFlush === "function" ? options.onFlush(response, context) : undefined;
}

async function notifyFailure(options, error, context) {
  return typeof options.onCaptureError === "function"
    ? options.onCaptureError(error, context) : undefined;
}

function defaultViewEventId(name, path) {
  return `evt_svelte_view_${slugify(`${name}_${path}`)}`;
}

function defaultErrorEventId(error, { component, info }) {
  const message = error instanceof Error ? error.message : String(error);
  return `evt_svelte_error_${slugify(`${component}_${info}_${message}`)}`;
}

async function captureSvelteKitRequest(context, event, status, trace, startedAt, options) {
  if (options.captureRequests === false) {
    return;
  }
  const statusCode = validStatus(status);
  try {
    context.client.span(`evt_sveltekit_request_${trace.spanId}`, now(options), {
      durationMs: Math.max(0, nowMs(options) - startedAt),
      name: `${svelteKitMethod(event)} ${svelteKitRoute(event)}`,
      ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
      spanId: trace.spanId,
      status: statusCode >= 500 ? "error" : "ok",
      traceId: trace.traceId,
      metadata: svelteKitMetadata(event, statusCode, options.metadata)
    });
    if (options.flushOnCapture !== false) {
      await context.client.flush(context.transport);
    }
  } catch (error) {
    await notifyFailure(options, error, { context });
    if (options.raiseCaptureErrors === true) {
      throw error;
    }
  }
}

function createSvelteKitTrace(request, options) {
  const parent = requestTraceparent(request);
  const generated = parseTraceparent(createSvelteTraceparent({
    randomValues: options.randomValues,
    traceFlags: parent?.traceFlags ?? options.traceFlags,
    traceId: parent?.traceId
  }));
  return {
    traceId: generated.traceId,
    spanId: generated.parentSpanId,
    ...(parent ? { parentSpanId: parent.parentSpanId } : {}),
    sampled: generated.sampled
  };
}

function requestTraceparent(request) {
  try {
    const value = request?.headers?.get?.("traceparent");
    return value ? parseTraceparent(value) : undefined;
  } catch {
    return undefined;
  }
}

function svelteKitMetadata(event, status, metadata) {
  const statusCode = validStatus(status);
  return {
    ...metadata,
    framework: "sveltekit",
    method: svelteKitMethod(event),
    routeTemplate: svelteKitRoute(event),
    statusCode,
    statusCodeClass: `${Math.floor(statusCode / 100)}xx`
  };
}

function svelteKitMethod(event) {
  const method = event?.request?.method;
  return typeof method === "string" && /^[A-Za-z]{1,16}$/u.test(method)
    ? method.toUpperCase()
    : "GET";
}

function svelteKitRoute(event) {
  const route = event?.route?.id;
  return typeof route === "string" && route.trim() !== "" && route.length <= 256
    ? route
    : "<unmatched>";
}

function validStatus(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
}

function now(options) {
  return typeof options.now === "function" ? options.now() : new Date().toISOString();
}

function nowMs(options) {
  return typeof options.nowMs === "function" ? options.nowMs() : Date.now();
}

function readEnv(name) {
  return globalThis.process?.env?.[name];
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

export default {
  captureSvelteError,
  createLogBrewSvelteClient,
  createLogBrewSvelteContext,
  createLogBrewSvelteKitHooks,
  createSvelteErrorEvent,
  createSvelteTraceparent,
  createSvelteViewEvent,
  createTraceparentFetch,
  getLogBrewContext,
  LOG_BREW_SVELTE_KEY,
  setLogBrewContext,
  shouldPropagateTraceparent,
  useLogBrew
};
