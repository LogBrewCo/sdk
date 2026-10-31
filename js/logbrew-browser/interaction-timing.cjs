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
  optionsWithTraceContext
} = require("./browser-events.cjs");
const { callMethod, isList, isRecord, readField } = require("./values.cjs");
const {
  createAutomaticBrowserEventId,
  createBrowserTraceContext,
  optionalBrowserTraceContext,
  resolveTraceContext
} = require("./trace-context.cjs");
const { interactionTimingDetails, interactionToNextPaintDetails, timingEntryType } = require("./interaction-details.cjs");
const { SdkError } = require("@logbrew/sdk");

/**
 * @import { SpanAttributes, TransportResponse } from "@logbrew/sdk"
 * @import {
 *   BrowserInteractionTimingInput,
 *   BrowserInteractionTimingInstrumentation,
 *   BrowserInteractionTimingObserver,
 *   BrowserInteractionTimingObserverConstructor,
 *   BrowserInteractionTimingObserverEntryType,
 *   BrowserInteractionTimingOptions,
 *   BrowserInteractionToNextPaintOptions,
 *   BrowserTraceContext,
 *   LogBrewBrowserContext,
 *   LogBrewBrowserEvent
 * } from "./index.cjs"
 * @typedef {{
 *   readonly durationMs: number,
 *   readonly message: string,
 *   readonly metadata: Readonly<Record<string, unknown>>,
 *   readonly name: string
 * }} InteractionSpan
 * @typedef {{
 *   readonly browserWindow: Window | undefined,
 *   readonly idContext: { readonly entry: BrowserInteractionTimingInput, readonly message: string, readonly path: string },
 *   readonly options: BrowserInteractionToNextPaintOptions,
 *   readonly path: string,
 *   readonly source: string
 * }} InteractionEventInput
 * @typedef {{
 *   readonly context: LogBrewBrowserContext,
 *   readonly options: BrowserInteractionTimingOptions,
 *   readonly state: { installed: boolean }
 * }} InteractionObserverSetup
 */

const DEFAULT_EVENT_DURATION_THRESHOLD_MS = 40;
const DEFAULT_MAX_DURATION_MS = 60_000;
const DEFAULT_MAX_RANKED_INTERACTIONS = 10;
/** @type {readonly BrowserInteractionTimingObserverEntryType[]} */
const DEFAULT_OBSERVED_ENTRY_TYPES = ["event", "longtask"];
/** @type {readonly BrowserInteractionTimingObserverEntryType[]} */
const DEFAULT_OBSERVED_ENTRY_TYPES_WITH_LONG_ANIMATION_FRAME = ["event", "long-animation-frame"];
/** @type {ReadonlySet<unknown>} */
const OBSERVED_ENTRY_TYPES = new Set(["event", "first-input", "long-animation-frame", "longtask"]);

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
function defaultInteractionTimingEventId({ message, path }) {
  return createAutomaticBrowserEventId("evt_browser_interaction", `${path}_${message}`);
}

/**
 * @param {{ readonly message?: string | undefined, readonly path: string }} context
 * @returns {string}
 */
function defaultInteractionToNextPaintEventId({ message, path }) {
  return createAutomaticBrowserEventId("evt_browser_inp", `${path}_${message}`);
}

/**
 * @param {InteractionEventInput} input
 * @param {InteractionSpan} span
 * @returns {LogBrewBrowserEvent<SpanAttributes>}
 */
function interactionEvent({ browserWindow, idContext, options, path, source }, span) {
  const {
    idFactory = source === "interaction" ? defaultInteractionTimingEventId : defaultInteractionToNextPaintEventId,
    includeDocumentTitle = false,
    includeUserAgent = false,
    metadata,
    now = currentTimestamp,
    randomValues,
    sampled,
    sanitizeMetadata = defaultSanitizeMetadata,
    traceContext,
    traceFlags
  } = options;
  const parentTraceContext = optionalBrowserTraceContext(traceContext);
  const spanTraceContext = createBrowserTraceContext({
    randomValues,
    sampled: parentTraceContext?.sampled ?? sampled,
    traceFlags: parentTraceContext?.traceFlags ?? traceFlags,
    traceId: parentTraceContext?.traceId
  });
  const baseMetadata = browserMetadata(browserWindow, { includeDocumentTitle, includeUserAgent, path, source: `browser.${source}` });
  const safeMetadata = sanitizeMetadata(mergeMetadata(mergeMetadata(baseMetadata, metadata), compactMetadata(span.metadata)), "interaction");
  return {
    id: idFactory({ browserWindow, ...idContext, source }),
    timestamp: now(),

    attributes: {
      durationMs: span.durationMs,
      metadata: safeMetadata,
      name: span.name,
      ...(parentTraceContext === undefined ? {} : { parentSpanId: parentTraceContext.spanId }),
      spanId: spanTraceContext.spanId,
      status: "ok",
      traceId: spanTraceContext.traceId
    }
  };
}

/**
 * @param {readonly BrowserInteractionTimingInput[]} entries
 * @param {Window} [browserWindow]
 * @param {BrowserInteractionToNextPaintOptions} [options]
 * @returns {LogBrewBrowserEvent<SpanAttributes>}
 */
function createBrowserInteractionToNextPaintEvent(entries, browserWindow = defaultWindow(), options = {}) {
  const {
    includeHash = false,
    includeQueryString = false,
    interactionCount,
    interactionPathTemplate,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
    maxRankedInteractions = DEFAULT_MAX_RANKED_INTERACTIONS
  } = options;
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const settings = { interactionCount, interactionPathTemplate, maxDurationMs, maxRankedInteractions, path };
  const { durationMs, entry, message, name, ...metadata } = interactionToNextPaintDetails(entries, settings);
  return interactionEvent(
    { browserWindow, idContext: { entry, message, path }, options, path, source: "interaction_to_next_paint" },
    { durationMs, message, metadata, name }
  );
}

/**
 * @param {BrowserInteractionTimingInput} entry
 * @param {Window} [browserWindow]
 * @param {BrowserInteractionTimingOptions} [options]
 * @returns {LogBrewBrowserEvent<SpanAttributes>}
 */
function createBrowserInteractionTimingEvent(entry, browserWindow = defaultWindow(), options = {}) {
  const { includeHash = false, includeQueryString = false, interactionPathTemplate, maxDurationMs = DEFAULT_MAX_DURATION_MS } = options;
  if (!isRecord(entry)) {
    throw new SdkError("configuration_error", "createBrowserInteractionTimingEvent requires a performance timing entry");
  }
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const { durationMs, message, name, ...metadata } = interactionTimingDetails(entry, { interactionPathTemplate, maxDurationMs, path });
  return interactionEvent(
    { browserWindow, idContext: { entry, message, path }, options, path, source: "interaction" },
    { durationMs, message, metadata, name }
  );
}

/**
 * @template {BrowserInteractionTimingOptions} Options
 * @param {LogBrewBrowserContext} context
 * @param {Options} options
 * @returns {Options & { readonly traceContext: BrowserTraceContext | undefined }}
 */
function captureOptions(context, options) {
  return optionsWithTraceContext(options, resolveTraceContext(context, options));
}

/**
 * @param {BrowserInteractionTimingInput} entry
 * @param {LogBrewBrowserContext} context
 * @param {BrowserInteractionTimingOptions} [options]
 * @returns {Promise<TransportResponse | undefined>}
 */
async function captureBrowserInteractionTiming(entry, context, options = {}) {
  assertBrowserContext(context, "captureBrowserInteractionTiming");
  const event = createBrowserInteractionTimingEvent(entry, context.browserWindow, captureOptions(context, options));

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

/**
 * @param {readonly BrowserInteractionTimingInput[]} entries
 * @param {LogBrewBrowserContext} context
 * @param {BrowserInteractionToNextPaintOptions} [options]
 * @returns {Promise<TransportResponse | undefined>}
 */
async function captureBrowserInteractionToNextPaint(entries, context, options = {}) {
  assertBrowserContext(context, "captureBrowserInteractionToNextPaint");
  const event = createBrowserInteractionToNextPaintEvent(entries, context.browserWindow, captureOptions(context, options));

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

/**
 * @param {unknown} value
 * @returns {value is BrowserInteractionTimingInput[]}
 */
function isEntryList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} entryList
 * @returns {BrowserInteractionTimingInput[]}
 */
function interactionTimingEntries(entryList) {
  const hasEntryList = Boolean(entryList);
  if (!hasEntryList || typeof readField(entryList, "getEntries") !== "function") {
    return [];
  }
  const entries = callMethod(entryList, "getEntries", []);
  if (!isEntryList(entries)) {
    throw new TypeError("entryList.getEntries(...).filter is not a function");
  }
  return entries.filter((entry) => OBSERVED_ENTRY_TYPES.has(readField(entry, "entryType")));
}

/**
 * @param {unknown} PerformanceObserverConstructor
 * @returns {readonly BrowserInteractionTimingObserverEntryType[]}
 */
function defaultObservedEntryTypes(PerformanceObserverConstructor) {
  const supportedEntryTypes = readField(PerformanceObserverConstructor, "supportedEntryTypes");
  if (isList(supportedEntryTypes) && callMethod(supportedEntryTypes, "includes", ["long-animation-frame"]) === true) {
    return DEFAULT_OBSERVED_ENTRY_TYPES_WITH_LONG_ANIMATION_FRAME;
  }
  return DEFAULT_OBSERVED_ENTRY_TYPES;
}

/**
 * @param {BrowserInteractionTimingOptions} options
 * @param {unknown} PerformanceObserverConstructor
 * @returns {readonly BrowserInteractionTimingObserverEntryType[]}
 */
function observedEntryTypes(options, PerformanceObserverConstructor) {
  if (options.entryTypes === undefined) {
    return defaultObservedEntryTypes(PerformanceObserverConstructor);
  }
  if (!isList(options.entryTypes)) {
    throw new SdkError("configuration_error", "entryTypes must be an array");
  }
  /** @type {BrowserInteractionTimingObserverEntryType[]} */
  const unique = [];
  for (const entryType of options.entryTypes) {
    const normalized = timingEntryType(entryType);
    if (!unique.includes(normalized)) {
      unique.push(normalized);
    }
  }
  return unique;
}

/**
 * @param {BrowserInteractionTimingOptions} options
 * @returns {number}
 */
function interactionDurationThreshold(options) {
  const threshold = options.interactionDurationThresholdMs ?? DEFAULT_EVENT_DURATION_THRESHOLD_MS;
  return finiteNonNegativeNumber("interactionDurationThresholdMs", threshold);
}

/**
 * @param {BrowserInteractionTimingObserver} observer
 * @param {BrowserInteractionTimingObserverEntryType} entryType
 * @param {BrowserInteractionTimingOptions} options
 * @returns {void}
 */
function observeEntryType(observer, entryType, options) {
  const buffered = options.buffered !== false;
  /** @type {Parameters<BrowserInteractionTimingObserver["observe"]>[0]} */
  const observedOptions = entryType === "event"
    ? { buffered, durationThreshold: interactionDurationThreshold(options), type: entryType }
    : { buffered, type: entryType };
  try {
    observer.observe(observedOptions);
  } catch {
    observer.observe({ entryTypes: [entryType] });
  }
}

/**
 * @param {InteractionObserverSetup} setup
 * @param {string} entryType
 * @returns {(entryList: unknown) => void}
 */
function interactionEntryHandler({ context, options, state }, entryType) {
  return (entryList) => {
    if (!state.installed) {
      return;
    }
    for (const entry of interactionTimingEntries(entryList)) {
      if (readField(entry, "entryType") === entryType) {
        void captureBrowserInteractionTiming(entry, context, options);
      }
    }
  };
}

/**
 * @param {unknown} value
 * @returns {value is BrowserInteractionTimingObserverConstructor}
 */
function isObserverConstructor(value) {
  return typeof value === "function";
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserInteractionTimingOptions} options
 * @returns {BrowserInteractionTimingObserverConstructor}
 */
function interactionObserverConstructor(context, options) {
  const browserWindow = options.browserWindow ?? context.browserWindow ?? defaultWindow();
  const constructor = options.performanceObserver
    ?? readField(browserWindow, "PerformanceObserver")
    ?? readField(globalThis, "PerformanceObserver");
  if (!isObserverConstructor(constructor)) {
    throw new SdkError(
      "configuration_error",
      "installLogBrewBrowserInteractionTimingInstrumentation requires PerformanceObserver"
    );
  }
  return constructor;
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserInteractionTimingOptions} [options]
 * @returns {BrowserInteractionTimingInstrumentation}
 */
function installLogBrewBrowserInteractionTimingInstrumentation(context, options = {}) {
  assertBrowserContext(context, "installLogBrewBrowserInteractionTimingInstrumentation");
  const PerformanceObserverConstructor = interactionObserverConstructor(context, options);
  const setup = { context, options, state: { installed: true } };
  const observers = observedEntryTypes(options, PerformanceObserverConstructor).map((entryType) => {
    const observer = new PerformanceObserverConstructor(interactionEntryHandler(setup, entryType));
    observeEntryType(observer, entryType, options);
    return observer;
  });
  return {
    uninstall() {
      if (!setup.state.installed) {
        return;
      }
      setup.state.installed = false;
      for (const observer of observers) {
        callMethod(observer, "disconnect", []);
      }
    }
  };
}

module.exports = {
  captureBrowserInteractionTiming,
  captureBrowserInteractionToNextPaint,
  createBrowserInteractionTimingEvent,
  createBrowserInteractionToNextPaintEvent,
  installLogBrewBrowserInteractionTimingInstrumentation
};
