"use strict";

const {
  assertBrowserContext,
  browserMetadata,
  browserPath,
  compactMetadata,
  defaultSanitizeMetadata,
  defaultWindow,
  finiteNonNegativeNumber,
  flushAfterCapture,
  mergeMetadata,
  nonNegativeNumberOrUndefined,
  optionsWithTraceContext,
  roundedNumber,
  routeTemplatePath,
  sanitizeSourcePath
} = require("./browser-events.cjs");
const {
  createAutomaticBrowserEventId,
  createBrowserTraceContext,
  optionalBrowserTraceContext,
  resolveTraceContext
} = require("./trace-context.cjs");
const { isList, isRecord, readField, stringOrUndefined } = require("./values.cjs");
const { SdkError } = require("@logbrew/sdk");

/**
 * @import { SpanAttributes, TransportResponse } from "@logbrew/sdk"
 * @import {
 *   BrowserWebVitalCallback,
 *   BrowserWebVitalInput,
 *   BrowserWebVitalPathTemplate,
 *   BrowserWebVitalsInstrumentation,
 *   BrowserWebVitalsModule,
 *   BrowserWebVitalsOptions,
 *   LogBrewBrowserContext,
 *   LogBrewBrowserEvent
 * } from "./index.cjs"
 * @typedef {{
 *   readonly delta: number | undefined,
 *   readonly durationMs: number | undefined,
 *   readonly elementRenderDelayMs: number | undefined,
 *   readonly inputDelayMs: number | undefined,
 *   readonly loadState: string | undefined,
 *   readonly metricId: string | undefined,
 *   readonly metricName: string,
 *   readonly metricUnit: "millisecond" | "score",
 *   readonly metricValue: number | undefined,
 *   readonly navigationType: string | undefined,
 *   readonly presentationDelayMs: number | undefined,
 *   readonly processingDurationMs: number | undefined,
 *   readonly rating: string | undefined,
 *   readonly resourceLoadDelayMs: number | undefined,
 *   readonly resourceLoadDurationMs: number | undefined,
 *   readonly timeToFirstByteMs: number | undefined,
 *   readonly vitalPath: string
 * }} WebVitalDetails
 * @typedef {(callback: BrowserWebVitalCallback) => unknown} WebVitalRegister
 * @typedef {{ installed: boolean }} WebVitalsState
 */

const DEFAULT_WEB_VITAL_METRICS = ["LCP", "CLS", "INP", "FCP", "TTFB"];
/** @type {ReadonlyMap<string, keyof BrowserWebVitalsModule>} */
const METRIC_CALLBACKS = new Map([
  ["CLS", "onCLS"],
  ["FCP", "onFCP"],
  ["FID", "onFID"],
  ["INP", "onINP"],
  ["LCP", "onLCP"],
  ["TTFB", "onTTFB"]
]);
const MILLISECOND_METRICS = new Set(["FCP", "FID", "INP", "LCP", "TTFB"]);
const METRIC_NAME = /^[A-Z][A-Z0-9_]{0,31}$/u;
const SCORE_DIGITS = 4;
const NO_CALLBACKS = 0;

/**
 * @returns {string}
 */
function currentTimestamp() {
  return new Date().toISOString();
}

/**
 * @param {{ readonly message?: string | undefined, readonly path: string }} context
 * @returns {string}
 */
function defaultWebVitalEventId({ message, path }) {
  return createAutomaticBrowserEventId("evt_browser_web_vital", `${path}_${message}`);
}

/**
 * @param {unknown} metricName
 * @returns {string}
 */
function normalizeMetricName(metricName) {
  const normalized = stringOrUndefined(metricName)?.toUpperCase();
  if (normalized === undefined || !METRIC_NAME.test(normalized)) {
    throw new SdkError("configuration_error", "Web Vital metric name must be a short string such as LCP, CLS, INP, FCP, or TTFB");
  }
  return normalized;
}

/**
 * @param {string} metricName
 * @returns {"millisecond" | "score"}
 */
function metricUnitForName(metricName) {
  return MILLISECOND_METRICS.has(metricName) ? "millisecond" : "score";
}

/**
 * @param {string} metricName
 * @param {number} value
 * @returns {number | undefined}
 */
function roundedMetricValue(metricName, value) {
  return metricName === "CLS" ? Number(value.toFixed(SCORE_DIGITS)) : roundedNumber(value);
}

/**
 * @param {unknown} metric
 * @returns {string}
 */
function metricPath(metric) {
  const url = stringOrUndefined(readField(metric, "url"))
    ?? stringOrUndefined(readField(readField(metric, "attribution"), "url"));
  return sanitizeSourcePath(url) ?? "/";
}

/**
 * @param {BrowserWebVitalInput} metric
 * @param {string} metricName
 * @param {BrowserWebVitalPathTemplate | undefined} webVitalPathTemplate
 * @returns {string}
 */
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

/**
 * @param {unknown} source
 * @param {string} key
 * @returns {number | undefined}
 */
function roundedField(source, key) {
  return roundedNumber(nonNegativeNumberOrUndefined(readField(source, key)));
}

/**
 * @param {BrowserWebVitalInput} metric
 * @param {BrowserWebVitalPathTemplate | undefined} webVitalPathTemplate
 * @returns {WebVitalDetails}
 */
function webVitalDetails(metric, webVitalPathTemplate) {
  if (!isRecord(metric)) {
    throw new SdkError("configuration_error", "createBrowserWebVitalEvent requires a Web Vital metric object");
  }
  const metricName = normalizeMetricName(readField(metric, "name"));
  const metricValue = roundedMetricValue(metricName, finiteNonNegativeNumber("Web Vital metric value", readField(metric, "value")));
  const metricUnit = metricUnitForName(metricName);
  const vitalPath = webVitalTemplatePath(metric, metricName, webVitalPathTemplate);
  const rawAttribution = readField(metric, "attribution");
  const attribution = isRecord(rawAttribution) ? rawAttribution : {};
  return {
    delta: roundedField(metric, "delta"),
    durationMs: metricUnit === "millisecond" ? metricValue : undefined,
    elementRenderDelayMs: roundedField(attribution, "elementRenderDelay"),
    inputDelayMs: roundedField(attribution, "inputDelay"),
    loadState: stringOrUndefined(readField(attribution, "loadState")),
    metricId: stringOrUndefined(readField(metric, "id")),
    metricName,
    metricUnit,
    metricValue,
    navigationType: stringOrUndefined(readField(metric, "navigationType")),
    presentationDelayMs: roundedField(attribution, "presentationDelay"),
    processingDurationMs: roundedField(attribution, "processingDuration"),
    resourceLoadDelayMs: roundedField(attribution, "resourceLoadDelay"),
    resourceLoadDurationMs: roundedField(attribution, "resourceLoadDuration"),
    timeToFirstByteMs: roundedField(attribution, "timeToFirstByte"),
    vitalPath,

    rating: stringOrUndefined(readField(metric, "rating"))
  };
}

/**
 * @param {BrowserWebVitalInput} metric
 * @param {Window} [browserWindow]
 * @param {BrowserWebVitalsOptions} [options]
 * @returns {LogBrewBrowserEvent<SpanAttributes>}
 */
function createBrowserWebVitalEvent(metric, browserWindow = defaultWindow(), {
  idFactory = defaultWebVitalEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = currentTimestamp,
  randomValues,
  sampled,
  sanitizeMetadata = defaultSanitizeMetadata,
  traceContext,
  traceFlags,
  webVitalPathTemplate
} = {}) {
  const { durationMs, ...details } = webVitalDetails(metric, webVitalPathTemplate);
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const parentTraceContext = optionalBrowserTraceContext(traceContext);
  const spanTraceContext = createBrowserTraceContext({
    randomValues,
    sampled: parentTraceContext?.sampled ?? sampled,
    traceFlags: parentTraceContext?.traceFlags ?? traceFlags,
    traceId: parentTraceContext?.traceId
  });
  const baseMetadata = browserMetadata(browserWindow, { includeDocumentTitle, includeUserAgent, path, source: "browser.web_vital" });
  const eventMetadata = mergeMetadata(mergeMetadata(baseMetadata, metadata), compactMetadata(details));
  const safeMetadata = sanitizeMetadata(eventMetadata, "web_vital");
  return {
    id: idFactory({ browserWindow, message: `${details.metricName} ${details.vitalPath}`, metric, path, source: "web_vital" }),
    timestamp: now(),

    attributes: {
      ...(durationMs === undefined ? {} : { durationMs }),
      metadata: safeMetadata,
      name: `browser.web_vital ${details.metricName} ${details.vitalPath}`,
      ...(parentTraceContext === undefined ? {} : { parentSpanId: parentTraceContext.spanId }),
      spanId: spanTraceContext.spanId,
      status: "ok",
      traceId: spanTraceContext.traceId
    }
  };
}

/**
 * @param {BrowserWebVitalInput} metric
 * @param {LogBrewBrowserContext} context
 * @param {BrowserWebVitalsOptions} [options]
 * @returns {Promise<TransportResponse | undefined>}
 */
async function captureBrowserWebVital(metric, context, options = {}) {
  assertBrowserContext(context, "captureBrowserWebVital");
  const eventOptions = optionsWithTraceContext(options, resolveTraceContext(context, options));
  const event = createBrowserWebVitalEvent(metric, context.browserWindow, eventOptions);

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

/**
 * @param {BrowserWebVitalsOptions} options
 * @returns {(metricName: string) => unknown}
 */
function webVitalRegistrations(options) {
  const source = options.webVitals ?? options;
  /** @type {Map<string, unknown>} */
  const registrations = new Map();
  for (const [metricName, callbackName] of METRIC_CALLBACKS) {
    registrations.set(metricName, readField(source, callbackName));
  }
  return (metricName) => registrations.get(metricName);
}

/**
 * @param {readonly string[] | undefined} metricNames
 * @returns {readonly string[]}
 */
function configuredMetricNames(metricNames) {
  if (metricNames === undefined) {
    return DEFAULT_WEB_VITAL_METRICS;
  }
  if (!isList(metricNames)) {
    throw new SdkError("configuration_error", "metricNames must be an array");
  }
  return metricNames.map((metricName) => normalizeMetricName(metricName));
}

/**
 * @param {unknown} value
 * @returns {value is WebVitalRegister}
 */
function isRegister(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is () => unknown}
 */
function isUnregister(value) {
  return typeof value === "function";
}

/**
 * @param {(metricName: string) => unknown} registration
 * @param {readonly string[]} metricNames
 * @param {BrowserWebVitalCallback} captureMetric
 * @returns {(() => unknown)[]}
 */
function registerMetrics(registration, metricNames, captureMetric) {
  /** @type {(() => unknown)[]} */
  const unregisters = [];
  for (const metricName of metricNames) {
    const register = registration(metricName);
    const unregister = isRegister(register) ? register(captureMetric) : undefined;
    if (isUnregister(unregister)) {
      unregisters.push(unregister);
    }
  }
  return unregisters;
}

/**
 * @param {WebVitalsState} state
 * @param {LogBrewBrowserContext} context
 * @param {BrowserWebVitalsOptions} options
 * @returns {BrowserWebVitalCallback}
 */
function metricCapture(state, context, options) {
  return (metric) => {
    if (state.installed) {
      void captureBrowserWebVital(metric, context, options);
    }
  };
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserWebVitalsOptions} [options]
 * @returns {BrowserWebVitalsInstrumentation}
 */
function installLogBrewBrowserWebVitalsInstrumentation(context, options = {}) {
  assertBrowserContext(context, "installLogBrewBrowserWebVitalsInstrumentation");
  const registration = webVitalRegistrations(options);
  const state = { installed: true };
  const metricNames = configuredMetricNames(options.metricNames);
  const unregisters = registerMetrics(registration, metricNames, metricCapture(state, context, options));
  if (unregisters.length === NO_CALLBACKS && !metricNames.some((metricName) => isRegister(registration(metricName)))) {
    throw new SdkError(
      "configuration_error",
      "installLogBrewBrowserWebVitalsInstrumentation requires web-vitals callbacks such as onLCP or options.webVitals"
    );
  }
  return {
    uninstall() {
      if (!state.installed) {
        return;
      }
      state.installed = false;
      for (const unregister of unregisters) {
        unregister();
      }
    }
  };
}

module.exports = {
  captureBrowserWebVital,
  createBrowserWebVitalEvent,
  installLogBrewBrowserWebVitalsInstrumentation
};
