import { SdkError, parseTraceparent } from "@logbrew/sdk";
import { captureSvelteError, isFunction, isLogBrewSvelteContext, notifyFailure, now, readField } from "./capture.js";
import { createBrowserTraceparent } from "@logbrew/browser";

/**
 * @import { Metadata, MetadataValue, TraceparentContext } from "@logbrew/sdk"
 * @import {
 *   LogBrewSvelteContext,
 *   LogBrewSvelteKitHooks,
 *   LogBrewSvelteKitHooksOptions,
 *   SvelteKitEvent,
 *   SvelteKitHandleErrorInput,
 *   SvelteKitHandleInput
 * } from "./index.js"
 * @typedef {{ readonly parentSpanId?: string, readonly spanId: string, readonly traceId: string }} SvelteKitTrace
 * @typedef {{
 *   readonly context: LogBrewSvelteContext,
 *   readonly event: unknown,
 *   readonly options: LogBrewSvelteKitHooksOptions,
 *   readonly startedAt: number,
 *   readonly status: unknown,
 *   readonly trace: SvelteKitTrace
 * }} SvelteKitRequestCapture
 * @typedef {{
 *   readonly get: (event: unknown) => SvelteKitTrace | undefined,
 *   readonly set: (event: object, trace: SvelteKitTrace) => void
 * }} TraceStore
 */

const SERVER_ERROR = 500;
const MIN_STATUS = 100;
const MAX_STATUS = 599;
const STATUS_CLASS_SIZE = 100;
const MAX_ROUTE_LENGTH = 256;
const NO_DURATION = 0;

/**
 * @param {LogBrewSvelteKitHooksOptions} options
 * @returns {number}
 */
function nowMs(options) {
  return options.nowMs !== undefined && isFunction(options.nowMs) ? options.nowMs() : Date.now();
}

/**
 * @param {unknown} event
 * @returns {string}
 */
function svelteKitMethod(event) {
  const method = readField(readField(event, "request"), "method");
  return typeof method === "string" && /^[A-Za-z]{1,16}$/u.test(method) ? method.toUpperCase() : "GET";
}

/**
 * @param {unknown} event
 * @returns {string}
 */
function svelteKitRoute(event) {
  const route = readField(readField(event, "route"), "id");
  return typeof route === "string" && route.trim() !== "" && route.length <= MAX_ROUTE_LENGTH ? route : "<unmatched>";
}

/**
 * @param {unknown} event
 * @param {MetadataValue | undefined} statusCode
 * @param {Readonly<Metadata> | undefined} metadata
 * @returns {Metadata}
 */
function svelteKitMetadata(event, statusCode, metadata) {
  const statusClass = Math.floor(Number(statusCode) / STATUS_CLASS_SIZE);
  return {
    ...metadata,
    framework: "sveltekit",
    method: svelteKitMethod(event),
    operation: "http.server",
    routeTemplate: svelteKitRoute(event),
    ...(statusCode === undefined ? {} : { statusCode }),
    statusCodeClass: `${String(statusClass)}xx`
  };
}

/**
 * @param {unknown} request
 * @returns {TraceparentContext | undefined}
 */
function requestTraceparent(request) {
  try {
    const headers = readField(request, "headers");
    const get = readField(headers, "get");
    /** @type {unknown} */
    const value = typeof get === "function" ? Reflect.apply(get, headers, ["traceparent"]) : undefined;
    return typeof value === "string" && value !== "" ? parseTraceparent(value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} request
 * @param {LogBrewSvelteKitHooksOptions} options
 * @returns {SvelteKitTrace}
 */
function createSvelteKitTrace(request, options) {
  const parent = requestTraceparent(request);
  const traceFlags = parent?.traceFlags ?? options.traceFlags;
  const generated = parseTraceparent(createBrowserTraceparent({
    ...(options.randomValues === undefined ? {} : { randomValues: options.randomValues }),
    ...(traceFlags === undefined ? {} : { traceFlags }),
    ...(parent === undefined ? {} : { traceId: parent.traceId })
  }));
  return {
    spanId: generated.parentSpanId,
    traceId: generated.traceId,
    ...(parent === undefined ? {} : { parentSpanId: parent.parentSpanId })
  };
}

/**
 * @param {unknown} status
 * @returns {number}
 */
function statusCodeOf(status) {
  return typeof status === "number" && Number.isInteger(status) && status >= MIN_STATUS && status <= MAX_STATUS ? status : SERVER_ERROR;
}

/**
 * @param {SvelteKitRequestCapture} capture
 * @returns {void}
 */
function recordRequestSpan(capture) {
  const { context, event, options, startedAt, status, trace } = capture;
  const statusCode = statusCodeOf(status);
  const { parentSpanId } = trace;
  context.client.span(`evt_sveltekit_request_${trace.spanId}`, now(options), {
    durationMs: Math.max(NO_DURATION, nowMs(options) - startedAt),
    name: `${svelteKitMethod(event)} ${svelteKitRoute(event)}`,
    ...(parentSpanId === undefined || parentSpanId === "" ? {} : { parentSpanId }),
    spanId: trace.spanId,
    status: statusCode >= SERVER_ERROR ? "error" : "ok",
    traceId: trace.traceId,

    metadata: svelteKitMetadata(event, statusCode, options.metadata)
  });
}

/**
 * @param {SvelteKitRequestCapture} capture
 * @returns {Promise<void>}
 */
async function captureSvelteKitRequest(capture) {
  const { context, options } = capture;
  if (options.captureRequests === false) {
    return;
  }
  try {
    recordRequestSpan(capture);
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

/**
 * @returns {TraceStore}
 */
function createTraceStore() {
  /** @type {WeakMap<object, SvelteKitTrace>} */
  const traces = new WeakMap();
  return {
    get: (event) => (typeof event === "object" && event !== null ? traces.get(event) : undefined),
    set: (event, trace) => {
      traces.set(event, trace);
    }
  };
}

/**
 * @param {SvelteKitEvent} event
 * @param {LogBrewSvelteKitHooksOptions} options
 * @param {TraceStore} traces
 * @returns {SvelteKitTrace}
 */
function startTrace(event, options, traces) {
  const trace = createSvelteKitTrace(event.request, options);
  traces.set(event, trace);
  return trace;
}

/**
 * @param {unknown} event
 * @param {unknown} resolve
 * @returns {void}
 */
function requireHandleInput(event, resolve) {
  const hasEvent = Boolean(event);
  if (!hasEvent || !isFunction(resolve)) {
    throw new SdkError("configuration_error", "SvelteKit handle requires event and resolve");
  }
}

/**
 * @param {LogBrewSvelteContext} context
 * @param {LogBrewSvelteKitHooksOptions} options
 * @param {TraceStore} traces
 * @returns {LogBrewSvelteKitHooks["handle"]}
 */
function createHandle(context, options, traces) {
  /**
   * @template {SvelteKitEvent} TEvent
   * @template TResponse
   * @param {SvelteKitHandleInput<TEvent, TResponse>} input
   * @returns {Promise<TResponse>}
   */
  async function handle(input) {
    const { event, resolve } = input;
    requireHandleInput(event, resolve);
    const request = { context, event, options, startedAt: nowMs(options), trace: startTrace(event, options, traces) };
    try {
      const response = await resolve(event);
      await captureSvelteKitRequest({ ...request, status: readField(response, "status") });
      return response;
    } catch (error) {
      await captureSvelteKitRequest({ ...request, status: SERVER_ERROR });
      throw error;
    }
  }
  return handle;
}

/**
 * @param {unknown} input
 * @returns {MetadataValue | undefined}
 */
function statusOf(input) {
  const status = readField(input, "status");
  return status === null || typeof status === "string" || typeof status === "number" || typeof status === "boolean" ? status : undefined;
}

/**
 * @param {unknown} event
 * @param {LogBrewSvelteKitHooksOptions} options
 * @param {TraceStore} traces
 * @returns {SvelteKitTrace}
 */
function traceFor(event, options, traces) {
  return traces.get(event) ?? createSvelteKitTrace(readField(event, "request"), options);
}

/**
 * @template TResult
 * @param {LogBrewSvelteContext} context
 * @param {LogBrewSvelteKitHooksOptions<TResult>} options
 * @param {TraceStore} traces
 * @returns {LogBrewSvelteKitHooks<TResult>["handleError"]}
 */
function createHandleError(context, options, traces) {
  /**
   * @template {SvelteKitEvent} TEvent
   * @param {SvelteKitHandleErrorInput<TEvent>} input
   * @returns {Promise<TResult | undefined>}
   */
  async function handleError(input) {
    const event = readField(input, "event");
    try {
      await captureSvelteError(readField(input, "error"), context, {
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
        metadata: svelteKitMetadata(event, statusOf(input), options.metadata),
        source: "sveltekit.handle_error",
        trace: traceFor(event, options, traces)
      });
    } catch (error) {
      if (options.raiseCaptureErrors === true) {
        throw error;
      }
    }
    return options.mapError !== undefined && isFunction(options.mapError) ? options.mapError(input) : undefined;
  }
  return handleError;
}

/**
 * @template [TResult=unknown]
 * @param {LogBrewSvelteContext} context
 * @param {LogBrewSvelteKitHooksOptions<TResult>} [options]
 * @returns {LogBrewSvelteKitHooks<TResult>}
 */
function createLogBrewSvelteKitHooks(context, options = {}) {
  if (!isLogBrewSvelteContext(context)) {
    throw new SdkError("configuration_error", "createLogBrewSvelteKitHooks requires a LogBrew context");
  }
  const traces = createTraceStore();
  return {
    handle: createHandle(context, options, traces),
    handleError: createHandleError(context, options, traces)
  };
}

export { createLogBrewSvelteKitHooks };
