"use strict";

const { SdkError } = require("@logbrew/sdk");
const {
  createBrowserTraceContext,
  optionalBrowserTraceContext
} = require("./trace-context.cjs");

async function captureBrowserResourceTiming(entry, context, options = {}) {
  const eventOptions = eventOptionsWithContext(context, options);
  const event = createBrowserResourceTimingEvent(entry, context.browserWindow, eventOptions);

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

function installLogBrewBrowserResourceTimingInstrumentation(context, options = {}) {
  if (!context || typeof context !== "object" || !context.client) {
    throw new SdkError("configuration_error", "installLogBrewBrowserResourceTimingInstrumentation requires a browser context");
  }
  const browserWindow = options.browserWindow ?? context.browserWindow ?? defaultWindow();
  const PerformanceObserverConstructor = options.performanceObserver
    ?? browserWindow?.PerformanceObserver
    ?? globalThis.PerformanceObserver;
  if (typeof PerformanceObserverConstructor !== "function") {
    throw new SdkError(
      "configuration_error",
      "installLogBrewBrowserResourceTimingInstrumentation requires PerformanceObserver"
    );
  }

  const observer = new PerformanceObserverConstructor((entryList) => {
    for (const entry of resourceEntries(entryList)) {
      void captureBrowserResourceTiming(entry, context, options);
    }
  });
  try {
    observer.observe({
      buffered: options.buffered !== false,
      type: "resource"
    });
  } catch {
    observer.observe({ entryTypes: ["resource"] });
  }

  return {
    uninstall() {
      observer.disconnect?.();
    }
  };
}

function createBrowserResourceTimingEvent(entry, browserWindow = defaultWindow(), {
  idFactory = defaultResourceTimingEventId,
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
  traceContext,
  traceFlags
} = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new SdkError("configuration_error", "createBrowserResourceTimingEvent requires a resource timing entry");
  }
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const details = resourceTimingDetails(entry, resourcePathTemplate);
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
    source: "browser.resource"
  });
  const resourceMetadata = compactMetadata({
    connectMs: details.connectMs,
    decodedBodySize: details.decodedBodySize,
    deliveryType: details.deliveryType,
    encodedBodySize: details.encodedBodySize,
    initiatorType: details.initiatorType,
    lookupMs: details.lookupMs,
    redirectMs: details.redirectMs,
    requestMs: details.requestMs,
    resourcePath: details.resourcePath,
    responseMs: details.responseMs,
    statusCode: details.statusCode,
    tlsMs: details.tlsMs,
    transferSize: details.transferSize,
    workerMs: details.workerMs
  });
  const safeMetadata = sanitizeMetadata(
    mergeMetadata(mergeMetadata(baseMetadata, metadata), resourceMetadata),
    "resource"
  );
  return {
    id: idFactory({ browserWindow, message: `${details.initiatorType} ${details.resourcePath}`, path, source: "resource" }),
    timestamp: now(),
    attributes: {
      durationMs: details.durationMs,
      metadata: safeMetadata,
      name: `browser.resource ${details.initiatorType} ${details.resourcePath}`,
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

function eventOptionsWithContext(context, options) {
  if (options.traceContext !== undefined || context.traceContext === undefined) {
    return options;
  }
  return {
    ...options,
    traceContext: context.traceContext
  };
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

function resourceTimingDetails(entry, resourcePathTemplate) {
  const resourcePath = resourceTimingPath(entry, resourcePathTemplate);
  const statusCode = resourceStatusCode(entry);
  return {
    connectMs: durationBetween(entry.connectStart, entry.connectEnd),
    decodedBodySize: nonNegativeNumberOrUndefined(entry.decodedBodySize),
    deliveryType: stringOrUndefined(entry.deliveryType),
    durationMs: resourceDurationMs(entry),
    encodedBodySize: nonNegativeNumberOrUndefined(entry.encodedBodySize),
    initiatorType: resourceInitiatorType(entry),
    lookupMs: durationBetween(entry.domainLookupStart, entry.domainLookupEnd),
    redirectMs: durationBetween(entry.redirectStart, entry.redirectEnd),
    requestMs: durationBetween(entry.requestStart, entry.responseStart),
    resourcePath,
    responseMs: durationBetween(entry.responseStart, entry.responseEnd),
    status: statusCode !== undefined && statusCode >= 400 ? "error" : "ok",
    statusCode,
    tlsMs: durationBetween(entry.secureConnectionStart, entry.connectEnd, { requirePositiveStart: true }),
    transferSize: nonNegativeNumberOrUndefined(entry.transferSize),
    workerMs: durationBetween(entry.workerStart, entry.fetchStart, { requirePositiveStart: true })
  };
}

function resourceTimingPath(entry, resourcePathTemplate) {
  const path = sanitizeSourcePath(entry?.name) ?? "/";
  if (typeof resourcePathTemplate === "function") {
    return routeTemplatePath(resourcePathTemplate({
      entry,
      initiatorType: resourceInitiatorType(entry),
      path
    }) ?? path);
  }
  if (typeof resourcePathTemplate === "string" && resourcePathTemplate.trim() !== "") {
    return routeTemplatePath(resourcePathTemplate);
  }
  return routeTemplatePath(path);
}

function resourceStatusCode(entry) {
  const statusCode = numberOrUndefined(entry?.responseStatus ?? entry?.statusCode);
  return statusCode === 0 ? undefined : statusCode;
}

function resourceDurationMs(entry) {
  return nonNegativeNumberOrUndefined(entry?.duration)
    ?? durationBetween(entry?.startTime, entry?.responseEnd);
}

function resourceInitiatorType(entry) {
  return stringOrUndefined(entry?.initiatorType) ?? "resource";
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

function defaultResourceTimingEventId({ message, path }) {
  return `evt_browser_resource_${slugify(`${path}_${message}`)}`;
}

function resourceEntries(entryList) {
  const entries = typeof entryList?.getEntries === "function" ? entryList.getEntries() : [];
  return Array.from(entries).filter((entry) => entry?.entryType === "resource");
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
  captureBrowserResourceTiming,
  createBrowserResourceTimingEvent,
  installLogBrewBrowserResourceTimingInstrumentation
};
