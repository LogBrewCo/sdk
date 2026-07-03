import { SdkError } from "@logbrew/sdk";
import {
  createBrowserTraceContext,
  optionalBrowserTraceContext,
  shouldPropagateTraceparent
} from "./trace-context.js";

export function createLogBrewBrowserFetch(context, options = {}) {
  assertBrowserContext(context, "createLogBrewBrowserFetch");
  const fetchImpl = options.fetchImpl ?? context.browserWindow?.fetch ?? defaultFetch();
  if (typeof fetchImpl !== "function") {
    throw new SdkError("configuration_error", "createLogBrewBrowserFetch requires fetch");
  }
  validateTargets(options.tracePropagationTargets ?? [], "tracePropagationTargets");
  validateTargets(options.captureTargets, "captureTargets", { optional: true });

  return async function logbrewBrowserFetch(input, init) {
    const request = fetchRequest(input, init, context.browserWindow);
    const shouldCapture = shouldCaptureRequest(request.url, options.captureTargets);
    const startMs = nowMs(options);
    const parentTraceContext = resolveTraceContext(context, options);
    const spanTraceContext = createBrowserTraceContext({
      randomValues: options.randomValues,
      sampled: parentTraceContext?.sampled ?? options.sampled,
      traceFlags: parentTraceContext?.traceFlags ?? options.traceFlags,
      traceId: parentTraceContext?.traceId
    });
    const tracePropagated = shouldPropagateTraceparent(request.url, options.tracePropagationTargets ?? []);
    const nextInit = tracePropagated
      ? fetchInitWithTraceparent(input, init, spanTraceContext)
      : init;

    try {
      const response = await fetchImpl(input, nextInit);
      if (shouldCapture) {
        await captureBrowserFetchSpan({
          ...request,
          durationMs: durationSince(startMs, options),
          responseBodySize: responseBodySize(response),
          spanTraceContext,
          statusCode: responseStatus(response),
          tracePropagated
        }, context, optionsWithTraceContext(options, parentTraceContext));
      }
      return response;
    } catch (error) {
      if (shouldCapture) {
        await captureBrowserFetchSpan({
          ...request,
          durationMs: durationSince(startMs, options),
          errorType: errorType(error),
          spanTraceContext,
          tracePropagated
        }, context, optionsWithTraceContext(options, parentTraceContext));
      }
      throw error;
    }
  };
}

export function installLogBrewBrowserFetchInstrumentation(context, options = {}) {
  assertBrowserContext(context, "installLogBrewBrowserFetchInstrumentation");
  const browserWindow = options.browserWindow ?? context.browserWindow ?? defaultWindow();
  if (!browserWindow || typeof browserWindow.fetch !== "function") {
    throw new SdkError("configuration_error", "installLogBrewBrowserFetchInstrumentation requires window.fetch");
  }
  const originalFetch = browserWindow.fetch;
  const wrappedFetch = createLogBrewBrowserFetch(context, {
    ...options,
    browserWindow,
    fetchImpl: (input, init) => originalFetch.call(browserWindow, input, init)
  });
  browserWindow.fetch = wrappedFetch;

  return {
    uninstall() {
      if (browserWindow.fetch === wrappedFetch) {
        browserWindow.fetch = originalFetch;
      }
    }
  };
}

export async function captureBrowserFetchSpan(request, context, options = {}) {
  assertBrowserContext(context, "captureBrowserFetchSpan");
  const eventOptions = optionsWithTraceContext(options, resolveTraceContext(context, options));
  const event = createBrowserFetchSpanEvent(request, context.browserWindow, eventOptions);

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

export function createBrowserFetchSpanEvent(request, browserWindow = defaultWindow(), {
  idFactory = defaultFetchSpanEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = () => new Date().toISOString(),
  randomValues,
  resourcePathTemplate,
  sampled,
  sanitizeMetadata = defaultSanitizeMetadata,
  spanTraceContext,
  traceContext,
  traceFlags
} = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new SdkError("configuration_error", "createBrowserFetchSpanEvent requires a fetch request summary");
  }
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const details = fetchDetails(request, resourcePathTemplate);
  const parentTraceContext = optionalBrowserTraceContext(traceContext);
  const childTraceContext = optionalBrowserTraceContext(spanTraceContext ?? createBrowserTraceContext({
    randomValues,
    sampled: parentTraceContext?.sampled ?? sampled,
    traceFlags: parentTraceContext?.traceFlags ?? traceFlags,
    traceId: parentTraceContext?.traceId
  }));
  const baseMetadata = browserMetadata(browserWindow, {
    includeDocumentTitle,
    includeUserAgent,
    path,
    source: "browser.fetch"
  });
  const fetchMetadata = compactMetadata({
    errorType: details.errorType,
    method: details.method,
    requestPath: details.requestPath,
    responseBodySize: details.responseBodySize,
    statusCode: details.statusCode,
    tracePropagated: details.tracePropagated
  });
  const safeMetadata = sanitizeMetadata(
    mergeMetadata(mergeMetadata(baseMetadata, metadata), fetchMetadata),
    "fetch"
  );
  return {
    id: idFactory({ browserWindow, message: `${details.method} ${details.requestPath}`, path, request, source: "fetch" }),
    timestamp: now(),
    attributes: {
      durationMs: details.durationMs,
      metadata: safeMetadata,
      name: `browser.fetch ${details.method} ${details.requestPath}`,
      parentSpanId: parentTraceContext?.spanId,
      spanId: childTraceContext.spanId,
      status: details.status,
      traceId: childTraceContext.traceId
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

function fetchRequest(input, init, browserWindow) {
  return {
    init,
    input,
    method: fetchMethod(input, init),
    url: fetchUrl(input, browserWindow)
  };
}

function fetchMethod(input, init) {
  const method = init?.method ?? input?.method ?? "GET";
  return typeof method === "string" && method.trim() !== ""
    ? method.trim().toUpperCase()
    : "GET";
}

function fetchUrl(input, browserWindow) {
  if (typeof input === "string") {
    return absolutizeUrl(input, browserWindow);
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input?.url === "string") {
    return absolutizeUrl(input.url, browserWindow);
  }
  return absolutizeUrl(String(input), browserWindow);
}

function fetchInitWithTraceparent(input, init, traceContext) {
  const requestInit = init ?? {};
  return {
    ...requestInit,
    headers: headersWithTraceparent(requestHeaders(input, requestInit), traceparentFromTraceContext(traceContext))
  };
}

function traceparentFromTraceContext(traceContext) {
  return `00-${traceContext.traceId}-${traceContext.spanId}-${traceContext.traceFlags}`;
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

function requestHeaders(input, init) {
  if (init && init.headers !== undefined) {
    return init.headers;
  }
  return input?.headers;
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
  if (typeof headers[Symbol.iterator] === "function") {
    return Array.from(headers);
  }
  if (typeof headers === "object") {
    return Object.entries(headers);
  }
  return [];
}

function fetchDetails(request, resourcePathTemplate) {
  const statusCode = nonNegativeIntegerOrUndefined(request.statusCode);
  const errorTypeValue = stringOrUndefined(request.errorType);
  return {
    durationMs: nonNegativeNumberOrUndefined(request.durationMs) ?? 0,
    errorType: errorTypeValue,
    method: fetchMethod(request.input, { method: request.method }),
    requestPath: fetchPathTemplate(request, resourcePathTemplate),
    responseBodySize: nonNegativeIntegerOrUndefined(request.responseBodySize),
    status: errorTypeValue || (statusCode !== undefined && statusCode >= 400) ? "error" : "ok",
    statusCode,
    tracePropagated: request.tracePropagated === true
  };
}

function fetchPathTemplate(request, resourcePathTemplate) {
  const path = sanitizeSourcePath(request.url) ?? "/";
  if (typeof resourcePathTemplate === "function") {
    return routeTemplatePath(resourcePathTemplate({
      input: request.input,
      init: request.init,
      method: fetchMethod(request.input, { method: request.method }),
      path
    }) ?? path);
  }
  if (typeof resourcePathTemplate === "string" && resourcePathTemplate.trim() !== "") {
    return routeTemplatePath(resourcePathTemplate);
  }
  return routeTemplatePath(path);
}

function responseStatus(response) {
  return nonNegativeIntegerOrUndefined(response?.status);
}

function responseBodySize(response) {
  const contentLength = response?.headers?.get?.("content-length") ?? response?.headers?.get?.("Content-Length");
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
  return roundDurationMs(endMs - startMs);
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
  return stringOrUndefined(error?.name) ?? "Error";
}

function browserMetadata(browserWindow, {
  includeDocumentTitle,
  includeUserAgent,
  path,
  source
}) {
  return compactMetadata({
    documentTitle: includeDocumentTitle ? browserWindow?.document?.title : undefined,
    path,
    source,
    userAgent: includeUserAgent ? browserWindow?.navigator?.userAgent : undefined,
    visibilityState: browserWindow?.document?.visibilityState
  });
}

function browserPath(browserWindow, { includeHash = false, includeQueryString = false } = {}) {
  const location = browserWindow?.location;
  if (!location) {
    return "/";
  }
  const href = typeof location.href === "string" ? location.href : String(location);
  try {
    const url = new URL(href, "https://logbrew.example");
    return `${url.pathname || "/"}${includeQueryString ? url.search : ""}${includeHash ? url.hash : ""}`;
  } catch {
    return "/";
  }
}

function absolutizeUrl(url, browserWindow) {
  try {
    return new URL(url, browserWindow?.location?.href ?? "https://logbrew.example").toString();
  } catch {
    return String(url);
  }
}

function sanitizeSourcePath(source) {
  if (typeof source !== "string" || source.trim() === "") {
    return undefined;
  }
  try {
    return new URL(source, "https://logbrew.example").pathname || "/";
  } catch {
    return undefined;
  }
}

function routeTemplatePath(routeTemplate) {
  if (typeof routeTemplate !== "string" || routeTemplate.trim() === "") {
    return "/";
  }
  try {
    const url = new URL(routeTemplate, "https://logbrew.example");
    return url.pathname || "/";
  } catch {
    return "/";
  }
}

function mergeMetadata(baseMetadata, extraMetadata) {
  return compactMetadata({
    ...baseMetadata,
    ...safeMetadata(extraMetadata)
  });
}

function safeMetadata(metadata) {
  if (metadata === undefined) {
    return {};
  }
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
    return {};
  }
  return compactMetadata(metadata);
}

function compactMetadata(metadata) {
  const compacted = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      compacted[key] = value;
    }
  }
  return compacted;
}

function defaultSanitizeMetadata(metadata) {
  return safeMetadata(metadata);
}

function nonNegativeNumberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeIntegerOrUndefined(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function roundDurationMs(value) {
  return Number(value.toFixed(3));
}

function defaultFetch() {
  return globalThis.fetch;
}

function defaultWindow() {
  return typeof globalThis.window === "object" ? globalThis.window : undefined;
}

function defaultFetchSpanEventId({ message, path }) {
  return `evt_browser_fetch_${slugify(`${path}_${message}`)}`;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}
