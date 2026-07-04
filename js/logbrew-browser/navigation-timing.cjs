"use strict";

const { SdkError } = require("@logbrew/sdk");
const {
  createBrowserTraceContext,
  optionalBrowserTraceContext
} = require("./trace-context.cjs");

async function captureBrowserNavigationTiming(entry, context, options = {}) {
  assertBrowserContext(context, "captureBrowserNavigationTiming");
  const event = createBrowserNavigationTimingEvent(entry, context.browserWindow, optionsWithTraceContext(
    options,
    resolveTraceContext(context, options)
  ));

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

function installLogBrewBrowserNavigationTimingInstrumentation(context, options = {}) {
  assertBrowserContext(context, "installLogBrewBrowserNavigationTimingInstrumentation");
  const browserWindow = options.browserWindow ?? context.browserWindow ?? defaultWindow();
  if (!browserWindow) {
    throw new SdkError(
      "configuration_error",
      "installLogBrewBrowserNavigationTimingInstrumentation requires a browser window"
    );
  }

  let captured = false;
  const captureOnce = () => {
    if (captured) {
      return;
    }
    captured = true;
    scheduleAfterLoad(browserWindow, options, () => {
      const entry = options.entry ?? navigationTimingEntry(browserWindow);
      if (entry) {
        void captureBrowserNavigationTiming(entry, context, options);
      }
    });
  };
  const onLoad = () => captureOnce();

  if (options.captureInitial === false) {
    return { uninstall() {} };
  }
  if (browserWindow.document?.readyState === "complete") {
    captureOnce();
  } else if (typeof browserWindow.addEventListener === "function") {
    browserWindow.addEventListener("load", onLoad);
  } else {
    captureOnce();
  }

  return {
    uninstall() {
      browserWindow.removeEventListener?.("load", onLoad);
    }
  };
}

function createBrowserNavigationTimingEvent(entry, browserWindow = defaultWindow(), {
  idFactory = defaultNavigationTimingEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  navigationPathTemplate,
  now = () => new Date().toISOString(),
  randomValues,
  sampled,
  sanitizeMetadata = defaultSanitizeMetadata,
  traceContext,
  traceFlags
} = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new SdkError("configuration_error", "createBrowserNavigationTimingEvent requires a navigation timing entry");
  }
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const details = navigationTimingDetails(entry, navigationPathTemplate);
  const parentTraceContext = optionalBrowserTraceContext(traceContext);
  const spanTraceContext = createBrowserTraceContext({
    randomValues,
    sampled: parentTraceContext?.sampled ?? sampled,
    traceFlags: parentTraceContext?.traceFlags ?? traceFlags,
    traceId: parentTraceContext?.traceId
  });
  const baseMetadata = browserMetadata(browserWindow, {
    includeDocumentTitle,
    includeUserAgent,
    path,
    source: "browser.document"
  });
  const navigationMetadata = compactMetadata({
    activationStartMs: details.activationStartMs,
    connectMs: details.connectMs,
    decodedBodySize: details.decodedBodySize,
    documentPath: details.documentPath,
    domCompleteMs: details.domCompleteMs,
    domContentLoadedEventMs: details.domContentLoadedEventMs,
    domContentLoadedMs: details.domContentLoadedMs,
    domInteractiveMs: details.domInteractiveMs,
    encodedBodySize: details.encodedBodySize,
    fetchMs: details.fetchMs,
    firstByteMs: details.firstByteMs,
    loadEventDurationMs: details.loadEventDurationMs,
    loadEventMs: details.loadEventMs,
    lookupMs: details.lookupMs,
    navigationType: details.navigationType,
    redirectCount: details.redirectCount,
    redirectMs: details.redirectMs,
    requestMs: details.requestMs,
    responseMs: details.responseMs,
    responseStatus: details.responseStatus,
    tlsMs: details.tlsMs,
    transferSize: details.transferSize,
    workerMs: details.workerMs
  });
  const safeMetadata = sanitizeMetadata(
    mergeMetadata(mergeMetadata(baseMetadata, metadata), navigationMetadata),
    "document"
  );
  return {
    id: idFactory({ browserWindow, message: details.documentPath, path, source: "document" }),
    timestamp: now(),
    attributes: {
      durationMs: details.durationMs,
      metadata: safeMetadata,
      name: `browser.document ${details.documentPath}`,
      parentSpanId: parentTraceContext?.spanId,
      spanId: spanTraceContext.spanId,
      status: details.status,
      traceId: spanTraceContext.traceId
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

function scheduleAfterLoad(browserWindow, options, callback) {
  if (options.deferAfterLoad === false) {
    callback();
    return;
  }
  const setTimeoutImpl = options.setTimeout
    ?? browserWindow.setTimeout?.bind(browserWindow)
    ?? (typeof globalThis.setTimeout === "function" ? globalThis.setTimeout.bind(globalThis) : undefined);
  if (typeof setTimeoutImpl === "function") {
    setTimeoutImpl(callback, 0);
  } else {
    callback();
  }
}

function navigationTimingEntry(browserWindow) {
  const entries = browserWindow?.performance?.getEntriesByType?.("navigation");
  return Array.isArray(entries) ? entries[0] : entries?.[0];
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

function navigationTimingDetails(entry, navigationPathTemplate) {
  const documentPath = navigationTimingPath(entry, navigationPathTemplate);
  const responseStatus = responseStatusCode(entry);
  const startTime = nonNegativeNumberOrUndefined(entry.startTime) ?? 0;
  return {
    activationStartMs: nonNegativeRoundedNumber(entry.activationStart),
    connectMs: durationBetween(entry.connectStart, entry.connectEnd),
    decodedBodySize: nonNegativeNumberOrUndefined(entry.decodedBodySize),
    documentPath,
    domCompleteMs: durationSinceStart(entry.domComplete, startTime),
    domContentLoadedEventMs: durationBetween(entry.domContentLoadedEventStart, entry.domContentLoadedEventEnd),
    domContentLoadedMs: durationSinceStart(entry.domContentLoadedEventEnd, startTime),
    domInteractiveMs: durationSinceStart(entry.domInteractive, startTime),
    durationMs: navigationDurationMs(entry, startTime),
    encodedBodySize: nonNegativeNumberOrUndefined(entry.encodedBodySize),
    fetchMs: durationBetween(entry.fetchStart, entry.domainLookupStart),
    firstByteMs: durationSinceStart(entry.responseStart, startTime),
    loadEventDurationMs: durationBetween(entry.loadEventStart, entry.loadEventEnd),
    loadEventMs: durationSinceStart(entry.loadEventEnd, startTime),
    lookupMs: durationBetween(entry.domainLookupStart, entry.domainLookupEnd),
    navigationType: stringOrUndefined(entry.type ?? entry.navigationType) ?? "navigate",
    redirectCount: nonNegativeNumberOrUndefined(entry.redirectCount),
    redirectMs: durationBetween(entry.redirectStart, entry.redirectEnd),
    requestMs: durationBetween(entry.requestStart, entry.responseStart),
    responseMs: durationBetween(entry.responseStart, entry.responseEnd),
    responseStatus,
    status: responseStatus !== undefined && responseStatus >= 400 ? "error" : "ok",
    tlsMs: durationBetween(entry.secureConnectionStart, entry.connectEnd, { requirePositiveStart: true }),
    transferSize: nonNegativeNumberOrUndefined(entry.transferSize),
    workerMs: durationBetween(entry.workerStart, entry.fetchStart, { requirePositiveStart: true })
  };
}

function navigationTimingPath(entry, navigationPathTemplate) {
  const path = sanitizeSourcePath(entry?.name) ?? "/";
  if (typeof navigationPathTemplate === "function") {
    return routeTemplatePath(navigationPathTemplate({
      entry,
      navigationType: stringOrUndefined(entry?.type ?? entry?.navigationType) ?? "navigate",
      path
    }) ?? path);
  }
  if (typeof navigationPathTemplate === "string" && navigationPathTemplate.trim() !== "") {
    return routeTemplatePath(navigationPathTemplate);
  }
  return routeTemplatePath(path);
}

function responseStatusCode(entry) {
  const statusCode = numberOrUndefined(entry?.responseStatus ?? entry?.statusCode);
  return statusCode === 0 ? undefined : statusCode;
}

function navigationDurationMs(entry, startTime) {
  return nonNegativeRoundedNumber(entry?.duration)
    ?? durationSinceStart(entry?.loadEventEnd, startTime)
    ?? durationSinceStart(entry?.responseEnd, startTime);
}

function durationSinceStart(value, startTime) {
  const endMs = nonNegativeNumberOrUndefined(value);
  if (endMs === undefined || endMs < startTime) {
    return undefined;
  }
  return roundDurationMs(endMs - startTime);
}

function durationBetween(start, end, { requirePositiveStart = false } = {}) {
  const startMs = nonNegativeNumberOrUndefined(start);
  const endMs = nonNegativeNumberOrUndefined(end);
  if (startMs === undefined || endMs === undefined || endMs < startMs) {
    return undefined;
  }
  if (requirePositiveStart && startMs <= 0) {
    return undefined;
  }
  return roundDurationMs(endMs - startMs);
}

function nonNegativeRoundedNumber(value) {
  const number = nonNegativeNumberOrUndefined(value);
  return number === undefined ? undefined : roundDurationMs(number);
}

function roundDurationMs(value) {
  return Number(value.toFixed(3));
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

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function defaultNavigationTimingEventId({ message, path }) {
  return `evt_browser_document_${slugify(`${path}_${message}`)}`;
}

function defaultWindow() {
  return typeof globalThis.window === "object" ? globalThis.window : undefined;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

module.exports = {
  captureBrowserNavigationTiming,
  createBrowserNavigationTimingEvent,
  installLogBrewBrowserNavigationTimingInstrumentation
};
