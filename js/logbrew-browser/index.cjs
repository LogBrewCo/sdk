"use strict";

const {
  LogBrewClient,
  RecordingTransport,
  SdkError,
  TransportError,
  createIssueAttributesFromError
} = require("@logbrew/sdk");
const { createBeaconTransport } = require("./beacon-transport.cjs");
const {
  captureBrowserFetchSpan,
  createBrowserFetchSpanEvent,
  createLogBrewBrowserFetch,
  installLogBrewBrowserFetchInstrumentation
} = require("./fetch-spans.cjs");
const {
  captureBrowserInteractionTiming,
  captureBrowserInteractionToNextPaint,
  createBrowserInteractionTimingEvent,
  createBrowserInteractionToNextPaintEvent,
  installLogBrewBrowserInteractionTimingInstrumentation
} = require("./interaction-timing.cjs");
const {
  captureBrowserNavigationTiming,
  createBrowserNavigationTimingEvent,
  installLogBrewBrowserNavigationTimingInstrumentation
} = require("./navigation-timing.cjs");
const { createPersistentBrowserTransport } = require("./persistence.cjs");
const {
  captureBrowserResourceTiming,
  createBrowserResourceTimingEvent,
  installLogBrewBrowserResourceTimingInstrumentation
} = require("./resource-timing.cjs");
const {
  browserTraceMetadata,
  createBrowserTraceContext,
  createBrowserTraceparent,
  createTraceparentFetch,
  optionalBrowserTraceContext,
  shouldPropagateTraceparent
} = require("./trace-context.cjs");
const {
  captureBrowserWebVital,
  createBrowserWebVitalEvent,
  installLogBrewBrowserWebVitalsInstrumentation
} = require("./web-vitals.cjs");
const {
  captureBrowserXhrSpan,
  createBrowserXhrSpanEvent,
  installLogBrewBrowserXhrInstrumentation
} = require("./xhr-spans.cjs");

const DEFAULT_SDK_NAME = "logbrew-browser";
const DEFAULT_SDK_VERSION = "0.1.0";
const DEFAULT_ENDPOINT = "https://api.logbrew.co/v1/events";
const DEFAULT_MAX_KEEPALIVE_BODY_BYTES = 64 * 1024;

function createLogBrewBrowserClient({
  apiKey,
  clientKey,
  maxQueueSize,
  sdkName = DEFAULT_SDK_NAME,
  sdkVersion = DEFAULT_SDK_VERSION,
  maxRetries = 2,
  onEventDropped
} = {}) {
  const authKey = clientKey ?? apiKey;
  if (!authKey) {
    throw new SdkError("configuration_error", "createLogBrewBrowserClient requires clientKey or apiKey");
  }
  return LogBrewClient.create({ apiKey: authKey, maxQueueSize, maxRetries, onEventDropped, sdkName, sdkVersion });
}

function createFetchTransport({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = defaultFetch(),
  headers = {},
  keepalive = true,
  maxKeepaliveBodyBytes = DEFAULT_MAX_KEEPALIVE_BODY_BYTES
} = {}) {
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new SdkError("configuration_error", "createFetchTransport requires a non-empty endpoint");
  }
  if (typeof fetchImpl !== "function") {
    throw new SdkError("configuration_error", "createFetchTransport requires fetch");
  }
  validateKeepaliveBodyLimit(maxKeepaliveBodyBytes);

  return {
    async send(apiKey, body) {
      if (keepalive && utf8ByteLength(body) > maxKeepaliveBodyBytes) {
        throw new TransportError(
          "keepalive_body_too_large",
          `keepalive request body exceeds maxKeepaliveBodyBytes (${maxKeepaliveBodyBytes})`,
          false
        );
      }
      try {
        const response = await fetchImpl(endpoint, {
          body,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...headers
          },
          keepalive,
          method: "POST"
        });
        const retryAfterMs = retryAfterMsFromHeaders(response.headers);
        return retryAfterMs === undefined
          ? { statusCode: response.status, attempts: 1 }
          : { statusCode: response.status, attempts: 1, retryAfterMs };
      } catch (error) {
        throw TransportError.network(`fetch failed: ${errorMessage(error)}`);
      }
    }
  };
}

function installLogBrewBrowser(options = {}) {
  const browserWindow = options.browserWindow ?? defaultWindow();
  if (!browserWindow || typeof browserWindow.addEventListener !== "function") {
    throw new SdkError("configuration_error", "installLogBrewBrowser requires a browser window");
  }

  const client = options.client ?? createLogBrewBrowserClient(options);
  const transport = createBrowserTransport(options, browserWindow);
  const traceContext = resolveBrowserTraceContext(options);
  let installed = true;
  const context = createLogBrewBrowserContext(client, transport, browserWindow, () => {
    if (!installed) {
      return;
    }
    installed = false;
    removeListeners(browserWindow, listeners);
  }, traceContext);

  const listeners = {
    error: (event) => {
      void captureBrowserError(event, context, options);
    },
    pagehide: () => {
      void flushForLifecycle(context, options, "pagehide");
    },
    online: () => {
      void replayStoredBatchesThenFlush(context, options);
    },
    rejection: (event) => {
      void captureUnhandledRejection(event, context, options);
    },
    visibilitychange: () => {
      if (browserWindow.document?.visibilityState === "hidden") {
        void flushForLifecycle(context, options, "visibility_hidden");
      }
    }
  };

  if (options.captureGlobalErrors !== false) {
    browserWindow.addEventListener("error", listeners.error);
  }
  if (options.captureUnhandledRejections !== false) {
    browserWindow.addEventListener("unhandledrejection", listeners.rejection);
  }
  if (options.flushOnPageHide !== false) {
    browserWindow.addEventListener("pagehide", listeners.pagehide);
  }
  if (options.flushOnOnline !== false) {
    browserWindow.addEventListener("online", listeners.online);
  }
  if (options.flushOnVisibilityHidden !== false && typeof browserWindow.document?.addEventListener === "function") {
    browserWindow.document.addEventListener("visibilitychange", listeners.visibilitychange);
  }
  if (options.replayPersistedOnInstall !== false) {
    void replayStoredBrowserBatches(context);
  }
  if (options.capturePageViews !== false) {
    void capturePageView(context, options);
  }

  return context;
}

function installLogBrewBrowserNavigationInstrumentation(context, options = {}) {
  if (!context || typeof context !== "object" || !context.client) {
    throw new SdkError("configuration_error", "installLogBrewBrowserNavigationInstrumentation requires a browser context");
  }
  const browserWindow = options.browserWindow ?? context.browserWindow ?? defaultWindow();
  if (!browserWindow || typeof browserWindow.addEventListener !== "function") {
    throw new SdkError("configuration_error", "installLogBrewBrowserNavigationInstrumentation requires a browser window");
  }

  const includeHash = options.includeHash === true;
  const includeQueryString = options.includeQueryString === true;
  let currentPath = browserPath(browserWindow, { includeHash, includeQueryString });
  let installed = true;
  const history = browserWindow.history;
  const originalPushState = typeof history?.pushState === "function" ? history.pushState : undefined;
  const originalReplaceState = typeof history?.replaceState === "function" ? history.replaceState : undefined;
  let wrappedPushState;
  let wrappedReplaceState;
  const updateCurrentPath = (nextPath) => {
    currentPath = nextPath;
  };
  const popstate = () => {
    captureNavigationPageView(context, browserWindow, currentPath, "popstate", options, updateCurrentPath);
  };

  if (options.captureInitial === true) {
    captureNavigationPageView(context, browserWindow, undefined, "initial", options, updateCurrentPath);
  }

  if (originalPushState) {
    wrappedPushState = function logbrewPushState(...args) {
      const result = Reflect.apply(originalPushState, history, args);
      captureNavigationPageView(context, browserWindow, currentPath, "pushState", options, updateCurrentPath);
      return result;
    };
    history.pushState = wrappedPushState;
  }

  if (originalReplaceState) {
    wrappedReplaceState = function logbrewReplaceState(...args) {
      const result = Reflect.apply(originalReplaceState, history, args);
      captureNavigationPageView(context, browserWindow, currentPath, "replaceState", options, updateCurrentPath);
      return result;
    };
    history.replaceState = wrappedReplaceState;
  }

  browserWindow.addEventListener("popstate", popstate);

  return {
    uninstall() {
      if (!installed) {
        return;
      }
      installed = false;
      browserWindow.removeEventListener?.("popstate", popstate);
      if (wrappedPushState && history.pushState === wrappedPushState) {
        history.pushState = originalPushState;
      }
      if (wrappedReplaceState && history.replaceState === wrappedReplaceState) {
        history.replaceState = originalReplaceState;
      }
    }
  };
}

function createLogBrewBrowserContext(
  client,
  transport,
  browserWindow = defaultWindow(),
  uninstall = () => undefined,
  traceContext
) {
  return {
    browserWindow,
    client,
    flush: () => client.flush(transport),
    logbrew: client,
    previewJson: () => client.previewJson(),
    replayStoredBatches: () => replayStoredBrowserBatches({ client, transport }),
    shutdown: () => client.shutdown(transport),
    traceContext: optionalBrowserTraceContext(traceContext),
    transport,
    uninstall
  };
}

async function capturePageView(context, options = {}) {
  const eventOptions = eventOptionsWithContext(context, options);
  const event = typeof options.pageViewEvent === "function"
    ? options.pageViewEvent(eventCallbackContext(context))
    : createPageViewEvent(context.browserWindow, eventOptions);

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

async function captureBrowserError(error, context, options = {}) {
  const eventOptions = eventOptionsWithContext(context, options);
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, eventCallbackContext(context))
    : createBrowserErrorEvent(error, context.browserWindow, eventOptions);
  const suppression = await suppressBrowserIssue(event, context, eventOptions);
  if (suppression) {
    maybePreventDefault(error, options);
    return suppression;
  }

  context.client.issue(event.id, event.timestamp, event.attributes);
  maybePreventDefault(error, options);
  return flushAfterCapture(context, options);
}

async function captureUnhandledRejection(rejection, context, options = {}) {
  const eventOptions = eventOptionsWithContext(context, options);
  const event = typeof options.rejectionEvent === "function"
    ? options.rejectionEvent(rejection, eventCallbackContext(context))
    : createUnhandledRejectionEvent(rejection, context.browserWindow, eventOptions);
  const suppression = await suppressBrowserIssue(event, context, eventOptions);
  if (suppression) {
    maybePreventDefault(rejection, options);
    return suppression;
  }

  context.client.issue(event.id, event.timestamp, event.attributes);
  maybePreventDefault(rejection, options);
  return flushAfterCapture(context, options);
}

async function captureBrowserAction(action, context, options = {}) {
  const eventOptions = eventOptionsWithContext(context, options);
  const event = typeof options.actionEvent === "function"
    ? options.actionEvent(action, eventCallbackContext(context))
    : createBrowserActionEvent(action, context.browserWindow, eventOptions);

  context.client.action(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

async function captureBrowserNetwork(request, context, options = {}) {
  const eventOptions = eventOptionsWithContext(context, options);
  const event = typeof options.networkEvent === "function"
    ? options.networkEvent(request, eventCallbackContext(context))
    : createBrowserNetworkEvent(request, context.browserWindow, eventOptions);

  context.client.action(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

function captureNavigationPageView(context, browserWindow, previousPath, navigationType, options, updateCurrentPath) {
  const includeHash = options.includeHash === true;
  const includeQueryString = options.includeQueryString === true;
  const nextPath = browserPath(browserWindow, { includeHash, includeQueryString });
  if (previousPath !== undefined && nextPath === previousPath) {
    return;
  }

  updateCurrentPath(nextPath);
  context.traceContext = createBrowserTraceContext({
    randomValues: options.randomValues,
    sampled: options.sampled,
    traceFlags: options.traceFlags
  });
  const navigationMetadata = compactMetadata({
    navigationType,
    previousPath,
    routeChange: true
  });
  const captureOptions = {
    ...options,
    metadata: mergeMetadata(options.metadata, navigationMetadata),
    traceContext: context.traceContext
  };
  try {
    void capturePageView(context, captureOptions);
  } catch (error) {
    if (typeof options.onCaptureError === "function") {
      void options.onCaptureError(error, context, { reason: "capture" });
    }
    if (options.raiseCaptureErrors === true) {
      throw error;
    }
  }
}

function createPageViewEvent(browserWindow = defaultWindow(), {
  idFactory = defaultPageViewEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = () => new Date().toISOString(),
  sanitizeMetadata = defaultSanitizeMetadata,
  traceContext
} = {}) {
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const browserTraceContext = optionalBrowserTraceContext(traceContext);
  const baseMetadata = browserMetadata(browserWindow, {
    includeDocumentTitle,
    includeUserAgent,
    path,
    source: "browser.page_view"
  });
  const safeMetadata = sanitizeMetadata(mergeMetadata(baseMetadata, metadata), "page_view");
  return {
    id: idFactory({ browserWindow, path }),
    timestamp: now(),
    attributes: {
      durationMs: 0,
      metadata: safeMetadata,
      name: `page_view ${path}`,
      spanId: browserTraceContext?.spanId ?? `span_browser_${slugify(path)}`,
      status: "ok",
      traceId: browserTraceContext?.traceId ?? `trace_browser_${slugify(path)}`
    }
  };
}

function createBrowserActionEvent(action, browserWindow = defaultWindow(), {
  idFactory = defaultActionEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = () => new Date().toISOString(),
  sanitizeMetadata = defaultSanitizeMetadata,
  traceContext
} = {}) {
  const details = actionDetails(action);
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const browserTraceContext = optionalBrowserTraceContext(traceContext);
  const baseMetadata = browserMetadata(browserWindow, {
    includeDocumentTitle,
    includeUserAgent,
    path,
    source: "browser.action"
  });
  const safeMetadata = sanitizeMetadata(
    mergeMetadata(
      mergeMetadata(mergeMetadata(baseMetadata, metadata), details.metadata),
      browserTraceMetadata(browserTraceContext)
    ),
    "action"
  );
  return {
    id: idFactory({ action, browserWindow, message: details.name, path, source: "action" }),
    timestamp: now(),
    attributes: {
      metadata: safeMetadata,
      name: details.name,
      status: details.status
    }
  };
}

function createBrowserNetworkEvent(request, browserWindow = defaultWindow(), {
  idFactory = defaultNetworkEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = () => new Date().toISOString(),
  sanitizeMetadata = defaultSanitizeMetadata,
  traceContext
} = {}) {
  const details = networkDetails(request);
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const browserTraceContext = optionalBrowserTraceContext(traceContext);
  const baseMetadata = browserMetadata(browserWindow, {
    includeDocumentTitle,
    includeUserAgent,
    path,
    source: "browser.network"
  });
  const networkMetadata = compactMetadata({
    durationMs: details.durationMs,
    method: details.method,
    routeTemplate: details.routeTemplate,
    sessionId: details.sessionId,
    statusCode: details.statusCode,
    traceId: details.traceId
  });
  const safeMetadata = sanitizeMetadata(
    mergeMetadata(
      mergeMetadata(mergeMetadata(mergeMetadata(baseMetadata, metadata), networkMetadata), details.metadata),
      browserTraceMetadata(browserTraceContext, { traceId: details.traceId })
    ),
    "network"
  );
  return {
    id: idFactory({ browserWindow, message: details.name, path, request, source: "network" }),
    timestamp: now(),
    attributes: {
      metadata: safeMetadata,
      name: details.name,
      status: details.status
    }
  };
}

function createBrowserErrorEvent(error, browserWindow = defaultWindow(), {
  debugIdMap,
  environment,
  fingerprint,
  idFactory = defaultErrorEventId,
  includeErrorStack = false,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = () => new Date().toISOString(),
  platform,
  release,
  sanitizeMetadata = defaultSanitizeMetadata,
  runtime,
  service,
  traceContext
} = {}) {
  const details = errorDetails(error);
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const browserTraceContext = optionalBrowserTraceContext(traceContext);
  const baseMetadata = browserMetadata(browserWindow, {
    columnNumber: details.columnNumber,
    errorName: details.name,
    includeDocumentTitle,
    includeUserAgent,
    lineNumber: details.lineNumber,
    path,
    source: "browser.error",
    sourcePath: sanitizeSourcePath(details.source)
  });
  const attributes = browserIssueAttributes(details.candidate, details.message, {
    debugIdMap,
    environment,
    fingerprint,
    includeErrorStack,
    metadata: mergeMetadata(baseMetadata, metadata),
    platform,
    release,
    runtime,
    service,
    source: "browser.error",
    title: `Browser error: ${details.message}`,
    traceContext: browserTraceContext
  });
  const safeMetadata = sanitizeMetadata(
    sanitizeBrowserIssueMetadata(attributes.metadata),
    "error"
  );
  return {
    id: idFactory({ error, message: details.message, path, source: "error" }),
    timestamp: now(),
    attributes: { ...attributes, metadata: safeMetadata }
  };
}

function createUnhandledRejectionEvent(rejection, browserWindow = defaultWindow(), {
  debugIdMap,
  environment,
  fingerprint,
  idFactory = defaultErrorEventId,
  includeErrorStack = false,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = () => new Date().toISOString(),
  platform,
  release,
  sanitizeMetadata = defaultSanitizeMetadata,
  runtime,
  service,
  traceContext
} = {}) {
  const reason = rejectionReason(rejection);
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const browserTraceContext = optionalBrowserTraceContext(traceContext);
  const baseMetadata = browserMetadata(browserWindow, {
    errorName: reason.name,
    includeDocumentTitle,
    includeUserAgent,
    path,
    source: "browser.unhandledrejection"
  });
  const attributes = browserIssueAttributes(reason.candidate, reason.message, {
    debugIdMap,
    environment,
    fingerprint,
    includeErrorStack,
    metadata: mergeMetadata(baseMetadata, metadata),
    platform,
    release,
    runtime,
    service,
    source: "browser.unhandledrejection",
    title: `Unhandled promise rejection: ${reason.message}`,
    traceContext: browserTraceContext
  });
  const safeMetadata = sanitizeMetadata(
    sanitizeBrowserIssueMetadata(attributes.metadata),
    "unhandledrejection"
  );
  return {
    id: idFactory({ error: rejection, message: reason.message, path, source: "unhandledrejection" }),
    timestamp: now(),
    attributes: { ...attributes, metadata: safeMetadata }
  };
}

async function flushAfterCapture(context, options) {
  if (options.flushOnCapture === false) {
    return undefined;
  }

  return flushWithCallbacks(context, options, { reason: "capture" });
}

async function flushForLifecycle(context, options, reason) {
  if (context.client.pendingEvents() === 0) {
    return undefined;
  }
  return flushWithCallbacks(context, options, { reason });
}

async function replayStoredBatchesThenFlush(context, options) {
  await replayStoredBrowserBatches(context);
  return flushForLifecycle(context, options, "online");
}

async function replayStoredBrowserBatches(context) {
  if (typeof context.transport?.replayStoredBatches !== "function") {
    return { attempted: 0, delivered: 0, retained: 0 };
  }
  return context.transport.replayStoredBatches(context.client.apiKey, {
    skipOwnBatches: context.client.pendingEvents() > 0
  });
}

async function flushWithCallbacks(context, options, details) {
  try {
    const response = await context.client.flush(context.transport);
    if (typeof options.onFlush === "function") {
      await options.onFlush(response, context, details);
    }
    return response;
  } catch (error) {
    if (typeof options.onCaptureError === "function") {
      await options.onCaptureError(error, context, details);
    }
    if (options.raiseCaptureErrors === true) {
      throw error;
    }
    return undefined;
  }
}

function removeListeners(browserWindow, listeners) {
  if (typeof browserWindow.removeEventListener !== "function") {
    return;
  }
  browserWindow.removeEventListener("error", listeners.error);
  browserWindow.removeEventListener("unhandledrejection", listeners.rejection);
  browserWindow.removeEventListener("pagehide", listeners.pagehide);
  browserWindow.removeEventListener("online", listeners.online);
  if (typeof browserWindow.document?.removeEventListener === "function") {
    browserWindow.document.removeEventListener("visibilitychange", listeners.visibilitychange);
  }
}

function maybePreventDefault(event, options) {
  if (options.preventDefault !== true || typeof event?.preventDefault !== "function") {
    return;
  }
  event.preventDefault();
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

function eventCallbackContext(context) {
  return {
    browserWindow: context.browserWindow,
    client: context.client,
    traceContext: context.traceContext
  };
}

async function suppressBrowserIssue(event, context, options) {
  const summary = browserIssueSuppressionSummary(event);
  const ruleReason = matchedSuppressionRuleReason(options.errorSuppressionRules, event, summary);
  if (ruleReason) {
    return notifyBrowserIssueSuppressed(summary, context, options, ruleReason);
  }
  if (typeof options.shouldCaptureError !== "function") {
    return undefined;
  }
  try {
    if (options.shouldCaptureError(event, summary) === false) {
      return notifyBrowserIssueSuppressed(summary, context, options, "should_capture_error");
    }
  } catch (error) {
    if (typeof options.onCaptureError === "function") {
      await options.onCaptureError(error, context, { reason: "capture" });
    }
    if (options.raiseCaptureErrors === true) {
      throw error;
    }
  }
  return undefined;
}

async function notifyBrowserIssueSuppressed(summary, context, options, reason) {
  const safeSummary = { ...summary, reason: safeSuppressionReason(reason) };
  try {
    if (typeof options.onIssueSuppressed === "function") {
      await options.onIssueSuppressed(safeSummary, context, { reason: "capture" });
    }
  } catch (error) {
    if (typeof options.onCaptureError === "function") {
      await options.onCaptureError(error, context, { reason: "capture" });
    }
    if (options.raiseCaptureErrors === true) {
      throw error;
    }
  }
  return Object.freeze({ reason: safeSummary.reason, suppressed: true });
}

function browserIssueSuppressionSummary(event) {
  const metadata = safeMetadata(event?.attributes?.metadata);
  return compactMetadata({
    errorName: metadata.errorName,
    errorFrameFile: metadata.errorFrameFile,
    issueFingerprint: metadata.issueFingerprint,
    issueGroupingKey: metadata.issueGroupingKey,
    path: metadata.path,
    reason: "matched_rule",
    source: metadata.source
  });
}

function matchedSuppressionRuleReason(rules, event, summary) {
  if (rules === undefined) {
    return undefined;
  }
  if (!Array.isArray(rules)) {
    throw new SdkError("configuration_error", "errorSuppressionRules must be an array");
  }
  for (const rule of rules) {
    if (matchesSuppressionRule(rule, event, summary)) {
      return typeof rule.reason === "string" && rule.reason.trim() !== "" ? rule.reason : "matched_rule";
    }
  }
  return undefined;
}

function matchesSuppressionRule(rule, event, summary) {
  if (!rule || Array.isArray(rule) || typeof rule !== "object") {
    return false;
  }
  const matchers = [
    ["source", summary.source],
    ["errorName", summary.errorName],
    ["path", summary.path],
    ["frameFile", summary.errorFrameFile],
    ["groupingKey", summary.issueGroupingKey],
    ["fingerprint", summary.issueFingerprint]
  ];
  let hasMatcher = false;
  for (const [field, value] of matchers) {
    if (rule[field] === undefined) {
      continue;
    }
    hasMatcher = true;
    if (!matchesSuppressionMatcher(value, rule[field])) {
      return false;
    }
  }
  if (rule.message !== undefined) {
    hasMatcher = true;
    if (!matchesSuppressionMatcher(event?.attributes?.message, rule.message)) {
      return false;
    }
  }
  return hasMatcher;
}

function matchesSuppressionMatcher(value, matcher) {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  if (typeof matcher === "string") {
    return value === matcher;
  }
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    const matched = matcher.test(value);
    matcher.lastIndex = 0;
    return matched;
  }
  if (Array.isArray(matcher)) {
    return matcher.some((entry) => matchesSuppressionMatcher(value, entry));
  }
  return false;
}

function safeSuppressionReason(reason) {
  const value = typeof reason === "string" && reason.trim() !== "" ? reason.trim() : "matched_rule";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80) || "matched_rule";
}

function createBrowserTransport(options, browserWindow) {
  const transport = options.transport ?? createFetchTransport(options);
  if (!options.persistOffline) {
    return transport;
  }
  const persistConfig = options.persistOffline === true ? {} : options.persistOffline;
  if (!persistConfig || typeof persistConfig !== "object" || Array.isArray(persistConfig)) {
    throw new SdkError("configuration_error", "persistOffline must be true or a configuration object");
  }
  return createPersistentBrowserTransport({
    ...persistConfig,
    storage: persistConfig.storage ?? browserWindow.localStorage,
    transport
  });
}

function browserMetadata(browserWindow, {
  columnNumber,
  errorName,
  includeDocumentTitle,
  includeUserAgent,
  lineNumber,
  path,
  source,
  sourcePath
}) {
  return compactMetadata({
    columnNumber,
    documentTitle: includeDocumentTitle ? browserWindow?.document?.title : undefined,
    errorName,
    lineNumber,
    path,
    source,
    sourcePath,
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

function browserIssueAttributes(candidate, message, {
  debugIdMap,
  environment,
  fingerprint,
  includeErrorStack,
  metadata,
  platform,
  release,
  runtime,
  service,
  source,
  title,
  traceContext
}) {
  return createIssueAttributesFromError(candidate, {
    debugIdMap,
    environment,
    fingerprint,
    includeErrorStack,
    level: "error",
    message,
    metadata,
    platform,
    release,
    runtime,
    service,
    source,
    title,
    trace: traceContext ? {
      sampled: traceContext.sampled,
      spanId: traceContext.spanId,
      traceId: traceContext.traceId
    } : undefined
  });
}

function sanitizeBrowserIssueMetadata(metadata) {
  const sanitized = { ...safeMetadata(metadata) };
  const frameFile = browserCodePath(sanitized.errorFrameFile);
  if (frameFile) {
    sanitized.errorFrameFile = frameFile;
  }
  const codeFile = browserCodePath(sanitized.releaseArtifactCodeFile);
  if (codeFile) {
    sanitized.releaseArtifactCodeFile = codeFile;
  }
  const groupingKey = browserIssueGroupingKey(sanitized.issueGroupingKey);
  if (groupingKey) {
    sanitized.issueGroupingKey = groupingKey;
  }
  return compactMetadata(sanitized);
}

function browserIssueGroupingKey(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  const firstSeparator = trimmed.indexOf(":");
  const secondSeparator = firstSeparator === -1 ? -1 : trimmed.indexOf(":", firstSeparator + 1);
  if (secondSeparator === -1) {
    return trimmed;
  }
  const frameFile = browserCodePath(trimmed.slice(secondSeparator + 1));
  return frameFile ? `${trimmed.slice(0, secondSeparator + 1)}${frameFile}` : trimmed;
}

function browserCodePath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    try {
      return new URL(trimmed).pathname || undefined;
    } catch {
      return pathBasename(trimmed);
    }
  }
  const path = trimmed.split(/[?#]/u, 1)[0].replace(/\\/gu, "/");
  if (/^[A-Za-z]:\//u.test(path) || /^\/(?:Users|home|private|tmp|var)\//u.test(path)) {
    return pathBasename(path);
  }
  return path || undefined;
}

function pathBasename(path) {
  return path.split("/").filter(Boolean).pop();
}

function resolveBrowserTraceContext(options) {
  if (options.traceContext === false) {
    return undefined;
  }
  if (options.traceContext !== undefined) {
    return optionalBrowserTraceContext(options.traceContext);
  }
  return createBrowserTraceContext({
    randomValues: options.randomValues,
    sampled: options.sampled,
    spanId: options.spanId,
    traceFlags: options.traceFlags,
    traceId: options.traceId
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

function actionDetails(action) {
  if (typeof action === "string") {
    return { metadata: undefined, name: action, status: "success" };
  }
  return {
    metadata: safeMetadata(action?.metadata),
    name: typeof action?.name === "string" ? action.name : String(action?.name ?? ""),
    status: typeof action?.status === "string" ? action.status : "success"
  };
}

function networkDetails(request) {
  const routeTemplate = routeTemplatePath(typeof request === "string" ? request : request?.routeTemplate);
  const method = networkMethod(request);
  const statusCode = numberOrUndefined(request?.statusCode);
  const status = typeof request?.status === "string"
    ? request.status
    : statusCode !== undefined && statusCode >= 400 ? "failure" : "success";
  const name = typeof request?.name === "string" && request.name.trim() !== ""
    ? request.name
    : `network.${method.toLowerCase()} ${routeTemplate}`;
  return {
    durationMs: nonNegativeNumberOrUndefined(request?.durationMs),
    metadata: safeMetadata(request?.metadata),
    method,
    name,
    routeTemplate,
    sessionId: stringOrUndefined(request?.sessionId),
    status,
    statusCode,
    traceId: stringOrUndefined(request?.traceId)
  };
}

function errorDetails(error) {
  const candidate = error?.error ?? error;
  const message = error?.message ?? errorMessage(candidate);
  return {
    candidate,
    columnNumber: numberOrUndefined(error?.colno ?? error?.columnNumber),
    lineNumber: numberOrUndefined(error?.lineno ?? error?.lineNumber),
    message,
    name: candidate instanceof Error ? candidate.name : undefined,
    source: error?.filename ?? error?.source
  };
}

function rejectionReason(rejection) {
  const reason = rejection?.reason ?? rejection;
  return {
    candidate: reason,
    message: errorMessage(reason),
    name: reason instanceof Error ? reason.name : undefined
  };
}

function errorMessage(error) {
  if (error instanceof Error && typeof error.message === "string" && error.message.trim() !== "") {
    return error.message;
  }
  if (typeof error === "string" && error.trim() !== "") {
    return error;
  }
  return String(error ?? "unknown error");
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

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function networkMethod(request) {
  const method = typeof request?.method === "string" && request.method.trim() !== ""
    ? request.method
    : "GET";
  return method.trim().toUpperCase();
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

function defaultPageViewEventId({ path }) {
  return `evt_browser_page_${slugify(path)}`;
}

function defaultErrorEventId({ message, path, source }) {
  return `evt_browser_${source}_${slugify(`${path}_${message}`)}`;
}

function defaultActionEventId({ message, path }) {
  return `evt_browser_action_${slugify(`${path}_${message}`)}`;
}

function defaultNetworkEventId({ message, path }) {
  return `evt_browser_network_${slugify(`${path}_${message}`)}`;
}

function defaultFetch() {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
}

function defaultWindow() {
  return typeof globalThis.window === "object" ? globalThis.window : undefined;
}

function validateKeepaliveBodyLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SdkError("configuration_error", "maxKeepaliveBodyBytes must be a positive integer");
  }
}

function utf8ByteLength(value) {
  const text = typeof value === "string" ? value : String(value);
  const TextEncoderConstructor = globalThis.TextEncoder;
  if (typeof TextEncoderConstructor === "function") {
    return new TextEncoderConstructor().encode(text).byteLength;
  }
  return fallbackUtf8ByteLength(text);
}

function retryAfterMsFromHeaders(headers) {
  if (!headers || typeof headers.get !== "function") {
    return undefined;
  }
  return retryAfterMsFromHeader(headers.get("retry-after"));
}

function retryAfterMsFromHeader(value, now = Date.now()) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - now);
}

function fallbackUtf8ByteLength(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint > 0xffff) {
      index += 1;
    }
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

module.exports = {
  RecordingTransport,
  captureBrowserAction,
  captureBrowserError,
  captureBrowserFetchSpan,
  captureBrowserInteractionTiming,
  captureBrowserInteractionToNextPaint,
  captureBrowserNetwork,
  captureBrowserNavigationTiming,
  captureBrowserResourceTiming,
  captureBrowserWebVital,
  captureBrowserXhrSpan,
  capturePageView,
  captureUnhandledRejection,
  createBrowserTraceContext,
  createBrowserTraceparent,
  createBrowserActionEvent,
  createBrowserErrorEvent,
  createBrowserFetchSpanEvent,
  createBrowserInteractionTimingEvent,
  createBrowserInteractionToNextPaintEvent,
  createBrowserNavigationTimingEvent,
  createBrowserResourceTimingEvent,
  createBrowserWebVitalEvent,
  createBrowserXhrSpanEvent,
  createBeaconTransport,
  createFetchTransport,
  createLogBrewBrowserFetch,
  createLogBrewBrowserClient,
  createLogBrewBrowserContext,
  createBrowserNetworkEvent,
  createPageViewEvent,
  createPersistentBrowserTransport,
  createTraceparentFetch,
  createUnhandledRejectionEvent,
  default: {
    captureBrowserAction,
    captureBrowserError,
    captureBrowserFetchSpan,
    captureBrowserInteractionTiming,
    captureBrowserInteractionToNextPaint,
    captureBrowserNetwork,
    captureBrowserNavigationTiming,
    captureBrowserResourceTiming,
    captureBrowserWebVital,
    captureBrowserXhrSpan,
    capturePageView,
    captureUnhandledRejection,
    createBrowserTraceContext,
    createBrowserTraceparent,
    createBrowserActionEvent,
    createBrowserErrorEvent,
    createBrowserFetchSpanEvent,
    createBrowserInteractionTimingEvent,
    createBrowserInteractionToNextPaintEvent,
    createBrowserNavigationTimingEvent,
    createBrowserResourceTimingEvent,
    createBrowserWebVitalEvent,
    createBrowserXhrSpanEvent,
    createBeaconTransport,
    createFetchTransport,
    createLogBrewBrowserFetch,
    createLogBrewBrowserClient,
    createLogBrewBrowserContext,
    createBrowserNetworkEvent,
    createPageViewEvent,
    createPersistentBrowserTransport,
    createTraceparentFetch,
    createUnhandledRejectionEvent,
    installLogBrewBrowserNavigationInstrumentation,
    installLogBrewBrowserFetchInstrumentation,
    installLogBrewBrowserInteractionTimingInstrumentation,
    installLogBrewBrowserNavigationTimingInstrumentation,
    installLogBrewBrowserResourceTimingInstrumentation,
    installLogBrewBrowserWebVitalsInstrumentation,
    installLogBrewBrowserXhrInstrumentation,
    installLogBrewBrowser,
    shouldPropagateTraceparent
  },
  installLogBrewBrowserNavigationInstrumentation,
  installLogBrewBrowserFetchInstrumentation,
  installLogBrewBrowserInteractionTimingInstrumentation,
  installLogBrewBrowserNavigationTimingInstrumentation,
  installLogBrewBrowserResourceTimingInstrumentation,
  installLogBrewBrowserWebVitalsInstrumentation,
  installLogBrewBrowserXhrInstrumentation,
  installLogBrewBrowser,
  shouldPropagateTraceparent
};
