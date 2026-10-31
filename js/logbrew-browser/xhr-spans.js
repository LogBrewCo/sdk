import {
  assertBrowserContext,
  defaultSanitizeMetadata,
  defaultWindow,
  flushAfterCapture,
  optionsWithTraceContext,
  safeMetadata
} from "./browser-events.js";
import { callMethod, isRecord, readField } from "./values.js";
import {
  contentLengthBytes,
  durationSince,
  errorType,
  normalizeMethod,
  nowMs,
  shouldCaptureRequest,
  traceparentFromTraceContext,
  validateTargets
} from "./network-spans.js";
import {
  createAutomaticBrowserEventId,
  createBrowserTraceContext,
  resolveTraceContext
} from "./trace-context.js";
import { SdkError } from "@logbrew/sdk";
import { createBrowserFetchSpanEvent } from "./fetch-spans.js";
import { shouldPropagateTraceparent } from "./traceparent-fetch.js";

/**
 * @import { Metadata, SpanAttributes, TransportResponse } from "@logbrew/sdk"
 * @import {
 *   BrowserEventIdContext,
 *   BrowserTraceContext,
 *   BrowserTraceContextInput,
 *   BrowserXhrInput,
 *   BrowserXhrInstrumentation,
 *   BrowserXhrOptions,
 *   LogBrewBrowserContext,
 *   LogBrewBrowserEvent
 * } from "./index.js"
 * @typedef {BrowserXhrOptions & { readonly spanTraceContext?: BrowserTraceContextInput | undefined }} XhrSpanOptions
 * @typedef {{ readonly method: string, readonly url: string }} XhrRequestState
 * @typedef {{
 *   readonly context: LogBrewBrowserContext,
 *   readonly options: BrowserXhrOptions,
 *   readonly states: WeakMap<object, XhrRequestState>
 * }} XhrSetup
 * @typedef {{
 *   readonly parentTraceContext: BrowserTraceContext | undefined,
 *   readonly shouldCapture: boolean,
 *   readonly spanTraceContext: BrowserTraceContext,
 *   readonly startMs: number,
 *   readonly state: XhrRequestState,
 *   readonly tracePropagated: boolean
 * }} XhrCall
 * @typedef {XhrCall & { readonly errorType: string | undefined }} XhrOutcome
 * @typedef {(...args: readonly unknown[]) => unknown} XhrMethod
 * @typedef {{ readonly open: XhrMethod, readonly send: XhrMethod }} XhrPrototype
 */

const DECIMAL = 10;
const NO_STATUS = 0;

/**
 * @param {{ readonly message?: string | undefined, readonly path: string }} context
 * @returns {string}
 */
function defaultXhrSpanEventId({ message, path }) {
  return createAutomaticBrowserEventId("evt_browser_xhr", `${path}_${message}`);
}

/**
 * @param {BrowserXhrInput} request
 * @param {Window} [browserWindow]
 * @param {XhrSpanOptions} [options]
 * @returns {LogBrewBrowserEvent<SpanAttributes>}
 */
function createBrowserXhrSpanEvent(request, browserWindow = defaultWindow(), options = {}) {
  if (!isRecord(request)) {
    throw new SdkError("configuration_error", "createBrowserXhrSpanEvent requires an XHR request summary");
  }
  const { idFactory, sanitizeMetadata = defaultSanitizeMetadata } = options;
  const fetchLikeRequest = {
    durationMs: request.durationMs,
    errorType: request.errorType,
    input: request.url,
    method: request.method,
    responseBodySize: request.responseBodySize,
    spanTraceContext: request.spanTraceContext,
    statusCode: request.statusCode,
    tracePropagated: request.tracePropagated,
    url: request.url
  };
  const event = createBrowserFetchSpanEvent(fetchLikeRequest, browserWindow, {
    ...options,
    /**
     * @param {BrowserEventIdContext} context
     * @returns {string}
     */
    idFactory(context) {
      return typeof idFactory === "function"
        ? idFactory({ ...context, request, source: "xhr" })
        : defaultXhrSpanEventId({ message: context.message, path: context.path });
    },
    /**
     * @param {Readonly<Metadata>} metadata
     * @returns {Metadata}
     */
    sanitizeMetadata(metadata) {
      return sanitizeMetadata(metadata, "xhr");
    },
    spanTraceContext: request.spanTraceContext ?? options.spanTraceContext
  });
  const requestPath = event.attributes.metadata?.["requestPath"] ?? "/";
  return {
    ...event,
    attributes: {
      ...event.attributes,
      metadata: {
        ...safeMetadata(event.attributes.metadata),
        source: "browser.xhr"
      },
      name: `browser.xhr ${normalizeMethod(request.method)} ${String(requestPath)}`
    }
  };
}

/**
 * @param {BrowserXhrInput} request
 * @param {LogBrewBrowserContext} context
 * @param {XhrSpanOptions} [options]
 * @returns {Promise<TransportResponse | undefined>}
 */
async function captureBrowserXhrSpan(request, context, options = {}) {
  assertBrowserContext(context, "captureBrowserXhrSpan");
  const eventOptions = optionsWithTraceContext(options, resolveTraceContext(context, options));
  const event = createBrowserXhrSpanEvent(request, context.browserWindow, eventOptions);

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

/**
 * @param {object} xhr
 * @param {string} url
 * @param {XhrSetup & { readonly traceContext: BrowserTraceContext }} setup
 * @returns {boolean}
 */
function setTraceparentHeader(xhr, url, { options, traceContext }) {
  if (!shouldPropagateTraceparent(url, options.tracePropagationTargets ?? [])) {
    return false;
  }
  if (typeof readField(xhr, "setRequestHeader") !== "function") {
    return false;
  }
  try {
    callMethod(xhr, "setRequestHeader", ["traceparent", traceparentFromTraceContext(traceContext)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} xhr
 * @param {string} type
 * @param {() => void} listener
 * @returns {() => void}
 */
function addXhrListener(xhr, type, listener) {
  if (typeof readField(xhr, "addEventListener") !== "function") {
    return () => undefined;
  }
  callMethod(xhr, "addEventListener", [type, listener]);
  return () => {
    callMethod(xhr, "removeEventListener", [type, listener]);
  };
}

/**
 * @param {unknown} xhr
 * @returns {number | undefined}
 */
function xhrStatus(xhr) {
  const status = readField(xhr, "status");
  const value = typeof status === "number" ? status : Number.parseInt(String(status), DECIMAL);
  return Number.isInteger(value) && value >= NO_STATUS ? value : undefined;
}

/**
 * @param {unknown} xhr
 * @returns {number | undefined}
 */
function xhrResponseBodySize(xhr) {
  if (typeof readField(xhr, "getResponseHeader") !== "function") {
    return undefined;
  }
  return contentLengthBytes(callMethod(xhr, "getResponseHeader", ["content-length"]) ?? callMethod(xhr, "getResponseHeader", ["Content-Length"]));
}

/**
 * @param {object} xhr
 * @param {XhrSetup} setup
 * @returns {XhrCall}
 */
function beginXhrCall(xhr, setup) {
  const { context, options } = setup;
  const state = setup.states.get(xhr) ?? { method: "GET", url: "" };
  const startMs = nowMs(options);
  const parentTraceContext = resolveTraceContext(context, options);
  const spanTraceContext = createBrowserTraceContext({
    randomValues: options.randomValues,
    sampled: parentTraceContext?.sampled ?? options.sampled,
    traceFlags: parentTraceContext?.traceFlags ?? options.traceFlags,
    traceId: parentTraceContext?.traceId
  });
  const shouldCapture = shouldCaptureRequest(state.url, options.captureTargets);
  const tracePropagated = setTraceparentHeader(xhr, state.url, { ...setup, traceContext: spanTraceContext });
  return { parentTraceContext, shouldCapture, spanTraceContext, startMs, state, tracePropagated };
}

/**
 * @param {object} xhr
 * @param {XhrOutcome} call
 * @param {XhrSetup} setup
 * @returns {void}
 */
function captureXhrCall(xhr, call, { context, options }) {
  void captureBrowserXhrSpan({
    durationMs: durationSince(call.startMs, options),
    errorType: call.errorType,
    method: call.state.method,
    responseBodySize: xhrResponseBodySize(xhr),
    spanTraceContext: call.spanTraceContext,
    statusCode: xhrStatus(xhr),
    tracePropagated: call.tracePropagated,
    url: call.state.url
  }, context, optionsWithTraceContext(options, call.parentTraceContext));
}

/**
 * @param {object} xhr
 * @param {XhrCall} call
 * @param {XhrSetup} setup
 * @returns {(eventType: string | undefined) => void}
 */
function xhrCompletion(xhr, call, setup) {
  const progress = { completed: false };
  /** @type {(() => void)[]} */
  const removeListeners = [];
  /**
   * @param {string | undefined} eventType
   * @returns {void}
   */
  function complete(eventType) {
    if (progress.completed) {
      return;
    }
    progress.completed = true;
    for (const removeListener of removeListeners) {
      removeListener();
    }
    if (call.shouldCapture) {
      captureXhrCall(xhr, { ...call, errorType: eventType }, setup);
    }
  }
  removeListeners.push(
    addXhrListener(xhr, "load", () => {
      complete(undefined);
    }),
    addXhrListener(xhr, "error", () => {
      complete("error");
    }),
    addXhrListener(xhr, "abort", () => {
      complete("abort");
    }),
    addXhrListener(xhr, "timeout", () => {
      complete("timeout");
    })
  );
  return complete;
}

/**
 * @param {XhrSetup} setup
 * @param {XhrMethod} originalOpen
 * @returns {(this: XMLHttpRequest, method: unknown, url: unknown, ...args: readonly unknown[]) => unknown}
 */
function createXhrOpen(setup, originalOpen) {
  return function logbrewXhrOpen(method, url, ...args) {
    setup.states.set(this, {
      method: normalizeMethod(method),
      url: String(url)
    });
    return Reflect.apply(originalOpen, this, [method, url, ...args]);
  };
}

/**
 * @param {XhrSetup} setup
 * @param {XhrMethod} originalSend
 * @returns {(this: XMLHttpRequest, ...args: readonly unknown[]) => unknown}
 */
function createXhrSend(setup, originalSend) {
  return function logbrewXhrSend(...args) {
    const complete = xhrCompletion(this, beginXhrCall(this, setup), setup);
    try {
      return Reflect.apply(originalSend, this, args);
    } catch (error) {
      complete(errorType(error));
      throw error;
    }
  };
}

/**
 * @param {unknown} value
 * @returns {value is XhrPrototype}
 */
function isXhrPrototype(value) {
  return Boolean(value) && typeof readField(value, "open") === "function" && typeof readField(value, "send") === "function";
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserXhrOptions} options
 * @returns {XhrPrototype}
 */
function xhrPrototype(context, options) {
  const browserWindow = options.browserWindow ?? context.browserWindow ?? defaultWindow();
  const XhrConstructor = options.XMLHttpRequest
    ?? readField(browserWindow, "XMLHttpRequest")
    ?? readField(defaultWindow(), "XMLHttpRequest");
  const prototype = readField(XhrConstructor, "prototype");
  if (!isXhrPrototype(prototype)) {
    throw new SdkError(
      "configuration_error",
      "installLogBrewBrowserXhrInstrumentation requires XMLHttpRequest.open/send"
    );
  }
  return prototype;
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserXhrOptions} [options]
 * @returns {BrowserXhrInstrumentation}
 */
function installLogBrewBrowserXhrInstrumentation(context, options = {}) {
  assertBrowserContext(context, "installLogBrewBrowserXhrInstrumentation");
  validateTargets(options.tracePropagationTargets ?? [], "tracePropagationTargets");
  validateTargets(options.captureTargets, "captureTargets", { optional: true });
  const prototype = xhrPrototype(context, options);
  const { open: originalOpen, send: originalSend } = prototype;
  const setup = { context, options, states: new WeakMap() };
  const wrappedOpen = createXhrOpen(setup, originalOpen);
  const wrappedSend = createXhrSend(setup, originalSend);
  Object.assign(prototype, { open: wrappedOpen, send: wrappedSend });
  return {
    uninstall() {
      if (prototype.open === wrappedOpen) {
        Object.assign(prototype, { open: originalOpen });
      }
      if (prototype.send === wrappedSend) {
        Object.assign(prototype, { send: originalSend });
      }
    }
  };
}

export {
  captureBrowserXhrSpan,
  createBrowserXhrSpanEvent,
  installLogBrewBrowserXhrInstrumentation
};
