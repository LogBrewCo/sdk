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
  optionsWithTraceContext,
  roundDurationMs,
  routeTemplatePath,
  sanitizeSourcePath
} from "./browser-events.js";
import { callMethod, isRecord, readField, stringOrUndefined } from "./values.js";
import {
  createAutomaticBrowserEventId,
  createBrowserTraceContext,
  optionalBrowserTraceContext,
  resolveTraceContext
} from "./trace-context.js";
import { SdkError } from "@logbrew/sdk";

/**
 * @import { SpanAttributes, TransportResponse } from "@logbrew/sdk"
 * @import {
 *   BrowserNavigationPathTemplate,
 *   BrowserNavigationTimingInput,
 *   BrowserNavigationTimingInstrumentation,
 *   BrowserNavigationTimingOptions,
 *   LogBrewBrowserContext,
 *   LogBrewBrowserEvent
 * } from "./index.js"
 * @typedef {{
 *   readonly activationStartMs: number | undefined,
 *   readonly connectMs: number | undefined,
 *   readonly decodedBodySize: number | undefined,
 *   readonly documentPath: string,
 *   readonly domCompleteMs: number | undefined,
 *   readonly domContentLoadedEventMs: number | undefined,
 *   readonly domContentLoadedMs: number | undefined,
 *   readonly domInteractiveMs: number | undefined,
 *   readonly durationMs: number | undefined,
 *   readonly encodedBodySize: number | undefined,
 *   readonly fetchMs: number | undefined,
 *   readonly firstByteMs: number | undefined,
 *   readonly loadEventDurationMs: number | undefined,
 *   readonly loadEventMs: number | undefined,
 *   readonly lookupMs: number | undefined,
 *   readonly navigationType: string,
 *   readonly redirectCount: number | undefined,
 *   readonly redirectMs: number | undefined,
 *   readonly requestMs: number | undefined,
 *   readonly responseMs: number | undefined,
 *   readonly responseStatus: number | undefined,
 *   readonly status: "error" | "ok",
 *   readonly tlsMs: number | undefined,
 *   readonly transferSize: number | undefined,
 *   readonly workerMs: number | undefined
 * }} NavigationTimingDetails
 * @typedef {{
 *   readonly browserWindow: Window,
 *   readonly context: LogBrewBrowserContext,
 *   readonly options: BrowserNavigationTimingOptions
 * }} NavigationCaptureSetup
 * @typedef {{ captured: boolean }} NavigationCaptureState
 * @typedef {(callback: () => void, delay: number) => unknown} TimerFunction
 */

const ERROR_STATUS = 400;
const NO_STATUS = 0;
const NO_DELAY = 0;
const START_OF_NAVIGATION = 0;
const FIRST = 0;

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
function defaultNavigationTimingEventId({ message, path }) {
  return createAutomaticBrowserEventId("evt_browser_document", `${path}_${message}`);
}

/**
 * @param {unknown} entry
 * @returns {string}
 */
function navigationTypeOf(entry) {
  return stringOrUndefined(readField(entry, "type") ?? readField(entry, "navigationType")) ?? "navigate";
}

/**
 * @param {BrowserNavigationTimingInput} entry
 * @param {BrowserNavigationPathTemplate | undefined} navigationPathTemplate
 * @returns {string}
 */
function navigationTimingPath(entry, navigationPathTemplate) {
  const path = sanitizeSourcePath(readField(entry, "name")) ?? "/";
  if (typeof navigationPathTemplate === "function") {
    return routeTemplatePath(navigationPathTemplate({
      entry,
      navigationType: navigationTypeOf(entry),
      path
    }) ?? path);
  }
  if (typeof navigationPathTemplate === "string" && navigationPathTemplate.trim() !== "") {
    return routeTemplatePath(navigationPathTemplate);
  }
  return routeTemplatePath(path);
}

/**
 * @param {unknown} entry
 * @returns {number | undefined}
 */
function responseStatusCode(entry) {
  const statusCode = numberOrUndefined(readField(entry, "responseStatus") ?? readField(entry, "statusCode"));
  return statusCode === NO_STATUS ? undefined : statusCode;
}

/**
 * @param {unknown} value
 * @param {number} startTime
 * @returns {number | undefined}
 */
function durationSinceStart(value, startTime) {
  const endMs = nonNegativeNumberOrUndefined(value);
  if (endMs === undefined || endMs < startTime) {
    return undefined;
  }
  return roundDurationMs(endMs - startTime);
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function nonNegativeRoundedNumber(value) {
  const number = nonNegativeNumberOrUndefined(value);
  return number === undefined ? undefined : roundDurationMs(number);
}

/**
 * @param {unknown} entry
 * @param {number} startTime
 * @returns {number | undefined}
 */
function navigationDurationMs(entry, startTime) {
  return nonNegativeRoundedNumber(readField(entry, "duration"))
    ?? durationSinceStart(readField(entry, "loadEventEnd"), startTime)
    ?? durationSinceStart(readField(entry, "responseEnd"), startTime);
}

/**
 * @param {unknown} entry
 * @param {string} start
 * @param {string} end
 * @returns {number | undefined}
 */
function entryDuration(entry, start, end) {
  return durationBetween(readField(entry, start), readField(entry, end));
}

/**
 * @param {unknown} entry
 * @param {string} start
 * @param {string} end
 * @returns {number | undefined}
 */
function positiveStartDuration(entry, start, end) {
  return durationBetween(readField(entry, start), readField(entry, end), { requirePositiveStart: true });
}

/**
 * @param {BrowserNavigationTimingInput} entry
 * @param {BrowserNavigationPathTemplate | undefined} navigationPathTemplate
 * @returns {NavigationTimingDetails}
 */
function navigationTimingDetails(entry, navigationPathTemplate) {
  const documentPath = navigationTimingPath(entry, navigationPathTemplate);
  const responseStatus = responseStatusCode(entry);
  const startTime = nonNegativeNumberOrUndefined(readField(entry, "startTime")) ?? START_OF_NAVIGATION;
  return {
    activationStartMs: nonNegativeRoundedNumber(readField(entry, "activationStart")),
    connectMs: entryDuration(entry, "connectStart", "connectEnd"),
    decodedBodySize: nonNegativeNumberOrUndefined(readField(entry, "decodedBodySize")),
    documentPath,
    domCompleteMs: durationSinceStart(readField(entry, "domComplete"), startTime),
    domContentLoadedEventMs: entryDuration(entry, "domContentLoadedEventStart", "domContentLoadedEventEnd"),
    domContentLoadedMs: durationSinceStart(readField(entry, "domContentLoadedEventEnd"), startTime),
    domInteractiveMs: durationSinceStart(readField(entry, "domInteractive"), startTime),
    durationMs: navigationDurationMs(entry, startTime),
    encodedBodySize: nonNegativeNumberOrUndefined(readField(entry, "encodedBodySize")),
    fetchMs: entryDuration(entry, "fetchStart", "domainLookupStart"),
    firstByteMs: durationSinceStart(readField(entry, "responseStart"), startTime),
    loadEventDurationMs: entryDuration(entry, "loadEventStart", "loadEventEnd"),
    loadEventMs: durationSinceStart(readField(entry, "loadEventEnd"), startTime),
    lookupMs: entryDuration(entry, "domainLookupStart", "domainLookupEnd"),
    navigationType: navigationTypeOf(entry),
    redirectCount: nonNegativeNumberOrUndefined(readField(entry, "redirectCount")),
    redirectMs: entryDuration(entry, "redirectStart", "redirectEnd"),
    requestMs: entryDuration(entry, "requestStart", "responseStart"),
    responseMs: entryDuration(entry, "responseStart", "responseEnd"),
    responseStatus,
    status: responseStatus !== undefined && responseStatus >= ERROR_STATUS ? "error" : "ok",
    tlsMs: positiveStartDuration(entry, "secureConnectionStart", "connectEnd"),
    transferSize: nonNegativeNumberOrUndefined(readField(entry, "transferSize")),
    workerMs: positiveStartDuration(entry, "workerStart", "fetchStart")
  };
}

/**
 * @param {BrowserNavigationTimingInput} entry
 * @param {Window} [browserWindow]
 * @param {BrowserNavigationTimingOptions} [options]
 * @returns {LogBrewBrowserEvent<SpanAttributes>}
 */
function createBrowserNavigationTimingEvent(entry, browserWindow = defaultWindow(), {
  idFactory = defaultNavigationTimingEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  navigationPathTemplate,
  now = currentTimestamp,
  randomValues,
  sampled,
  sanitizeMetadata = defaultSanitizeMetadata,
  traceContext,
  traceFlags
} = {}) {
  if (!isRecord(entry)) {
    throw new SdkError("configuration_error", "createBrowserNavigationTimingEvent requires a navigation timing entry");
  }
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const { durationMs, status, ...details } = navigationTimingDetails(entry, navigationPathTemplate);
  const parentTraceContext = optionalBrowserTraceContext(traceContext);
  const spanTraceContext = createBrowserTraceContext({
    randomValues,
    sampled: parentTraceContext?.sampled ?? sampled,
    traceFlags: parentTraceContext?.traceFlags ?? traceFlags,
    traceId: parentTraceContext?.traceId
  });
  const baseMetadata = browserMetadata(browserWindow, { includeDocumentTitle, includeUserAgent, path, source: "browser.document" });
  const eventMetadata = mergeMetadata(mergeMetadata(baseMetadata, metadata), compactMetadata(details));
  const safeMetadata = sanitizeMetadata(eventMetadata, "document");
  return {
    id: idFactory({ browserWindow, message: details.documentPath, path, source: "document" }),
    timestamp: now(),

    attributes: {
      ...(durationMs === undefined ? {} : { durationMs }),
      metadata: safeMetadata,
      name: `browser.document ${details.documentPath}`,
      ...(parentTraceContext === undefined ? {} : { parentSpanId: parentTraceContext.spanId }),
      spanId: spanTraceContext.spanId,
      status,
      traceId: spanTraceContext.traceId
    }
  };
}

/**
 * @param {BrowserNavigationTimingInput} entry
 * @param {LogBrewBrowserContext} context
 * @param {BrowserNavigationTimingOptions} [options]
 * @returns {Promise<TransportResponse | undefined>}
 */
async function captureBrowserNavigationTiming(entry, context, options = {}) {
  assertBrowserContext(context, "captureBrowserNavigationTiming");
  const eventOptions = optionsWithTraceContext(options, resolveTraceContext(context, options));
  const event = createBrowserNavigationTimingEvent(entry, context.browserWindow, eventOptions);

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

/**
 * @param {unknown} value
 * @returns {value is TimerFunction}
 */
function isTimer(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} target
 * @returns {unknown}
 */
function boundSetTimeout(target) {
  const timer = readField(target, "setTimeout");
  return timer === undefined || timer === null ? undefined : callMethod(timer, "bind", [target]);
}

/**
 * @param {Window} browserWindow
 * @param {BrowserNavigationTimingOptions} options
 * @param {() => void} capture
 * @returns {void}
 */
function scheduleAfterLoad(browserWindow, options, capture) {
  if (options.deferAfterLoad === false) {
    capture();
    return;
  }
  const setTimeoutImpl = options.setTimeout ?? boundSetTimeout(browserWindow) ?? boundSetTimeout(globalThis);
  if (isTimer(setTimeoutImpl)) {
    setTimeoutImpl(capture, NO_DELAY);
  } else {
    capture();
  }
}

/**
 * @param {unknown} value
 * @returns {value is BrowserNavigationTimingInput}
 */
function isNavigationEntry(value) {
  const present = Boolean(value);
  return present;
}

/**
 * @param {Window} browserWindow
 * @returns {unknown}
 */
function navigationTimingEntry(browserWindow) {
  const entries = callMethod(readField(browserWindow, "performance"), "getEntriesByType", ["navigation"]);
  return readField(entries, FIRST);
}

/**
 * @param {NavigationCaptureSetup} setup
 * @returns {void}
 */
function captureInitialEntry({ browserWindow, context, options }) {
  const entry = options.entry ?? navigationTimingEntry(browserWindow);
  if (isNavigationEntry(entry)) {
    void captureBrowserNavigationTiming(entry, context, options);
  }
}

/**
 * @param {NavigationCaptureState} state
 * @param {NavigationCaptureSetup} setup
 * @returns {void}
 */
function captureOnce(state, setup) {
  if (state.captured) {
    return;
  }
  state.captured = true;
  scheduleAfterLoad(setup.browserWindow, setup.options, () => {
    captureInitialEntry(setup);
  });
}

/**
 * @param {NavigationCaptureState} state
 * @param {NavigationCaptureSetup} setup
 * @returns {() => void}
 */
function loadListener(state, setup) {
  return () => {
    captureOnce(state, setup);
  };
}

/**
 * @param {NavigationCaptureState} state
 * @param {NavigationCaptureSetup} setup
 * @param {() => void} onLoad
 * @returns {void}
 */
function startCapture(state, setup, onLoad) {
  if (readField(readField(setup.browserWindow, "document"), "readyState") === "complete") {
    captureOnce(state, setup);
  } else if (typeof readField(setup.browserWindow, "addEventListener") === "function") {
    setup.browserWindow.addEventListener("load", onLoad);
  } else {
    captureOnce(state, setup);
  }
}

/**
 * @param {Window | undefined} value
 * @returns {value is Window}
 */
function isBrowserWindow(value) {
  const present = Boolean(value);
  return present;
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserNavigationTimingOptions} options
 * @returns {Window}
 */
function navigationWindow(context, options) {
  const browserWindow = options.browserWindow ?? context.browserWindow ?? defaultWindow();
  if (!isBrowserWindow(browserWindow)) {
    throw new SdkError(
      "configuration_error",
      "installLogBrewBrowserNavigationTimingInstrumentation requires a browser window"
    );
  }
  return browserWindow;
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {BrowserNavigationTimingOptions} [options]
 * @returns {BrowserNavigationTimingInstrumentation}
 */
function installLogBrewBrowserNavigationTimingInstrumentation(context, options = {}) {
  assertBrowserContext(context, "installLogBrewBrowserNavigationTimingInstrumentation");
  const setup = { browserWindow: navigationWindow(context, options), context, options };
  const state = { captured: false };
  const onLoad = loadListener(state, setup);
  if (options.captureInitial === false) {
    return {
      uninstall() {
        return undefined;
      }
    };
  }
  startCapture(state, setup, onLoad);
  return {
    uninstall() {
      callMethod(setup.browserWindow, "removeEventListener", ["load", onLoad]);
    }
  };
}

export {
  captureBrowserNavigationTiming,
  createBrowserNavigationTimingEvent,
  installLogBrewBrowserNavigationTimingInstrumentation
};
