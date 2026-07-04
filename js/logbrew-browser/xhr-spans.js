import { SdkError } from "@logbrew/sdk";
import { createBrowserFetchSpanEvent } from "./fetch-spans.js";
import {
  createBrowserTraceContext,
  optionalBrowserTraceContext,
  shouldPropagateTraceparent
} from "./trace-context.js";

export async function captureBrowserXhrSpan(request, context, options = {}) {
  assertBrowserContext(context, "captureBrowserXhrSpan");
  const event = createBrowserXhrSpanEvent(request, context.browserWindow, optionsWithTraceContext(
    options,
    resolveTraceContext(context, options)
  ));

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

export function createBrowserXhrSpanEvent(request, browserWindow = defaultWindow(), options = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new SdkError("configuration_error", "createBrowserXhrSpanEvent requires an XHR request summary");
  }
  const {
    idFactory,
    sanitizeMetadata = defaultSanitizeMetadata
  } = options;
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
    idFactory(context) {
      return typeof idFactory === "function"
        ? idFactory({ ...context, request, source: "xhr" })
        : defaultXhrSpanEventId({ message: context.message, path: context.path });
    },
    spanTraceContext: request.spanTraceContext ?? options.spanTraceContext,
    sanitizeMetadata(metadata) {
      return sanitizeMetadata(metadata, "xhr");
    }
  });
  const requestPath = event.attributes.metadata?.requestPath ?? "/";
  return {
    ...event,
    attributes: {
      ...event.attributes,
      metadata: {
        ...safeMetadata(event.attributes.metadata),
        source: "browser.xhr"
      },
      name: `browser.xhr ${xhrMethod(request.method)} ${requestPath}`
    }
  };
}

export function installLogBrewBrowserXhrInstrumentation(context, options = {}) {
  assertBrowserContext(context, "installLogBrewBrowserXhrInstrumentation");
  validateTargets(options.tracePropagationTargets ?? [], "tracePropagationTargets");
  validateTargets(options.captureTargets, "captureTargets", { optional: true });
  const browserWindow = options.browserWindow ?? context.browserWindow ?? defaultWindow();
  const XhrConstructor = options.XMLHttpRequest ?? browserWindow?.XMLHttpRequest ?? defaultWindow()?.XMLHttpRequest;
  const prototype = XhrConstructor?.prototype;
  if (!prototype || typeof prototype.open !== "function" || typeof prototype.send !== "function") {
    throw new SdkError(
      "configuration_error",
      "installLogBrewBrowserXhrInstrumentation requires XMLHttpRequest.open/send"
    );
  }

  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  const states = new WeakMap();

  /* eslint-disable no-invalid-this */
  const wrappedOpen = function logbrewXhrOpen(method, url, ...args) {
    states.set(this, {
      method: xhrMethod(method),
      url: xhrUrl(url, browserWindow)
    });
    return Reflect.apply(originalOpen, this, [method, url, ...args]);
  };
  prototype.open = wrappedOpen;

  const wrappedSend = function logbrewXhrSend(...args) {
    const state = states.get(this) ?? {
      method: "GET",
      url: xhrUrl("", browserWindow)
    };
    const startMs = nowMs(options);
    const parentTraceContext = resolveTraceContext(context, options);
    const spanTraceContext = createBrowserTraceContext({
      randomValues: options.randomValues,
      sampled: parentTraceContext?.sampled ?? options.sampled,
      traceFlags: parentTraceContext?.traceFlags ?? options.traceFlags,
      traceId: parentTraceContext?.traceId
    });
    const shouldCapture = shouldCaptureRequest(state.url, options.captureTargets);
    const tracePropagated = setTraceparentHeader(this, state.url, spanTraceContext, options);
    let completed = false;
    const complete = (eventType) => {
      if (completed) {
        return;
      }
      completed = true;
      removeListeners.forEach((removeListener) => removeListener());
      if (!shouldCapture) {
        return;
      }
      void captureBrowserXhrSpan({
        durationMs: durationSince(startMs, options),
        errorType: eventType,
        method: state.method,
        responseBodySize: xhrResponseBodySize(this),
        spanTraceContext,
        statusCode: xhrStatus(this),
        tracePropagated,
        url: state.url
      }, context, optionsWithTraceContext(options, parentTraceContext));
    };
    const removeListeners = [
      addXhrListener(this, "load", () => complete(undefined)),
      addXhrListener(this, "error", () => complete("error")),
      addXhrListener(this, "abort", () => complete("abort")),
      addXhrListener(this, "timeout", () => complete("timeout"))
    ];

    try {
      return Reflect.apply(originalSend, this, args);
    } catch (error) {
      complete(errorType(error));
      throw error;
    }
  };
  /* eslint-enable no-invalid-this */
  prototype.send = wrappedSend;

  return {
    uninstall() {
      if (prototype.open === wrappedOpen) {
        prototype.open = originalOpen;
      }
      if (prototype.send === wrappedSend) {
        prototype.send = originalSend;
      }
    }
  };
}

async function flushAfterCapture(context, options) {
  if (options.flushOnCapture === false) {
    return undefined;
  }
  try {
    const response = await context.client.flush(context.transport);
    if (typeof options.onFlush === "function") {
      await options.onFlush(response, context, { reason: "capture" });
    }
    return response;
  } catch (error) {
    if (typeof options.onCaptureError === "function") {
      await options.onCaptureError(error, context, { reason: "capture" });
    }
    if (options.raiseCaptureErrors === true) {
      throw error;
    }
    return undefined;
  }
}

function assertBrowserContext(context, functionName) {
  if (!context || typeof context !== "object" || !context.client) {
    throw new SdkError("configuration_error", `${functionName} requires a browser context`);
  }
}

function validateTargets(targets, name, { optional = false } = {}) {
  if (targets === undefined && optional) {
    return;
  }
  if (!Array.isArray(targets)) {
    throw new SdkError("configuration_error", `${name} must be an array`);
  }
}

function shouldCaptureRequest(url, captureTargets) {
  if (captureTargets === undefined) {
    return true;
  }
  return shouldPropagateTraceparent(url, captureTargets);
}

function resolveTraceContext(context, options) {
  if (options.traceContext !== undefined) {
    return typeof options.traceContext === "function"
      ? optionalBrowserTraceContext(options.traceContext())
      : optionalBrowserTraceContext(options.traceContext);
  }
  return context.traceContext;
}

function optionsWithTraceContext(options, traceContext) {
  return {
    ...options,
    traceContext
  };
}

function setTraceparentHeader(xhr, url, traceContext, options) {
  if (!shouldPropagateTraceparent(url, options.tracePropagationTargets ?? [])) {
    return false;
  }
  if (typeof xhr.setRequestHeader !== "function") {
    return false;
  }
  try {
    xhr.setRequestHeader("traceparent", traceparentFromTraceContext(traceContext));
    return true;
  } catch {
    return false;
  }
}

function traceparentFromTraceContext(traceContext) {
  return `00-${traceContext.traceId}-${traceContext.spanId}-${traceContext.traceFlags}`;
}

function addXhrListener(xhr, type, listener) {
  if (typeof xhr.addEventListener !== "function") {
    return () => {};
  }
  xhr.addEventListener(type, listener);
  return () => {
    if (typeof xhr.removeEventListener === "function") {
      xhr.removeEventListener(type, listener);
    }
  };
}

function xhrMethod(method) {
  return typeof method === "string" && method.trim() !== ""
    ? method.trim().toUpperCase()
    : "GET";
}

function xhrUrl(url, browserWindow) {
  try {
    return new URL(String(url), browserWindow?.location?.href ?? "https://logbrew.example").toString();
  } catch {
    return String(url);
  }
}

function xhrStatus(xhr) {
  const value = typeof xhr?.status === "number" ? xhr.status : Number.parseInt(String(xhr?.status), 10);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function xhrResponseBodySize(xhr) {
  if (typeof xhr?.getResponseHeader !== "function") {
    return undefined;
  }
  const contentLength = xhr.getResponseHeader("content-length") ?? xhr.getResponseHeader("Content-Length");
  if (typeof contentLength !== "string" || contentLength.trim() === "") {
    return undefined;
  }
  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function durationSince(startMs, options) {
  const endMs = nowMs(options);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  return Number((endMs - startMs).toFixed(3));
}

function nowMs(options) {
  if (typeof options.nowMs === "function") {
    const value = options.nowMs();
    return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
  }
  if (typeof globalThis.performance?.now === "function") {
    return globalThis.performance.now();
  }
  return Date.now();
}

function errorType(error) {
  return typeof error?.name === "string" && error.name.trim() !== "" ? error.name : "Error";
}

function safeMetadata(metadata) {
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
    return {};
  }
  const compacted = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      compacted[key] = value;
    }
  }
  return compacted;
}

function defaultSanitizeMetadata(metadata) {
  return safeMetadata(metadata);
}

function defaultWindow() {
  return typeof globalThis.window === "object" ? globalThis.window : undefined;
}

function defaultXhrSpanEventId({ message, path }) {
  return `evt_browser_xhr_${slugify(`${path}_${message}`)}`;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}
