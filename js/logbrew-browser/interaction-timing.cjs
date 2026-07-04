const { SdkError } = require("@logbrew/sdk");
const {
  createBrowserTraceContext,
  optionalBrowserTraceContext
} = require("./trace-context.cjs");

const DEFAULT_EVENT_DURATION_THRESHOLD_MS = 40;
const DEFAULT_MAX_DURATION_MS = 60_000;
const DEFAULT_OBSERVED_ENTRY_TYPES = ["event", "longtask"];
const DEFAULT_OBSERVED_ENTRY_TYPES_WITH_LONG_ANIMATION_FRAME = ["event", "long-animation-frame"];

async function captureBrowserInteractionTiming(entry, context, options = {}) {
  assertBrowserContext(context, "captureBrowserInteractionTiming");
  const event = createBrowserInteractionTimingEvent(entry, context.browserWindow, optionsWithTraceContext(
    options,
    resolveTraceContext(context, options)
  ));

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

function installLogBrewBrowserInteractionTimingInstrumentation(context, options = {}) {
  assertBrowserContext(context, "installLogBrewBrowserInteractionTimingInstrumentation");
  const browserWindow = options.browserWindow ?? context.browserWindow ?? defaultWindow();
  const PerformanceObserverConstructor = options.performanceObserver
    ?? browserWindow?.PerformanceObserver
    ?? globalThis.PerformanceObserver;
  if (typeof PerformanceObserverConstructor !== "function") {
    throw new SdkError(
      "configuration_error",
      "installLogBrewBrowserInteractionTimingInstrumentation requires PerformanceObserver"
    );
  }

  let installed = true;
  const isInstalled = () => installed;
  const observers = [];
  for (const entryType of observedEntryTypes(options, PerformanceObserverConstructor)) {
    const observer = createInteractionTimingObserver(
      PerformanceObserverConstructor,
      entryType,
      context,
      options,
      isInstalled
    );
    observeEntryType(observer, entryType, options);
    observers.push(observer);
  }

  return {
    uninstall() {
      if (!installed) {
        return;
      }
      installed = false;
      for (const observer of observers) {
        observer.disconnect?.();
      }
    }
  };
}

function createInteractionTimingObserver(PerformanceObserverConstructor, entryType, context, options, isInstalled) {
  return new PerformanceObserverConstructor((entryList) => {
    if (!isInstalled()) {
      return;
    }
    for (const entry of interactionTimingEntries(entryList)) {
      if (entry.entryType === entryType) {
        void captureBrowserInteractionTiming(entry, context, options);
      }
    }
  });
}

function createBrowserInteractionTimingEvent(entry, browserWindow = defaultWindow(), {
  idFactory = defaultInteractionTimingEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  interactionPathTemplate,
  maxDurationMs = DEFAULT_MAX_DURATION_MS,
  metadata,
  now = () => new Date().toISOString(),
  randomValues,
  sampled,
  sanitizeMetadata = defaultSanitizeMetadata,
  traceContext,
  traceFlags
} = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new SdkError("configuration_error", "createBrowserInteractionTimingEvent requires a performance timing entry");
  }
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const details = interactionTimingDetails(entry, interactionPathTemplate, maxDurationMs, path);
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
    source: "browser.interaction"
  });
  const timingMetadata = compactMetadata({
    blockingDurationMs: details.blockingDurationMs,
    entryType: details.entryType,
    firstUIEventTimestampMs: details.firstUIEventTimestampMs,
    inputDelayMs: details.inputDelayMs,
    interactionId: details.interactionId,
    interactionPath: details.interactionPath,
    interactionType: details.interactionType,
    presentationDelayMs: details.presentationDelayMs,
    processingDurationMs: details.processingDurationMs,
    renderStartMs: details.renderStartMs,
    scriptCount: details.scriptCount,
    scriptMaxDurationMs: details.scriptMaxDurationMs,
    scriptTotalDurationMs: details.scriptTotalDurationMs,
    scriptTotalForcedStyleAndLayoutDurationMs: details.scriptTotalForcedStyleAndLayoutDurationMs,
    scriptTotalPauseDurationMs: details.scriptTotalPauseDurationMs,
    startTimeMs: details.startTimeMs,
    styleAndLayoutStartMs: details.styleAndLayoutStartMs,
    taskName: details.taskName
  });
  const safeMetadata = sanitizeMetadata(
    mergeMetadata(mergeMetadata(baseMetadata, metadata), timingMetadata),
    "interaction"
  );
  return {
    id: idFactory({ browserWindow, entry, message: details.message, path, source: "interaction" }),
    timestamp: now(),
    attributes: {
      durationMs: details.durationMs,
      metadata: safeMetadata,
      name: details.name,
      parentSpanId: parentTraceContext?.spanId,
      spanId: spanTraceContext.spanId,
      status: "ok",
      traceId: spanTraceContext.traceId
    }
  };
}

function observeEntryType(observer, entryType, options) {
  const observedOptions = entryType === "event"
    ? {
        buffered: options.buffered !== false,
        durationThreshold: interactionDurationThreshold(options),
        type: entryType
      }
    : {
        buffered: options.buffered !== false,
        type: entryType
      };
  try {
    observer.observe(observedOptions);
  } catch {
    observer.observe({ entryTypes: [entryType] });
  }
}

function interactionTimingDetails(entry, interactionPathTemplate, maxDurationMs, path) {
  const entryType = timingEntryType(entry.entryType);
  const durationMs = roundedNumber(finiteNonNegativeNumber("performance timing duration", entry.duration));
  if (durationMs > validMaxDurationMs(maxDurationMs)) {
    throw new SdkError("configuration_error", "performance timing duration exceeds maxDurationMs");
  }
  const interactionPath = templatePath(entry, interactionPathTemplate, path);
  if (entryType === "event" || entryType === "first-input") {
    const interactionType = normalizeInteractionType(entry.name);
    return {
      durationMs,
      entryType,
      inputDelayMs: durationBetween(entry.startTime, entry.processingStart),
      interactionId: nonNegativeNumberOrUndefined(entry.interactionId),
      interactionPath,
      interactionType,
      message: `${interactionType} ${interactionPath}`,
      name: `browser.interaction ${interactionType} ${interactionPath}`,
      presentationDelayMs: durationBetween(entry.processingEnd, Number(entry.startTime) + Number(entry.duration)),
      processingDurationMs: durationBetween(entry.processingStart, entry.processingEnd),
      startTimeMs: roundedNumber(nonNegativeNumberOrUndefined(entry.startTime))
    };
  }
  if (entryType === "long-animation-frame") {
    const scriptSummary = longAnimationFrameScriptSummary(entry.scripts);
    return {
      ...scriptSummary,
      blockingDurationMs: roundedNumber(nonNegativeNumberOrUndefined(entry.blockingDuration)),
      durationMs,
      entryType,
      firstUIEventTimestampMs: roundedNumber(nonNegativeNumberOrUndefined(entry.firstUIEventTimestamp)),
      interactionPath,
      message: interactionPath,
      name: `browser.long_animation_frame ${interactionPath}`,
      renderStartMs: roundedNumber(nonNegativeNumberOrUndefined(entry.renderStart)),
      startTimeMs: roundedNumber(nonNegativeNumberOrUndefined(entry.startTime)),
      styleAndLayoutStartMs: roundedNumber(nonNegativeNumberOrUndefined(entry.styleAndLayoutStart))
    };
  }
  return {
    durationMs,
    entryType,
    interactionPath,
    message: interactionPath,
    name: `browser.long_task ${interactionPath}`,
    startTimeMs: roundedNumber(nonNegativeNumberOrUndefined(entry.startTime)),
    taskName: stringOrUndefined(entry.name)
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

function interactionTimingEntries(entryList) {
  if (!entryList || typeof entryList.getEntries !== "function") {
    return [];
  }
  return entryList.getEntries().filter((entry) => {
    const entryType = entry?.entryType;
    return entryType === "event"
      || entryType === "first-input"
      || entryType === "long-animation-frame"
      || entryType === "longtask";
  });
}

function observedEntryTypes(options, PerformanceObserverConstructor) {
  if (options.entryTypes === undefined) {
    return defaultObservedEntryTypes(PerformanceObserverConstructor);
  }
  if (!Array.isArray(options.entryTypes)) {
    throw new SdkError("configuration_error", "entryTypes must be an array");
  }
  const unique = [];
  for (const entryType of options.entryTypes) {
    const normalized = timingEntryType(entryType);
    if (!unique.includes(normalized)) {
      unique.push(normalized);
    }
  }
  return unique;
}

function defaultObservedEntryTypes(PerformanceObserverConstructor) {
  const supportedEntryTypes = PerformanceObserverConstructor?.supportedEntryTypes;
  if (Array.isArray(supportedEntryTypes) && supportedEntryTypes.includes("long-animation-frame")) {
    return DEFAULT_OBSERVED_ENTRY_TYPES_WITH_LONG_ANIMATION_FRAME;
  }
  return DEFAULT_OBSERVED_ENTRY_TYPES;
}

function interactionDurationThreshold(options) {
  const threshold = options.interactionDurationThresholdMs ?? DEFAULT_EVENT_DURATION_THRESHOLD_MS;
  return finiteNonNegativeNumber("interactionDurationThresholdMs", threshold);
}

function timingEntryType(entryType) {
  const normalized = stringOrUndefined(entryType);
  if (
    normalized === "event"
    || normalized === "first-input"
    || normalized === "long-animation-frame"
    || normalized === "longtask"
  ) {
    return normalized;
  }
  throw new SdkError(
    "configuration_error",
    "performance timing entryType must be event, first-input, long-animation-frame, or longtask"
  );
}

function longAnimationFrameScriptSummary(scripts) {
  if (!Array.isArray(scripts)) {
    return {
      scriptCount: 0
    };
  }
  const safeScripts = scripts.filter((script) => script && typeof script === "object" && !Array.isArray(script));
  return {
    scriptCount: safeScripts.length,
    scriptMaxDurationMs: maxScriptNumber(safeScripts, "duration"),
    scriptTotalDurationMs: sumScriptNumbers(safeScripts, "duration"),
    scriptTotalForcedStyleAndLayoutDurationMs: sumScriptNumbers(safeScripts, "forcedStyleAndLayoutDuration"),
    scriptTotalPauseDurationMs: sumScriptNumbers(safeScripts, "pauseDuration")
  };
}

function sumScriptNumbers(scripts, propertyName) {
  let total = 0;
  let found = false;
  for (const script of scripts) {
    const value = nonNegativeNumberOrUndefined(script[propertyName]);
    if (value !== undefined) {
      total += value;
      found = true;
    }
  }
  return found ? roundedNumber(total) : undefined;
}

function maxScriptNumber(scripts, propertyName) {
  let max;
  for (const script of scripts) {
    const value = nonNegativeNumberOrUndefined(script[propertyName]);
    if (value !== undefined && (max === undefined || value > max)) {
      max = value;
    }
  }
  return roundedNumber(max);
}

function templatePath(entry, interactionPathTemplate, path) {
  const currentPath = routeTemplatePath(path);
  if (typeof interactionPathTemplate === "function") {
    return routeTemplatePath(interactionPathTemplate({
      entry,
      entryType: entry.entryType,
      name: stringOrUndefined(entry.name),
      path: currentPath
    }));
  }
  if (typeof interactionPathTemplate === "string") {
    return routeTemplatePath(interactionPathTemplate);
  }
  return currentPath;
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

function normalizeInteractionType(name) {
  const normalized = stringOrUndefined(name)?.toLowerCase();
  if (!normalized || !/^[a-z][a-z0-9_.:-]{0,31}$/u.test(normalized)) {
    return "event";
  }
  return normalized;
}

function validMaxDurationMs(maxDurationMs) {
  return finiteNonNegativeNumber("maxDurationMs", maxDurationMs);
}

function finiteNonNegativeNumber(label, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SdkError("configuration_error", `${label} must be a non-negative finite number`);
  }
  return value;
}

function nonNegativeNumberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function durationBetween(start, end) {
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  const duration = end - start;
  return duration >= 0 ? roundedNumber(duration) : undefined;
}

function roundedNumber(value) {
  return value === undefined ? undefined : Number(value.toFixed(3));
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function defaultInteractionTimingEventId({ message, path }) {
  return `evt_browser_interaction_${slugify(`${path}_${message}`)}`;
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
  captureBrowserInteractionTiming,
  createBrowserInteractionTimingEvent,
  installLogBrewBrowserInteractionTimingInstrumentation
};
