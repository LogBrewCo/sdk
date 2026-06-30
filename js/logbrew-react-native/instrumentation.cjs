"use strict";

const { SdkError } = require("@logbrew/sdk");
const {
  captureReactNativeResourceSpan,
  createReactNavigationSpanListener,
  createReactNativeTraceContext,
  createReactNativeTraceHeaders,
  getActiveLogBrewTrace,
  shouldPropagateTraceparent
} = require("./index.cjs");
const { createAppStateLifecycleSpanListener } = require("./lifecycle.cjs");
const { createSafeReactNativeMetadata } = require("./metadata.cjs");
const {
  clearLogBrewNativeBridgeScope,
  syncLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScope
} = require("./native-bridge.cjs");
const { createReactNativeResourceFetch } = require("./resource-fetch.cjs");

function createLogBrewReactNativeInstrumentation(client, {
  appState,
  captureInitialLifecycleState = false,
  captureInitialNavigationRoute = false,
  fetchImpl,
  globalObject = globalThis,
  includeRouteKey = false,
  instrumentGlobalFetch = false,
  instrumentGlobalXMLHttpRequest = false,
  logger,
  measureXhrResponseBodySize = false,
  metadata = {},
  metadataFactory,
  nativeBridge,
  navigation,
  navigationContainer,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  onError,
  platform,
  randomValues,
  routeTemplate,
  routeTemplateFactory,
  screen,
  sessionId,
  trace,
  traceFlags = "01",
  tracePropagationTargets = []
} = {}) {
  requireClient(client);
  const activeTrace = resolveInstrumentationTrace({ randomValues, trace, traceFlags });
  const removers = [];
  const resolvedNavigation = navigationContainer ?? navigation;

  if (appState?.addEventListener) {
    removers.push(createAppStateLifecycleSpanListener(client, appState, {
      captureInitialState: captureInitialLifecycleState,
      metadata,
      now,
      nowMs,
      onError,
      platform,
      screen,
      sessionId,
      trace: activeTrace
    }));
  }

  if (resolvedNavigation) {
    removers.push(createReactNavigationSpanListener(client, resolvedNavigation, {
      appState,
      captureInitialRoute: captureInitialNavigationRoute,
      includeRouteKey,
      metadata,
      now,
      nowMs,
      onError,
      platform,
      trace: activeTrace
    }));
  }

  if (nativeBridge) {
    syncLogBrewNativeBridgeScope(nativeBridge, {
      logger,
      metadata,
      screen,
      sessionId,
      source: "react-native.instrumentation",
      trace: activeTrace
    });
  }

  const resourceFetch = createReactNativeResourceFetch(client, {
    appState,
    fetchImpl,
    metadata,
    metadataFactory,
    now,
    nowMs,
    platform,
    randomValues,
    routeTemplate,
    routeTemplateFactory,
    screen,
    sessionId,
    trace: activeTrace,
    traceFlags,
    tracePropagationTargets
  });
  let globalFetch;
  let globalXMLHttpRequest;
  try {
    globalFetch = instrumentGlobalFetch ? installGlobalFetchInstrumentation(client, {
      appState,
      globalObject,
      metadata,
      metadataFactory,
      now,
      nowMs,
      platform,
      randomValues,
      routeTemplate,
      routeTemplateFactory,
      screen,
      sessionId,
      trace: activeTrace,
      traceFlags,
      tracePropagationTargets
    }) : undefined;
    if (globalFetch) {
      removers.push(globalFetch.remove);
    }
    globalXMLHttpRequest = instrumentGlobalXMLHttpRequest ? installGlobalXMLHttpRequestInstrumentation(client, {
      appState,
      globalObject,
      measureXhrResponseBodySize,
      metadata,
      metadataFactory,
      now,
      nowMs,
      platform,
      routeTemplate,
      routeTemplateFactory,
      screen,
      sessionId,
      trace: activeTrace,
      tracePropagationTargets
    }) : undefined;
    if (globalXMLHttpRequest) {
      removers.push(globalXMLHttpRequest.remove);
    }
  } catch (error) {
    removeConfiguredInstrumentation({ nativeBridge, removers });
    throw error;
  }

  let removed = false;
  const remove = () => {
    if (removed) {
      return;
    }
    removed = true;
    removeConfiguredInstrumentation({ nativeBridge, removers });
  };

  const handle = {
    globalFetch,
    globalXMLHttpRequest,
    remove,
    resourceFetch,
    stop: remove,
    syncNativeBridgeScope(options = {}) {
      if (!nativeBridge) {
        return undefined;
      }
      return syncLogBrewNativeBridgeScope(nativeBridge, {
        logger,
        metadata,
        screen,
        sessionId,
        source: "react-native.instrumentation",
        trace: activeTrace,
        ...options
      });
    },
    trace: activeTrace,
    withNativeBridgeScope(callbackOrOptions, maybeCallback) {
      if (!nativeBridge) {
        throw new SdkError("configuration_error", "withNativeBridgeScope requires nativeBridge");
      }
      if (typeof callbackOrOptions === "function") {
        return withLogBrewNativeBridgeScope(nativeBridge, {
          logger,
          metadata,
          screen,
          sessionId,
          source: "react-native.instrumentation",
          trace: activeTrace
        }, callbackOrOptions);
      }
      return withLogBrewNativeBridgeScope(nativeBridge, {
        logger,
        metadata,
        screen,
        sessionId,
        source: "react-native.instrumentation",
        trace: activeTrace,
        ...(callbackOrOptions ?? {})
      }, maybeCallback);
    }
  };
  return Object.freeze(handle);
}

function resolveInstrumentationTrace({ randomValues, trace, traceFlags }) {
  if (typeof trace === "string") {
    return createReactNativeTraceContext({ randomValues, traceFlags, traceparent: trace });
  }
  return trace ?? getActiveLogBrewTrace() ?? createReactNativeTraceContext({ randomValues, traceFlags });
}

function requireClient(client) {
  if (!client) {
    throw new SdkError("configuration_error", "createLogBrewReactNativeInstrumentation requires a client");
  }
}

function removeConfiguredInstrumentation({ nativeBridge, removers }) {
  if (nativeBridge) {
    clearLogBrewNativeBridgeScope(nativeBridge);
  }
  for (const removeListener of removers.splice(0).reverse()) {
    removeListener();
  }
}

function installGlobalFetchInstrumentation(client, {
  appState,
  globalObject,
  metadata,
  metadataFactory,
  now,
  nowMs,
  platform,
  randomValues,
  routeTemplate,
  routeTemplateFactory,
  screen,
  sessionId,
  trace,
  traceFlags,
  tracePropagationTargets
}) {
  if ((typeof globalObject !== "object" && typeof globalObject !== "function") || globalObject === null) {
    throw new SdkError("configuration_error", "instrumentGlobalFetch requires a globalObject");
  }
  const originalFetch = globalObject.fetch;
  if (typeof originalFetch !== "function") {
    throw new SdkError("configuration_error", "instrumentGlobalFetch requires globalObject.fetch");
  }
  const globalResourceFetch = createReactNativeResourceFetch(client, {
    appState,
    fetchImpl: (input, init) => originalFetch.call(globalObject, input, init),
    metadata,
    metadataFactory,
    now,
    nowMs,
    platform,
    randomValues,
    routeTemplate,
    routeTemplateFactory,
    screen,
    sessionId,
    trace,
    traceFlags,
    tracePropagationTargets
  });
  let removed = false;
  const wrappedFetch = (input, init) => globalResourceFetch(input, init);
  try {
    globalObject.fetch = wrappedFetch;
  } catch {
    throw new SdkError("configuration_error", "instrumentGlobalFetch could not patch globalObject.fetch");
  }
  if (globalObject.fetch !== wrappedFetch) {
    throw new SdkError("configuration_error", "instrumentGlobalFetch could not patch globalObject.fetch");
  }
  const remove = () => {
    if (removed) {
      return;
    }
    removed = true;
    if (globalObject.fetch === wrappedFetch) {
      globalObject.fetch = originalFetch;
    }
  };
  return Object.freeze({
    fetch: wrappedFetch,
    remove,
    stop: remove
  });
}

/* eslint-disable no-invalid-this */
function installGlobalXMLHttpRequestInstrumentation(client, {
  appState,
  globalObject,
  measureXhrResponseBodySize,
  metadata,
  metadataFactory,
  now,
  nowMs,
  platform,
  routeTemplate,
  routeTemplateFactory,
  screen,
  sessionId,
  trace,
  tracePropagationTargets
}) {
  if ((typeof globalObject !== "object" && typeof globalObject !== "function") || globalObject === null) {
    throw new SdkError("configuration_error", "instrumentGlobalXMLHttpRequest requires a globalObject");
  }
  const xhrType = globalObject.XMLHttpRequest;
  if (typeof xhrType !== "function" || !xhrType.prototype) {
    throw new SdkError("configuration_error", "instrumentGlobalXMLHttpRequest requires globalObject.XMLHttpRequest");
  }
  const prototype = xhrType.prototype;
  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  const originalSetRequestHeader = prototype.setRequestHeader;
  if (typeof originalOpen !== "function" || typeof originalSend !== "function" || typeof originalSetRequestHeader !== "function") {
    throw new SdkError("configuration_error", "instrumentGlobalXMLHttpRequest requires open, send, and setRequestHeader");
  }

  const contextKey = Symbol("logbrew.xhr");
  const headersReceivedState = typeof xhrType.HEADERS_RECEIVED === "number" ? xhrType.HEADERS_RECEIVED : 2;
  const doneState = typeof xhrType.DONE === "number" ? xhrType.DONE : 4;
  const safeRouteTemplateFactory = routeTemplateFactory ?? defaultXhrRouteTemplateFactory;

  function wrappedOpen(method, url) {
    this[contextKey] = {
      method: normalizeXhrMethod(method),
      reported: false,
      url: xhrUrl(url)
    };
    return originalOpen.apply(this, arguments);
  }

  function wrappedSend(body) {
    const context = this[contextKey];
    if (!context) {
      return originalSend.apply(this, arguments);
    }
    context.body = xhrRequestBody(body);
    context.startedAtMs = nowMs();
    context.timestamp = now();
    installXhrReadyStateTracker(this, context, {
      appState,
      client,
      doneState,
      headersReceivedState,
      measureXhrResponseBodySize,
      metadata,
      metadataFactory,
      nowMs,
      platform,
      routeTemplate,
      routeTemplateFactory: safeRouteTemplateFactory,
      screen,
      sessionId,
      trace
    });
    if (shouldPropagateTraceparent(context.url, tracePropagationTargets)) {
      originalSetRequestHeader.call(this, "traceparent", createReactNativeTraceHeaders(trace).traceparent);
    }
    try {
      return originalSend.apply(this, arguments);
    } catch (error) {
      captureXhrResourceSpan(this, context, {
        appState,
        client,
        metadata: {
          ...metadata,
          xhrErrorName: errorName(error),
          xhrErrorValueType: typeof error
        },
        metadataFactory,
        nowMs,
        platform,
        routeTemplate,
        routeTemplateFactory: safeRouteTemplateFactory,
        screen,
        sessionId,
        status: "error",
        trace
      });
      throw error;
    }
  }

  prototype.open = wrappedOpen;
  prototype.send = wrappedSend;
  if (prototype.open !== wrappedOpen || prototype.send !== wrappedSend) {
    throw new SdkError("configuration_error", "instrumentGlobalXMLHttpRequest could not patch XMLHttpRequest");
  }

  let removed = false;
  const remove = () => {
    if (removed) {
      return;
    }
    removed = true;
    if (prototype.open === wrappedOpen) {
      prototype.open = originalOpen;
    }
    if (prototype.send === wrappedSend) {
      prototype.send = originalSend;
    }
  };

  return Object.freeze({
    remove,
    stop: remove
  });
}

function installXhrReadyStateTracker(xhr, context, options) {
  const onReadyStateChange = () => {
    if (xhr.readyState === options.headersReceivedState && context.responseStartAtMs === undefined) {
      context.responseStartAtMs = options.nowMs();
      return;
    }
    if (xhr.readyState === options.doneState && !context.reported) {
      captureXhrResourceSpan(xhr, context, options);
    }
  };
  if (typeof xhr.addEventListener === "function") {
    xhr.addEventListener("readystatechange", onReadyStateChange);
    return;
  }
  const originalOnReadyStateChange = xhr.onreadystatechange;
  xhr.onreadystatechange = function logBrewOnReadyStateChange() {
    onReadyStateChange();
    if (typeof originalOnReadyStateChange === "function") {
      return originalOnReadyStateChange.apply(this, arguments);
    }
    return undefined;
  };
}

function captureXhrResourceSpan(xhr, context, {
  appState,
  client,
  measureXhrResponseBodySize,
  metadata,
  metadataFactory,
  nowMs,
  platform,
  routeTemplate,
  routeTemplateFactory,
  screen,
  sessionId,
  status,
  trace
}) {
  if (context.reported) {
    return;
  }
  context.reported = true;
  const durationMs = elapsedMs(context.startedAtMs, nowMs);
  const responseStartDurationMs = context.responseStartAtMs === undefined
    ? undefined
    : elapsedMs(context.startedAtMs, () => context.responseStartAtMs);
  const responseSizeBytes = xhrResponseSizeBytes(xhr, { measureXhrResponseBodySize });
  const safeRouteTemplate = routeTemplate ?? routeTemplateFactory({ url: context.url });
  const statusCode = xhrStatusCode(xhr);
  captureReactNativeResourceSpan(client, {
    appState,
    durationMs,
    metadata: {
      ...createSafeReactNativeMetadata(metadata, metadataFactory, {
        durationMs,
        init: context.body === undefined ? undefined : { body: context.body },
        input: context.url,
        method: context.method,
        routeTemplate: safeRouteTemplate,
        status: status ?? undefined,
        statusCode,
        url: context.url
      }),
      responseStartDurationMs,
      transport: "xhr"
    },
    method: context.method,
    platform,
    routeTemplate: safeRouteTemplate,
    screen,
    responseSizeBytes,
    sessionId,
    status: status ?? undefined,
    statusCode,
    timestamp: context.timestamp,
    trace
  });
}

function normalizeXhrMethod(method) {
  return String(method ?? "GET").toUpperCase();
}

function xhrUrl(url) {
  if (typeof url === "string") {
    return url;
  }
  try {
    return url.toString();
  } catch {
    return String(url);
  }
}

function xhrRequestBody(body) {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof String) {
    return body.toString();
  }
  return undefined;
}

function defaultXhrRouteTemplateFactory({ url }) {
  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor === "function") {
    try {
      const parsedUrl = new URLConstructor(url, "https://logbrew.local");
      return parsedUrl.pathname;
    } catch {
      // Fall back to query/hash stripping below for non-standard request keys.
    }
  }
  return String(url).split(/[?#]/u, 1)[0];
}

function elapsedMs(startedAtMs, nowMs) {
  const durationMs = nowMs() - startedAtMs;
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : undefined;
}

function xhrStatusCode(xhr) {
  return typeof xhr?.status === "number" && Number.isFinite(xhr.status) ? xhr.status : undefined;
}

function xhrResponseSizeBytes(xhr, { measureXhrResponseBodySize = false } = {}) {
  if (typeof xhr?.getResponseHeader !== "function") {
    return measureXhrResponseBodySize ? xhrResponseBodySizeBytes(xhr) : undefined;
  }
  const contentLength = Number.parseInt(String(xhr.getResponseHeader("Content-Length") ?? ""), 10);
  if (Number.isFinite(contentLength) && contentLength >= 0) {
    return contentLength;
  }
  return measureXhrResponseBodySize ? xhrResponseBodySizeBytes(xhr) : undefined;
}

function xhrResponseBodySizeBytes(xhr) {
  const responseType = readXhrResponseValue(xhr, "responseType");
  if (responseType === undefined || responseType === "" || responseType === "text") {
    const responseText = readXhrResponseValue(xhr, "responseText");
    if (typeof responseText === "string" || responseText instanceof String) {
      return utf8ByteLength(responseText.toString());
    }
  }
  const response = readXhrResponseValue(xhr, "response");
  if (typeof response === "string" || response instanceof String) {
    return utf8ByteLength(response.toString());
  }
  if (typeof ArrayBuffer === "function") {
    if (response instanceof ArrayBuffer) {
      return response.byteLength;
    }
    if (typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(response)) {
      return response.byteLength;
    }
  }
  if (typeof response?.size === "number" && Number.isFinite(response.size) && response.size >= 0) {
    return response.size;
  }
  return undefined;
}

function readXhrResponseValue(xhr, property) {
  try {
    return xhr?.[property];
  } catch {
    return undefined;
  }
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function errorName(error) {
  return typeof error?.name === "string" && error.name.trim() !== "" ? error.name : "Error";
}
/* eslint-enable no-invalid-this */

module.exports = {
  createLogBrewReactNativeInstrumentation,
  default: {
    createLogBrewReactNativeInstrumentation
  }
};
