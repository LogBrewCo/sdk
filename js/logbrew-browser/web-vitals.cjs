"use strict";

const { SdkError } = require("@logbrew/sdk");
const {
  createBrowserTraceContext,
  optionalBrowserTraceContext
} = require("./trace-context.cjs");

const DEFAULT_WEB_VITAL_METRICS = ["LCP", "CLS", "INP", "FCP", "TTFB"];
const METRIC_CALLBACKS = new Map([
  ["CLS", "onCLS"],
  ["FCP", "onFCP"],
  ["FID", "onFID"],
  ["INP", "onINP"],
  ["LCP", "onLCP"],
  ["TTFB", "onTTFB"]
]);
const MILLISECOND_METRICS = new Set(["FCP", "FID", "INP", "LCP", "TTFB"]);

async function captureBrowserWebVital(metric, context, options = {}) {
  assertBrowserContext(context, "captureBrowserWebVital");
  const event = createBrowserWebVitalEvent(metric, context.browserWindow, optionsWithTraceContext(
    options,
    resolveTraceContext(context, options)
  ));

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

function installLogBrewBrowserWebVitalsInstrumentation(context, options = {}) {
  assertBrowserContext(context, "installLogBrewBrowserWebVitalsInstrumentation");
  const registrations = webVitalRegistrations(options);
  let installed = true;
  const uninstallCallbacks = [];
  const metricNames = configuredMetricNames(options.metricNames);
  const captureMetric = (metric) => {
    if (installed) {
      void captureBrowserWebVital(metric, context, options);
    }
  };

  for (const metricName of metricNames) {
    const register = registrations.get(metricName);
    if (typeof register !== "function") {
      continue;
    }
    const unregister = register(captureMetric);
    if (typeof unregister === "function") {
      uninstallCallbacks.push(unregister);
    }
  }

  if (uninstallCallbacks.length === 0 && !metricNames.some((metricName) => typeof registrations.get(metricName) === "function")) {
    throw new SdkError(
      "configuration_error",
      "installLogBrewBrowserWebVitalsInstrumentation requires web-vitals callbacks such as onLCP or options.webVitals"
    );
  }

  return {
    uninstall() {
      if (!installed) {
        return;
      }
      installed = false;
      for (const unregister of uninstallCallbacks) {
        unregister();
      }
    }
  };
}

function createBrowserWebVitalEvent(metric, browserWindow = defaultWindow(), {
  idFactory = defaultWebVitalEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = () => new Date().toISOString(),
  randomValues,
  sampled,
  sanitizeMetadata = defaultSanitizeMetadata,
  traceContext,
  traceFlags,
  webVitalPathTemplate
} = {}) {
  const details = webVitalDetails(metric, webVitalPathTemplate);
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
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
    source: "browser.web_vital"
  });
  const metricMetadata = compactMetadata({
    delta: details.delta,
    elementRenderDelayMs: details.elementRenderDelayMs,
    inputDelayMs: details.inputDelayMs,
    loadState: details.loadState,
    metricId: details.metricId,
    metricName: details.metricName,
    metricUnit: details.metricUnit,
    metricValue: details.metricValue,
    navigationType: details.navigationType,
    presentationDelayMs: details.presentationDelayMs,
    processingDurationMs: details.processingDurationMs,
    resourceLoadDelayMs: details.resourceLoadDelayMs,
    resourceLoadDurationMs: details.resourceLoadDurationMs,
    timeToFirstByteMs: details.timeToFirstByteMs,
    vitalPath: details.vitalPath,
    rating: details.rating
  });
  const safeMetadata = sanitizeMetadata(
    mergeMetadata(mergeMetadata(baseMetadata, metadata), metricMetadata),
    "web_vital"
  );
  return {
    id: idFactory({ browserWindow, message: `${details.metricName} ${details.vitalPath}`, metric, path, source: "web_vital" }),
    timestamp: now(),
    attributes: {
      ...(details.durationMs !== undefined ? { durationMs: details.durationMs } : {}),
      metadata: safeMetadata,
      name: `browser.web_vital ${details.metricName} ${details.vitalPath}`,
      parentSpanId: parentTraceContext?.spanId,
      spanId: spanTraceContext.spanId,
      status: "ok",
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

function webVitalRegistrations(options) {
  const source = options.webVitals ?? options;
  const registrations = new Map();
  for (const [metricName, callbackName] of METRIC_CALLBACKS) {
    registrations.set(metricName, source?.[callbackName]);
  }
  return registrations;
}

function configuredMetricNames(metricNames) {
  if (metricNames === undefined) {
    return DEFAULT_WEB_VITAL_METRICS;
  }
  if (!Array.isArray(metricNames)) {
    throw new SdkError("configuration_error", "metricNames must be an array");
  }
  return metricNames.map((metricName) => normalizeMetricName(metricName));
}

function webVitalDetails(metric, webVitalPathTemplate) {
  if (!metric || typeof metric !== "object" || Array.isArray(metric)) {
    throw new SdkError("configuration_error", "createBrowserWebVitalEvent requires a Web Vital metric object");
  }
  const metricName = normalizeMetricName(metric.name);
  const metricValue = roundedMetricValue(metricName, finiteNonNegativeNumber("Web Vital metric value", metric.value));
  const metricUnit = metricUnitForName(metricName);
  const vitalPath = webVitalTemplatePath(metric, metricName, webVitalPathTemplate);
  const attribution = safeObject(metric.attribution);
  return {
    delta: roundedNumber(numberOrUndefined(metric.delta)),
    durationMs: metricUnit === "millisecond" ? metricValue : undefined,
    elementRenderDelayMs: roundedNumber(numberOrUndefined(attribution.elementRenderDelay)),
    inputDelayMs: roundedNumber(numberOrUndefined(attribution.inputDelay)),
    loadState: stringOrUndefined(attribution.loadState),
    metricId: stringOrUndefined(metric.id),
    metricName,
    metricUnit,
    metricValue,
    navigationType: stringOrUndefined(metric.navigationType),
    presentationDelayMs: roundedNumber(numberOrUndefined(attribution.presentationDelay)),
    processingDurationMs: roundedNumber(numberOrUndefined(attribution.processingDuration)),
    resourceLoadDelayMs: roundedNumber(numberOrUndefined(attribution.resourceLoadDelay)),
    resourceLoadDurationMs: roundedNumber(numberOrUndefined(attribution.resourceLoadDuration)),
    timeToFirstByteMs: roundedNumber(numberOrUndefined(attribution.timeToFirstByte)),
    vitalPath,
    rating: stringOrUndefined(metric.rating)
  };
}

function webVitalTemplatePath(metric, metricName, webVitalPathTemplate) {
  if (typeof webVitalPathTemplate === "function") {
    return routeTemplatePath(webVitalPathTemplate({
      metric,
      metricName,
      name: metricName,
      path: metricPath(metric)
    }));
  }
  if (typeof webVitalPathTemplate === "string") {
    return routeTemplatePath(webVitalPathTemplate);
  }
  return metricPath(metric);
}

function metricPath(metric) {
  const url = stringOrUndefined(metric?.url) ?? stringOrUndefined(metric?.attribution?.url);
  return sanitizeSourcePath(url) ?? "/";
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

function safeObject(value) {
  return value && !Array.isArray(value) && typeof value === "object" ? value : {};
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

function metricUnitForName(metricName) {
  return MILLISECOND_METRICS.has(metricName) ? "millisecond" : "score";
}

function normalizeMetricName(metricName) {
  const normalized = stringOrUndefined(metricName)?.toUpperCase();
  if (!normalized || !/^[A-Z][A-Z0-9_]{0,31}$/u.test(normalized)) {
    throw new SdkError("configuration_error", "Web Vital metric name must be a short string such as LCP, CLS, INP, FCP, or TTFB");
  }
  return normalized;
}

function finiteNonNegativeNumber(label, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SdkError("configuration_error", `${label} must be a non-negative finite number`);
  }
  return value;
}

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function roundedMetricValue(metricName, value) {
  return metricName === "CLS" ? Number(value.toFixed(4)) : roundedNumber(value);
}

function roundedNumber(value) {
  return value === undefined ? undefined : Number(value.toFixed(3));
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

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function defaultWebVitalEventId({ message, path }) {
  return `evt_browser_web_vital_${slugify(`${path}_${message}`)}`;
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
  captureBrowserWebVital,
  createBrowserWebVitalEvent,
  installLogBrewBrowserWebVitalsInstrumentation
};
