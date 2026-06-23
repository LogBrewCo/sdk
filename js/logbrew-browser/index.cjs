"use strict";

const {
  createTraceparent,
  LogBrewClient,
  parseTraceparent,
  RecordingTransport,
  SdkError,
  TransportError
} = require("@logbrew/sdk");

const DEFAULT_SDK_NAME = "logbrew-browser";
const DEFAULT_SDK_VERSION = "0.1.0";
const DEFAULT_ENDPOINT = "https://api.logbrew.com/v1/events";
const DEFAULT_MAX_KEEPALIVE_BODY_BYTES = 64 * 1024;

function createLogBrewBrowserClient({
  apiKey,
  clientKey,
  sdkName = DEFAULT_SDK_NAME,
  sdkVersion = DEFAULT_SDK_VERSION,
  maxRetries = 2
} = {}) {
  const authKey = clientKey ?? apiKey;
  if (!authKey) {
    throw new SdkError("configuration_error", "createLogBrewBrowserClient requires clientKey or apiKey");
  }
  return LogBrewClient.create({ apiKey: authKey, sdkName, sdkVersion, maxRetries });
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
        return { statusCode: response.status, attempts: 1 };
      } catch (error) {
        throw TransportError.network(`fetch failed: ${errorMessage(error)}`);
      }
    }
  };
}

function createBrowserTraceparent({
  randomValues = defaultRandomValues,
  spanId,
  traceFlags = "01",
  traceId
} = {}) {
  return createTraceparent({
    spanId: spanId ?? randomHex(8, randomValues),
    traceFlags,
    traceId: traceId ?? randomHex(16, randomValues)
  });
}

function createTraceparentFetch({
  fetchImpl = defaultFetch(),
  randomValues = defaultRandomValues,
  traceFlags = "01",
  traceparent,
  traceparentFactory,
  tracePropagationTargets = []
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new SdkError("configuration_error", "createTraceparentFetch requires fetch");
  }
  if (!Array.isArray(tracePropagationTargets)) {
    throw new SdkError("configuration_error", "tracePropagationTargets must be an array");
  }
  if (traceparentFactory !== undefined && typeof traceparentFactory !== "function") {
    throw new SdkError("configuration_error", "traceparentFactory must be a function");
  }

  return async function tracedFetch(input, init) {
    const url = requestUrl(input);
    if (!shouldPropagateTraceparent(url, tracePropagationTargets)) {
      return init === undefined ? fetchImpl(input) : fetchImpl(input, init);
    }

    const requestInit = init ?? {};
    const nextTraceparent = traceparentForRequest({
      init,
      input,
      randomValues,
      traceFlags,
      traceparent,
      traceparentFactory,
      url
    });
    const nextInit = {
      ...requestInit,
      headers: headersWithTraceparent(requestHeaders(input, requestInit), nextTraceparent)
    };
    return fetchImpl(input, nextInit);
  };
}

function shouldPropagateTraceparent(url, tracePropagationTargets = []) {
  if (!Array.isArray(tracePropagationTargets)) {
    throw new SdkError("configuration_error", "tracePropagationTargets must be an array");
  }
  return tracePropagationTargets.some((target) => {
    if (typeof target === "string") {
      return shouldPropagateToStringTarget(url, target);
    }
    if (target instanceof RegExp) {
      target.lastIndex = 0;
      const matched = target.test(url);
      target.lastIndex = 0;
      return matched;
    }
    if (typeof target === "function") {
      return target(url) === true;
    }
    throw new SdkError("configuration_error", "tracePropagationTargets entries must be strings, RegExp values, or functions");
  });
}

function installLogBrewBrowser(options = {}) {
  const browserWindow = options.browserWindow ?? defaultWindow();
  if (!browserWindow || typeof browserWindow.addEventListener !== "function") {
    throw new SdkError("configuration_error", "installLogBrewBrowser requires a browser window");
  }

  const client = options.client ?? createLogBrewBrowserClient(options);
  const transport = options.transport ?? createFetchTransport(options);
  let installed = true;
  const context = createLogBrewBrowserContext(client, transport, browserWindow, () => {
    if (!installed) {
      return;
    }
    installed = false;
    removeListeners(browserWindow, listeners);
  });

  const listeners = {
    error: (event) => {
      void captureBrowserError(event, context, options);
    },
    pagehide: () => {
      void flushForLifecycle(context, options);
    },
    rejection: (event) => {
      void captureUnhandledRejection(event, context, options);
    },
    visibilitychange: () => {
      if (browserWindow.document?.visibilityState === "hidden") {
        void flushForLifecycle(context, options);
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
  if (options.flushOnVisibilityHidden !== false && typeof browserWindow.document?.addEventListener === "function") {
    browserWindow.document.addEventListener("visibilitychange", listeners.visibilitychange);
  }
  if (options.capturePageViews !== false) {
    void capturePageView(context, options);
  }

  return context;
}

function createLogBrewBrowserContext(client, transport, browserWindow = defaultWindow(), uninstall = () => undefined) {
  return {
    browserWindow,
    client,
    flush: () => client.flush(transport),
    logbrew: client,
    previewJson: () => client.previewJson(),
    shutdown: () => client.shutdown(transport),
    transport,
    uninstall
  };
}

async function capturePageView(context, options = {}) {
  const event = typeof options.pageViewEvent === "function"
    ? options.pageViewEvent({ browserWindow: context.browserWindow, client: context.client })
    : createPageViewEvent(context.browserWindow, options);

  context.client.span(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

async function captureBrowserError(error, context, options = {}) {
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, { browserWindow: context.browserWindow, client: context.client })
    : createBrowserErrorEvent(error, context.browserWindow, options);

  context.client.issue(event.id, event.timestamp, event.attributes);
  maybePreventDefault(error, options);
  return flushAfterCapture(context, options);
}

async function captureUnhandledRejection(rejection, context, options = {}) {
  const event = typeof options.rejectionEvent === "function"
    ? options.rejectionEvent(rejection, { browserWindow: context.browserWindow, client: context.client })
    : createUnhandledRejectionEvent(rejection, context.browserWindow, options);

  context.client.issue(event.id, event.timestamp, event.attributes);
  maybePreventDefault(rejection, options);
  return flushAfterCapture(context, options);
}

async function captureBrowserAction(action, context, options = {}) {
  const event = typeof options.actionEvent === "function"
    ? options.actionEvent(action, { browserWindow: context.browserWindow, client: context.client })
    : createBrowserActionEvent(action, context.browserWindow, options);

  context.client.action(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

async function captureBrowserNetwork(request, context, options = {}) {
  const event = typeof options.networkEvent === "function"
    ? options.networkEvent(request, { browserWindow: context.browserWindow, client: context.client })
    : createBrowserNetworkEvent(request, context.browserWindow, options);

  context.client.action(event.id, event.timestamp, event.attributes);
  return flushAfterCapture(context, options);
}

function createPageViewEvent(browserWindow = defaultWindow(), {
  idFactory = defaultPageViewEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = () => new Date().toISOString(),
  sanitizeMetadata = defaultSanitizeMetadata
} = {}) {
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
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
      spanId: `span_browser_${slugify(path)}`,
      status: "ok",
      traceId: `trace_browser_${slugify(path)}`
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
  sanitizeMetadata = defaultSanitizeMetadata
} = {}) {
  const details = actionDetails(action);
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const baseMetadata = browserMetadata(browserWindow, {
    includeDocumentTitle,
    includeUserAgent,
    path,
    source: "browser.action"
  });
  const safeMetadata = sanitizeMetadata(
    mergeMetadata(mergeMetadata(baseMetadata, metadata), details.metadata),
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
  sanitizeMetadata = defaultSanitizeMetadata
} = {}) {
  const details = networkDetails(request);
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
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
    mergeMetadata(mergeMetadata(mergeMetadata(baseMetadata, metadata), networkMetadata), details.metadata),
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
  idFactory = defaultErrorEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = () => new Date().toISOString(),
  sanitizeMetadata = defaultSanitizeMetadata
} = {}) {
  const details = errorDetails(error);
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
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
  const safeMetadata = sanitizeMetadata(mergeMetadata(baseMetadata, metadata), "error");
  return {
    id: idFactory({ error, message: details.message, path, source: "error" }),
    timestamp: now(),
    attributes: {
      level: "error",
      message: details.message,
      metadata: safeMetadata,
      title: `Browser error: ${details.message}`
    }
  };
}

function createUnhandledRejectionEvent(rejection, browserWindow = defaultWindow(), {
  idFactory = defaultErrorEventId,
  includeDocumentTitle = false,
  includeHash = false,
  includeQueryString = false,
  includeUserAgent = false,
  metadata,
  now = () => new Date().toISOString(),
  sanitizeMetadata = defaultSanitizeMetadata
} = {}) {
  const reason = rejectionReason(rejection);
  const path = browserPath(browserWindow, { includeHash, includeQueryString });
  const baseMetadata = browserMetadata(browserWindow, {
    errorName: reason.name,
    includeDocumentTitle,
    includeUserAgent,
    path,
    source: "browser.unhandledrejection"
  });
  const safeMetadata = sanitizeMetadata(mergeMetadata(baseMetadata, metadata), "unhandledrejection");
  return {
    id: idFactory({ error: rejection, message: reason.message, path, source: "unhandledrejection" }),
    timestamp: now(),
    attributes: {
      level: "error",
      message: reason.message,
      metadata: safeMetadata,
      title: `Unhandled promise rejection: ${reason.message}`
    }
  };
}

async function flushAfterCapture(context, options) {
  if (options.flushOnCapture === false) {
    return undefined;
  }

  return flushWithCallbacks(context, options);
}

async function flushForLifecycle(context, options) {
  if (context.client.pendingEvents() === 0) {
    return undefined;
  }
  return flushWithCallbacks(context, options);
}

async function flushWithCallbacks(context, options) {
  try {
    const response = await context.client.flush(context.transport);
    if (typeof options.onFlush === "function") {
      await options.onFlush(response, context);
    }
    return response;
  } catch (error) {
    if (typeof options.onCaptureError === "function") {
      await options.onCaptureError(error, context);
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

function defaultRandomValues(length) {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new SdkError("configuration_error", "createBrowserTraceparent requires crypto.getRandomValues or randomValues");
  }
  const bytes = new Uint8Array(length);
  return globalThis.crypto.getRandomValues(bytes);
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

function randomHex(length, randomValues) {
  if (typeof randomValues !== "function") {
    throw new SdkError("configuration_error", "randomValues must be a function");
  }
  const bytes = Array.from(randomValues(length));
  if (bytes.length !== length || bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new SdkError("configuration_error", "randomValues must return byte values for the requested length");
  }
  return bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
}

function shouldPropagateToStringTarget(url, target) {
  const targetText = target.trim();
  if (targetText === "") {
    return false;
  }
  if (targetText.startsWith("/")) {
    return url.startsWith(targetText);
  }

  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor === "function") {
    try {
      const targetUrl = new URLConstructor(targetText);
      if (!hasUrlScheme(url)) {
        return false;
      }
      const requestUrl = new URLConstructor(url, targetUrl.origin);
      if (requestUrl.origin !== targetUrl.origin) {
        return false;
      }
      const targetPath = targetUrl.pathname || "/";
      return requestUrl.pathname === targetPath || requestUrl.pathname.startsWith(pathPrefix(targetPath));
    } catch {
      return url.startsWith(targetText);
    }
  }

  return url.startsWith(targetText);
}

function pathPrefix(pathname) {
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function hasUrlScheme(url) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(url);
}

function requestHeaders(input, init) {
  if (init && init.headers !== undefined) {
    return init.headers;
  }
  return input?.headers;
}

function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input?.url === "string") {
    return input.url;
  }
  return String(input);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

function traceparentForRequest({
  init,
  input,
  randomValues,
  traceFlags,
  traceparent,
  traceparentFactory,
  url
}) {
  const nextTraceparent = typeof traceparentFactory === "function"
    ? traceparentFactory({ init, input, url })
    : traceparent ?? createBrowserTraceparent({ randomValues, traceFlags });
  parseTraceparent(nextTraceparent);
  return nextTraceparent;
}

module.exports = {
  RecordingTransport,
  captureBrowserAction,
  captureBrowserError,
  captureBrowserNetwork,
  capturePageView,
  captureUnhandledRejection,
  createBrowserTraceparent,
  createBrowserActionEvent,
  createBrowserErrorEvent,
  createFetchTransport,
  createLogBrewBrowserClient,
  createLogBrewBrowserContext,
  createBrowserNetworkEvent,
  createPageViewEvent,
  createTraceparentFetch,
  createUnhandledRejectionEvent,
  default: {
    captureBrowserAction,
    captureBrowserError,
    capturePageView,
    captureUnhandledRejection,
    createBrowserTraceparent,
    createBrowserActionEvent,
    createBrowserErrorEvent,
    createFetchTransport,
    createLogBrewBrowserClient,
    createLogBrewBrowserContext,
    createPageViewEvent,
    createTraceparentFetch,
    createUnhandledRejectionEvent,
    installLogBrewBrowser,
    shouldPropagateTraceparent
  },
  installLogBrewBrowser,
  shouldPropagateTraceparent
};
