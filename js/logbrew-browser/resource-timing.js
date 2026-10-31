import {
  assertBrowserContext,
  browserMetadata,
  browserPath,
  compactMetadata,
  defaultSanitizeMetadata,
  defaultWindow,
  durationBetween,
  flushAfterCapture,
  mergeMetadata,
  nonNegativeNumberOrUndefined,
  numberOrUndefined,
  routeTemplatePath,
  sanitizeSourcePath
} from "./browser-events.js";
import { callMethod, isRecord, readField, stringOrUndefined } from "./values.js";
import { createAutomaticBrowserEventId, createBrowserTraceContext, optionalBrowserTraceContext } from "./trace-context.js";
import { SdkError } from "@logbrew/sdk";

/**
 * @import { SpanAttributes, TransportResponse } from "@logbrew/sdk"
 * @import {
 *   BrowserResourcePathTemplate,
 *   BrowserResourceTimingInput,
 *   BrowserResourceTimingInstrumentation,
 *   BrowserResourceTimingObserverConstructor,
 *   BrowserResourceTimingOptions,
 *   LogBrewBrowserContext,
 *   LogBrewBrowserEvent
 * } from "./index.js"
 * @typedef {{
 *   readonly connectMs: number | undefined,
 *   readonly decodedBodySize: number | undefined,
 *   readonly deliveryType: string | undefined,
 *   readonly durationMs: number | undefined,
 *   readonly encodedBodySize: number | undefined,
 *   readonly initiatorType: string,
 *   readonly lookupMs: number | undefined,
 *   readonly redirectMs: number | undefined,
 *   readonly requestMs: number | undefined,
 *   readonly resourcePath: string,
 *   readonly responseMs: number | undefined,
 *   readonly status: "error" | "ok",
 *   readonly statusCode: number | undefined,
 *   readonly tlsMs: number | undefined,
 *   readonly transferSize: number | undefined,
 *   readonly workerMs: number | undefined
 * }} ResourceTimingDetails
 */

const ERROR_STATUS = 400;
const NO_STATUS = 0;

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
function defaultResourceTimingEventId({ message, path }) {
  return createAutomaticBrowserEventId("evt_browser_resource", `${path}_${message}`);
}

/**
 * @param {BrowserResourceTimingInput} entry
 * @returns {string}
 */
function resourceInitiatorType(entry) {
  return stringOrUndefined(readField(entry, "initiatorType")) ?? "resource";
}

/**
 * @param {BrowserResourceTimingInput} entry
 * @param {BrowserResourcePathTemplate | undefined} resourcePathTemplate
 * @returns {string}
 */
function resourceTimingPath(entry, resourcePathTemplate) {
  const path = sanitizeSourcePath(readField(entry, "name")) ?? "/";
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

/**
 * @param {BrowserResourceTimingInput} entry
 * @returns {number | undefined}
 */
function resourceStatusCode(entry) {
  const statusCode = numberOrUndefined(readField(entry, "responseStatus") ?? readField(entry, "statusCode"));
  return statusCode === NO_STATUS ? undefined : statusCode;
}

/**
 * @param {BrowserResourceTimingInput} entry
 * @returns {number | undefined}
 */
function resourceDurationMs(entry) {
  return nonNegativeNumberOrUndefined(readField(entry, "duration"))
    ?? durationBetween(readField(entry, "startTime"), readField(entry, "responseEnd"));
}

/**
 * @param {BrowserResourceTimingInput} entry
 * @param {BrowserResourcePathTemplate | undefined} resourcePathTemplate
 * @returns {ResourceTimingDetails}
 */
function resourceTimingDetails(entry, resourcePathTemplate) {
  const resourcePath = resourceTimingPath(entry, resourcePathTemplate);
  const statusCode = resourceStatusCode(entry);
  return {
    connectMs: durationBetween(readField(entry, "connectStart"), readField(entry, "connectEnd")),
    decodedBodySize: nonNegativeNumberOrUndefined(readField(entry, "decodedBodySize")),
    deliveryType: stringOrUndefined(readField(entry, "deliveryType")),
    durationMs: resourceDurationMs(entry),
    encodedBodySize: nonNegativeNumberOrUndefined(readField(entry, "encodedBodySize")),
    initiatorType: resourceInitiatorType(entry),
    lookupMs: durationBetween(readField(entry, "domainLookupStart"), readField(entry, "domainLookupEnd")),
    redirectMs: durationBetween(readField(entry, "redirectStart"), readField(entry, "redirectEnd")),
    requestMs: durationBetween(readField(entry, "requestStart"), readField(entry, "responseStart")),
    resourcePath,
    responseMs: durationBetween(readField(entry, "responseStart"), readField(entry, "responseEnd")),
    status: statusCode !== undefined && statusCode >= ERROR_STATUS ? "error" : "ok",
    statusCode,
    tlsMs: durationBetween(readField(entry, "secureConnectionStart"), readField(entry, "connectEnd"), { requirePositiveStart: true }),
    transferSize: nonNegativeNumberOrUndefined(readField(entry, "transferSize")),
    workerMs: durationBetween(readField(entry, "workerStart"), readField(entry, "fetchStart"), { requirePositiveStart: true })
  };
}

/**
 * @param {BrowserResourceTimingInput} entry
 * @param {Window} [browserWindow]
 * @param {BrowserResourceTimingOptions} [options]
 * @returns {LogBrewBrowserEvent<SpanAttributes>}
 */
function createBrowserResourceTimingEvent(entry, browserWindow = defaultWindow(), {
  idFactory = defaultResourceTimingEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = currentTimestamp,
  randomValues,
  resourcePathTemplate,
  sampled,
  sanitizeMetadata = defaultSanitizeMetadata,
  traceContext,
  traceFlags
} = {}) {
  if (!isRecord(entry)) {
    throw new SdkError("configuration_error", "createBrowserResourceTimingEvent requires a resource timing entry");
  }
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const { durationMs, status, ...details } = resourceTimingDetails(entry, resourcePathTemplate);
  const parentTraceContext = optionalBrowserTraceContext(traceContext);
  const spanTraceContext = createBrowserTraceContext({
    randomValues,
    sampled: parentTraceContext?.sampled ?? sampled,
    traceFlags: parentTraceContext?.traceFlags ?? traceFlags,
    traceId: parentTraceContext?.traceId
  });
  const baseMetadata = browserMetadata(browserWindow, { includeDocumentTitle, includeUserAgent, path, source: "browser.resource" });
  const eventMetadata = mergeMetadata(mergeMetadata(baseMetadata, metadata), compactMetadata(details));
  const safeMetadata = sanitizeMetadata(eventMetadata, "resource");
  return {
    id: idFactory({ browserWindow, message: `${details.initiatorType} ${details.resourcePath}`, path, source: "resource" }),
    timestamp: now(),

    attributes: {
      ...(durationMs === undefined ? {} : { durationMs }),
      metadata: safeMetadata,
      name: `browser.resource ${details.initiatorType} ${details.resourcePath}`,
      ...(parentTraceContext === undefined ? {} : { parentSpanId: parentTraceContext.spanId }),
      spanId: spanTraceContext.spanId,
      status,
      traceId: spanTraceContext.traceId
    }
  };
}

/**
 * @param {BrowserResourceTimingInput} entry
 * @param {LogBrewBrowserContext} context
 * @param {BrowserResourceTimingOptions} [options]
 * @returns {Promise<TransportResponse | undefined>}
 */
async function captureBrowserResourceTiming(entry, context, options = {}) {
  const eventOptions = options.traceContext !== undefined || context.traceContext === undefined
    ? options
    : { ...options, traceContext: context.traceContext };
  const event = createBrowserResourceTimingEvent(entry, context.browserWindow, eventOptions);

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

/**
 * @param {unknown} value
 * @returns {value is BrowserResourceTimingInput}
 */
function isResourceEntry(value) {
  return readField(value, "entryType") === "resource";
}

/**
 * @param {unknown} value
 * @returns {value is ArrayLike<unknown> | Iterable<unknown>}
 */
function isArraySource(value) {
  return value !== null && value !== undefined;
}

/**
 * @param {unknown} entryList
 * @returns {BrowserResourceTimingInput[]}
 */
function resourceEntries(entryList) {
  /** @type {unknown} */
  const entries = typeof readField(entryList, "getEntries") === "function" ? callMethod(entryList, "getEntries", []) : [];
  if (!isArraySource(entries)) {
    throw new TypeError(`${entries === null ? "object null" : "undefined"} is not iterable (cannot read property Symbol(Symbol.iterator))`);
  }
  return Array.from(entries, (entry) => entry).filter((entry) => isResourceEntry(entry));
}

/**
 * @param {unknown} value
 * @returns {value is BrowserResourceTimingObserverConstructor}
 */
function isObserverConstructor(value) {
  return typeof value === "function";
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserResourceTimingOptions} options
 * @returns {BrowserResourceTimingObserverConstructor}
 */
function resourceObserverConstructor(context, options) {
  const browserWindow = options.browserWindow ?? context.browserWindow ?? defaultWindow();
  const constructor = options.performanceObserver
    ?? readField(browserWindow, "PerformanceObserver")
    ?? readField(globalThis, "PerformanceObserver");
  if (!isObserverConstructor(constructor)) {
    throw new SdkError(
      "configuration_error",
      "installLogBrewBrowserResourceTimingInstrumentation requires PerformanceObserver"
    );
  }
  return constructor;
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserResourceTimingOptions} options
 * @returns {(entryList: unknown) => void}
 */
function resourceEntryHandler(context, options) {
  return (entryList) => {
    for (const entry of resourceEntries(entryList)) {
      void captureBrowserResourceTiming(entry, context, options);
    }
  };
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserResourceTimingOptions} [options]
 * @returns {BrowserResourceTimingInstrumentation}
 */
function installLogBrewBrowserResourceTimingInstrumentation(context, options = {}) {
  assertBrowserContext(context, "installLogBrewBrowserResourceTimingInstrumentation");
  const PerformanceObserverConstructor = resourceObserverConstructor(context, options);
  const observer = new PerformanceObserverConstructor(resourceEntryHandler(context, options));
  try {
    observer.observe({ buffered: options.buffered !== false, type: "resource" });
  } catch {
    observer.observe({ entryTypes: ["resource"] });
  }
  return {
    uninstall() {
      callMethod(observer, "disconnect", []);
    }
  };
}

export {
  captureBrowserResourceTiming,
  createBrowserResourceTimingEvent,
  installLogBrewBrowserResourceTimingInstrumentation
};
