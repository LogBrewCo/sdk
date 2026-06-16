import React from "react";
import {
  createTraceparent,
  LogBrewClient,
  parseTraceparent,
  SdkError
} from "@logbrew/sdk";

const DEFAULT_SDK_NAME = "logbrew-react-native";
const DEFAULT_SDK_VERSION = "0.1.0";
const LogBrewNativeContext = React.createContext(null);
const activeTraceScopes = [];
let nextTraceScopeId = 0;

export function createLogBrewReactNativeClient({
  apiKey,
  clientKey,
  sdkName = DEFAULT_SDK_NAME,
  sdkVersion = DEFAULT_SDK_VERSION,
  maxRetries = 2
}) {
  const authKey = clientKey ?? apiKey;
  if (!authKey) {
    throw new SdkError("configuration_error", "createLogBrewReactNativeClient requires clientKey or apiKey");
  }
  return LogBrewClient.create({ apiKey: authKey, sdkName, sdkVersion, maxRetries });
}

export function createReactNativeTraceparent({ randomValues = defaultRandomValues, spanId, traceFlags = "01", traceId } = {}) {
  return createTraceparent({
    spanId: spanId ?? randomHex(8, randomValues),
    traceFlags,
    traceId: traceId ?? randomHex(16, randomValues)
  });
}

export function createReactNativeTraceContext({
  parentSpanId, randomValues = defaultRandomValues, spanId, traceFlags = "01", traceId, traceparent
} = {}) {
  if (traceparent !== undefined && traceparent !== null && String(traceparent).trim() !== "") {
    try {
      const parsed = parseTraceparent(traceparent);
      const localSpanId = spanId ?? randomHex(8, randomValues);
      createTraceparent({ traceId: parsed.traceId, spanId: localSpanId, traceFlags: parsed.traceFlags });
      return freezeTraceContext({
        parentSpanId: parsed.parentSpanId,
        sampled: parsed.sampled,
        spanId: localSpanId,
        traceFlags: parsed.traceFlags,
        traceId: parsed.traceId
      });
    } catch {
      // Bad upstream propagation should not break mobile app flows.
    }
  }

  const localTraceId = traceId ?? randomHex(16, randomValues);
  const localSpanId = spanId ?? randomHex(8, randomValues);
  createTraceparent({ traceId: localTraceId, spanId: localSpanId, traceFlags });
  if (parentSpanId !== undefined) {
    createTraceparent({ traceId: localTraceId, spanId: parentSpanId, traceFlags });
  }
  return freezeTraceContext({
    parentSpanId,
    sampled: sampledFromTraceFlags(traceFlags),
    spanId: localSpanId,
    traceFlags,
    traceId: localTraceId
  });
}

export function getActiveLogBrewTrace() {
  return activeTraceScopes.length === 0 ? undefined : activeTraceScopes[activeTraceScopes.length - 1].trace;
}

export function withLogBrewTrace(trace, callback) {
  if (typeof callback !== "function") {
    throw new SdkError("configuration_error", "withLogBrewTrace requires a callback");
  }
  const context = resolveTraceContext(trace) ?? createReactNativeTraceContext();
  const scope = {
    id: ++nextTraceScopeId,
    trace: context
  };
  activeTraceScopes.push(scope);
  try {
    return callback(context);
  } finally {
    removeActiveTraceScope(scope.id);
  }
}

export function bindLogBrewTrace(trace, callback) {
  if (typeof callback !== "function") {
    throw new SdkError("configuration_error", "bindLogBrewTrace requires a callback");
  }
  const context = resolveTraceContext(trace) ?? createReactNativeTraceContext();
  return function logBrewTracedCallback(...args) {
    return withLogBrewTrace(context, () => callback(...args));
  };
}

export function getReactNativeTraceMetadata(trace = getActiveLogBrewTrace()) {
  const context = resolveTraceContext(trace);
  if (!context) {
    return {};
  }
  return compactMetadata({
    parentSpanId: context.parentSpanId,
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    traceId: context.traceId,
    traceSampled: context.sampled
  });
}

export function createReactNativeSpanAttributes({
  durationMs,
  metadata = {},
  name,
  spanId,
  status = "ok",
  trace = getActiveLogBrewTrace()
} = {}) {
  const context = resolveTraceContext(trace) ?? createReactNativeTraceContext();
  return {
    name,
    traceId: context.traceId,
    spanId: spanId ?? context.spanId,
    status,
    durationMs,
    metadata: compactMetadata({
      ...metadata,
      ...getReactNativeTraceMetadata(context)
    })
  };
}

export function createReactNativeTraceHeaders(trace = getActiveLogBrewTrace()) {
  const context = resolveTraceContext(trace) ?? createReactNativeTraceContext();
  return {
    traceparent: createTraceparent({
      traceFlags: context.traceFlags,
      traceId: context.traceId,
      spanId: context.spanId
    })
  };
}

export function createTraceparentFetch({
  fetchImpl = defaultFetch(),
  randomValues = defaultRandomValues,
  trace,
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
    const nextTraceparent = traceparentForRequest({ init, input, randomValues, trace, traceFlags, traceparent, traceparentFactory, url });
    const nextInit = {
      ...requestInit,
      headers: headersWithTraceparent(requestHeaders(input, requestInit), nextTraceparent)
    };
    return fetchImpl(input, nextInit);
  };
}

export function shouldPropagateTraceparent(url, tracePropagationTargets = []) {
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

export function getReactNativeContext({ platform, appState, metadata = {} } = {}) {
  return {
    platform: platform?.OS ?? "unknown",
    platformVersion: normalizeMetadataValue(platform?.Version),
    appState: normalizeMetadataValue(appState?.currentState),
    isPad: normalizeMetadataValue(platform?.isPad),
    isTesting: normalizeMetadataValue(platform?.constants?.isTesting),
    ...metadata
  };
}

export function captureScreenView(client, screenName, {
  id = `evt_screen_${slugify(screenName)}`,
  timestamp = new Date().toISOString(),
  status = "success",
  platform,
  appState,
  trace,
  metadata = {}
} = {}) {
  requireClient(client);
  requireNonEmpty("screen name", screenName);
  client.action(id, timestamp, {
    name: `screen:${screenName}`,
    status,
    metadata: {
      ...getReactNativeContext({ platform, appState }),
      screen: screenName,
      ...metadata,
      ...getReactNativeTraceMetadata(trace ?? getActiveLogBrewTrace())
    }
  });
}

export function captureAppStateChange(client, state, {
  id = `evt_app_state_${slugify(state)}`,
  timestamp = new Date().toISOString(),
  platform,
  appState,
  trace,
  metadata = {}
} = {}) {
  requireClient(client);
  requireNonEmpty("app state", state);
  client.action(id, timestamp, {
    name: "app_state_change",
    status: "success",
    metadata: {
      ...getReactNativeContext({ platform, appState }),
      appState: state,
      ...metadata,
      ...getReactNativeTraceMetadata(trace ?? getActiveLogBrewTrace())
    }
  });
}

export function createReactNativeActionEvent({
  id,
  idFactory = defaultActionEventId,
  metadata = {},
  name,
  now = () => new Date().toISOString(),
  platform,
  appState,
  screen,
  sessionId,
  status = "success",
  timestamp,
  trace,
  traceId
} = {}) {
  return {
    id: id ?? idFactory({ name, screen }),
    timestamp: timestamp ?? now(),
    attributes: {
      name,
      status,
      metadata: compactMetadata({
        ...getReactNativeContext({ platform, appState }),
        source: "react-native.action",
        screen,
        sessionId,
        traceId,
        ...metadata,
        ...getReactNativeTraceMetadata(trace ?? getActiveLogBrewTrace())
      })
    }
  };
}

export function captureReactNativeAction(client, input = {}) {
  requireClient(client);
  const event = createReactNativeActionEvent(input);
  client.action(event.id, event.timestamp, event.attributes);
  return event;
}

export function createReactNativeNetworkEvent({
  durationMs,
  id,
  idFactory = defaultNetworkEventId,
  metadata = {},
  method,
  name,
  now = () => new Date().toISOString(),
  platform,
  appState,
  routeTemplate,
  screen,
  sessionId,
  status,
  statusCode,
  timestamp,
  trace,
  traceId
} = {}) {
  const safeRouteTemplate = stripQueryAndHash(routeTemplate);
  const safeMethod = method === undefined ? undefined : String(method).toUpperCase();
  const actionName = name ?? [safeMethod, safeRouteTemplate].filter(Boolean).join(" ");
  return {
    id: id ?? idFactory({ method: safeMethod, routeTemplate: safeRouteTemplate, screen }),
    timestamp: timestamp ?? now(),
    attributes: {
      name: actionName,
      status: status ?? statusFromStatusCode(statusCode),
      metadata: compactMetadata({
        ...getReactNativeContext({ platform, appState }),
        source: "react-native.network",
        durationMs,
        method: safeMethod,
        routeTemplate: safeRouteTemplate,
        screen,
        sessionId,
        statusCode,
        traceId,
        ...metadata,
        ...getReactNativeTraceMetadata(trace ?? getActiveLogBrewTrace())
      })
    }
  };
}

export function captureReactNativeNetwork(client, input = {}) {
  requireClient(client);
  const event = createReactNativeNetworkEvent(input);
  client.action(event.id, event.timestamp, event.attributes);
  return event;
}

export function createReactNativeNavigationSpanEvent({
  actionType, durationMs, id, idFactory = defaultNavigationSpanEventId, includeRouteKey = false, metadata = {},
  name, now = () => new Date().toISOString(), platform, appState, previousRouteKey, previousRouteName,
  routeKey, routeName, routePath, screen, status = "ok", timestamp, trace
} = {}) {
  const safeRoutePath = stripQueryAndHash(routePath);
  const spanName = name ?? `navigation:${routeName ?? safeRoutePath ?? screen ?? "route"}`;
  const context = resolveTraceContext(trace) ?? getActiveLogBrewTrace() ?? createReactNativeTraceContext();
  return {
    id: id ?? idFactory({ routeName, routePath: safeRoutePath, screen }),
    timestamp: timestamp ?? now(),
    attributes: createReactNativeSpanAttributes({
      name: spanName,
      status,
      durationMs,
      trace: context,
      metadata: {
        ...getReactNativeContext({ platform, appState }),
        source: "react-native.navigation",
        actionType,
        previousRouteName,
        routeName,
        routePath: safeRoutePath,
        screen: screen ?? routeName,
        ...(includeRouteKey ? { previousRouteKey, routeKey } : {}),
        ...metadata
      }
    })
  };
}

export function captureReactNativeNavigationSpan(client, input = {}) {
  requireClient(client);
  const event = createReactNativeNavigationSpanEvent(input);
  client.span(event.id, event.timestamp, event.attributes);
  return event;
}

export function createReactNativeResourceSpanEvent({
  durationMs, id, idFactory = defaultResourceSpanEventId, kind = "fetch", metadata = {}, method, name,
  now = () => new Date().toISOString(), platform, appState, responseSizeBytes, routeTemplate, screen,
  sessionId, status, statusCode, timestamp, trace
} = {}) {
  const safeRouteTemplate = stripQueryAndHash(routeTemplate);
  const safeMethod = method === undefined ? undefined : String(method).toUpperCase();
  const defaultName = [safeMethod, safeRouteTemplate].filter(Boolean).join(" ");
  const spanName = name ?? (defaultName || "mobile.resource");
  const context = resolveTraceContext(trace) ?? getActiveLogBrewTrace() ?? createReactNativeTraceContext();
  return {
    id: id ?? idFactory({ method: safeMethod, routeTemplate: safeRouteTemplate, screen }),
    timestamp: timestamp ?? now(),
    attributes: createReactNativeSpanAttributes({
      name: spanName,
      status: status ?? spanStatusFromStatusCode(statusCode),
      durationMs,
      trace: context,
      metadata: {
        ...getReactNativeContext({ platform, appState }),
        source: "react-native.resource",
        durationMs,
        method: safeMethod,
        resourceKind: kind,
        responseSizeBytes,
        routeTemplate: safeRouteTemplate,
        screen,
        sessionId,
        statusCode,
        ...metadata
      }
    })
  };
}

export function captureReactNativeResourceSpan(client, input = {}) {
  requireClient(client);
  const event = createReactNativeResourceSpanEvent(input);
  client.span(event.id, event.timestamp, event.attributes);
  return event;
}

export function createReactNavigationSpanListener(client, navigationContainer, {
  captureInitialRoute = false, includeRouteKey = false, metadata = {}, now = () => new Date().toISOString(),
  nowMs = () => Date.now(), onError, platform, appState, trace
} = {}) {
  requireClient(client);
  const container = resolveNavigationContainer(navigationContainer);
  if (!container || typeof container.addListener !== "function" || typeof container.getCurrentRoute !== "function") {
    throw new SdkError("configuration_error", "createReactNavigationSpanListener requires a React Navigation container ref with addListener and getCurrentRoute");
  }

  let previousRoute = captureInitialRoute ? {} : routeSnapshot(container.getCurrentRoute());
  let pendingNavigation;
  const removers = [];
  const captureCurrentRoute = () => {
    try {
      const route = routeSnapshot(container.getCurrentRoute());
      if (!route.name && !route.path) {
        return;
      }
      const startedAtMs = pendingNavigation?.startedAtMs;
      const durationMs = startedAtMs === undefined ? undefined : Math.max(0, nowMs() - startedAtMs);
      captureReactNativeNavigationSpan(client, {
        actionType: pendingNavigation?.actionType, durationMs, includeRouteKey, metadata, now, platform, appState,
        previousRouteKey: previousRoute.key, previousRouteName: previousRoute.name, routeKey: route.key,
        routeName: route.name, routePath: route.path, timestamp: pendingNavigation?.timestamp, trace
      });
      previousRoute = route;
      pendingNavigation = undefined;
    } catch (error) {
      if (typeof onError === "function") {
        onError(error);
      } else {
        throw error;
      }
    }
  };

  const actionSubscription = safeNavigationListener(container, "__unsafe_action__", (event) => {
    pendingNavigation = {
      actionType: navigationActionType(event),
      startedAtMs: nowMs(),
      timestamp: now()
    };
  });
  if (actionSubscription) {
    removers.push(actionSubscription);
  }
  removers.push(addNavigationListener(container, "state", captureCurrentRoute));

  if (captureInitialRoute) {
    captureCurrentRoute();
  }

  return () => {
    for (const remove of removers.splice(0).reverse()) {
      remove();
    }
  };
}

export function createReactNativeErrorEvent(error, {
  id,
  idFactory = defaultErrorEventId,
  includeStack = false,
  level = "error",
  metadata = {},
  now = () => new Date().toISOString(),
  platform,
  appState,
  screen,
  timestamp,
  trace
} = {}) {
  const details = errorDetails(error, includeStack);
  const eventMetadata = compactMetadata({
    ...getReactNativeContext({ platform, appState }),
    errorName: details.name,
    errorValueType: details.valueType,
    source: "react-native.error",
    screen,
    ...(includeStack ? { errorStack: details.stack } : {}),
    ...metadata,
    ...getReactNativeTraceMetadata(trace ?? getActiveLogBrewTrace())
  });
  return {
    id: id ?? idFactory({ error, message: details.message, screen }),
    timestamp: timestamp ?? now(),
    attributes: {
      title: `React Native error: ${details.message}`,
      level,
      message: details.message,
      metadata: eventMetadata
    }
  };
}

export function captureReactNativeError(client, error, options = {}) {
  requireClient(client);
  const event = createReactNativeErrorEvent(error, options);
  client.issue(event.id, event.timestamp, event.attributes);
  return event;
}

export function createAppStateListener(client, appState, options = {}) {
  requireClient(client);
  if (!appState || typeof appState.addEventListener !== "function") {
    throw new SdkError("configuration_error", "createAppStateListener requires AppState.addEventListener");
  }

  const subscription = appState.addEventListener("change", (nextState) => {
    captureAppStateChange(client, nextState, {
      ...options,
      appState
    });
  });

  if (typeof subscription === "function") {
    return subscription;
  }
  if (subscription && typeof subscription.remove === "function") {
    return () => subscription.remove();
  }
  return () => {};
}

export function LogBrewNativeProvider({ client, platform, appState, trace, children }) {
  requireClient(client);
  const value = React.useMemo(() => ({
    client,
    platform,
    appState,
    trace: resolveTraceContext(trace)
  }), [appState, client, platform, trace]);
  return React.createElement(LogBrewNativeContext.Provider, { value }, children);
}

export function useLogBrewNative() {
  const value = React.useContext(LogBrewNativeContext);
  if (!value?.client) {
    throw new SdkError("configuration_error", "useLogBrewNative must be used inside LogBrewNativeProvider");
  }
  return value;
}

export function useLogBrewNativeActions() {
  const { client, platform, appState, trace } = useLogBrewNative();
  const scoped = (options = {}) => ({ platform, appState, trace, ...options });
  return {
    release: client.release.bind(client),
    environment: client.environment.bind(client),
    issue: (id, timestamp, attributes) => client.issue(id, timestamp, attributesWithTrace(attributes, trace)),
    log: (id, timestamp, attributes) => client.log(id, timestamp, attributesWithTrace(attributes, trace)),
    span: client.span.bind(client),
    action: (id, timestamp, attributes) => client.action(id, timestamp, attributesWithTrace(attributes, trace)),
    flush: client.flush.bind(client),
    shutdown: client.shutdown.bind(client),
    previewJson: client.previewJson.bind(client),
    pendingEvents: client.pendingEvents.bind(client),
    trace,
    captureScreenView: (screenName, options = {}) => captureScreenView(client, screenName, scoped(options)),
    captureAppStateChange: (state, options = {}) => captureAppStateChange(client, state, scoped(options)),
    captureReactNativeAction: (input = {}) => captureReactNativeAction(client, scoped(input)),
    captureReactNativeNetwork: (input = {}) => captureReactNativeNetwork(client, scoped(input)),
    captureReactNativeNavigationSpan: (input = {}) => captureReactNativeNavigationSpan(client, scoped(input)),
    captureReactNativeResourceSpan: (input = {}) => captureReactNativeResourceSpan(client, scoped(input)),
    captureReactNativeError: (error, options = {}) => captureReactNativeError(client, error, scoped(options))
  };
}

function requireClient(client) {
  if (!client) {
    throw new SdkError("configuration_error", "LogBrew React Native helpers require a client");
  }
}

function requireNonEmpty(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SdkError("validation_error", `${label} must be non-empty`);
  }
}

function normalizeMetadataValue(value) {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return String(value);
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

function attributesWithTrace(attributes, trace) {
  const context = resolveTraceContext(trace) ?? getActiveLogBrewTrace();
  if (!context) {
    return attributes;
  }
  return {
    ...attributes,
    metadata: compactMetadata({
      ...(attributes?.metadata ?? {}),
      ...getReactNativeTraceMetadata(context)
    })
  };
}

function errorDetails(error, includeStack) {
  const candidate = error?.reason ?? error?.error ?? error;
  const message = errorMessage(candidate);
  return {
    message,
    name: errorName(candidate),
    stack: includeStack && typeof candidate?.stack === "string" ? candidate.stack : undefined,
    valueType: candidate === null ? "null" : typeof candidate
  };
}

function errorName(error) {
  if (error instanceof Error && typeof error.name === "string" && error.name.trim() !== "") {
    return error.name;
  }
  if (typeof error?.name === "string" && error.name.trim() !== "") {
    return error.name;
  }
  return undefined;
}

function errorMessage(error) {
  if (error instanceof Error && typeof error.message === "string" && error.message.trim() !== "") {
    return error.message;
  }
  if (typeof error?.message === "string" && error.message.trim() !== "") {
    return error.message;
  }
  if (typeof error === "string" && error.trim() !== "") {
    return error;
  }
  return String(error ?? "unknown error");
}

function defaultErrorEventId({ message, screen }) {
  return `evt_native_error_${slugify(`${screen ?? "app"}_${message}`)}`;
}

function defaultActionEventId({ name, screen }) {
  return `evt_native_action_${slugify(`${screen ?? "app"}_${name ?? "event"}`)}`;
}

function defaultNetworkEventId({ method, routeTemplate, screen }) {
  return `evt_native_network_${slugify([screen, method, routeTemplate].filter(Boolean).join("_") || "request")}`;
}

function defaultNavigationSpanEventId({ routeName, routePath, screen }) {
  return `evt_native_navigation_${slugify([screen, routeName, routePath].filter(Boolean).join("_") || "route")}`;
}

function defaultResourceSpanEventId({ method, routeTemplate, screen }) {
  return `evt_native_resource_${slugify([screen, method, routeTemplate].filter(Boolean).join("_") || "request")}`;
}

function defaultFetch() {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
}

function defaultRandomValues(length) {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new SdkError("configuration_error", "createReactNativeTraceparent requires crypto.getRandomValues or randomValues");
  }
  const bytes = new Uint8Array(length);
  return globalThis.crypto.getRandomValues(bytes);
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
  if (typeof headers !== "string" && typeof headers[Symbol.iterator] === "function") {
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

function resolveTraceContext(trace) {
  if (trace === undefined || trace === null) {
    return undefined;
  }
  if (typeof trace === "string") {
    return createReactNativeTraceContext({ traceparent: trace });
  }
  if (typeof trace === "object") {
    const {
      parentSpanId,
      sampled,
      spanId,
      traceFlags = "01",
      traceId
    } = trace;
    if (typeof traceId !== "string" || typeof spanId !== "string") {
      throw new SdkError("validation_error", "trace context requires traceId and spanId");
    }
    createTraceparent({ traceId, spanId, traceFlags });
    if (parentSpanId !== undefined) {
      createTraceparent({ traceId, spanId: parentSpanId, traceFlags });
    }
    return freezeTraceContext({
      parentSpanId,
      sampled: sampled ?? sampledFromTraceFlags(traceFlags),
      spanId,
      traceFlags,
      traceId
    });
  }
  throw new SdkError("validation_error", "trace must be a trace context or traceparent string");
}

function freezeTraceContext({ parentSpanId, sampled, spanId, traceFlags, traceId }) {
  const normalized = {
    traceId: String(traceId).toLowerCase(),
    spanId: String(spanId).toLowerCase(),
    parentSpanId: parentSpanId === undefined ? undefined : String(parentSpanId).toLowerCase(),
    traceFlags: String(traceFlags).toLowerCase(),
    sampled: Boolean(sampled)
  };
  return Object.freeze(normalized);
}

function sampledFromTraceFlags(traceFlags) {
  return (Number.parseInt(traceFlags, 16) & 1) === 1;
}

function removeActiveTraceScope(scopeId) {
  const index = activeTraceScopes.findIndex((scope) => scope.id === scopeId);
  if (index >= 0) {
    activeTraceScopes.splice(index, 1);
  }
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
  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor === "function" && input instanceof URLConstructor) {
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

function statusFromStatusCode(statusCode) {
  if (typeof statusCode === "number" && Number.isFinite(statusCode) && statusCode >= 400) {
    return "failure";
  }
  return "success";
}

function spanStatusFromStatusCode(statusCode) {
  if (typeof statusCode === "number" && Number.isFinite(statusCode) && statusCode >= 400) {
    return "error";
  }
  return "ok";
}

function stripQueryAndHash(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value).split(/[?#]/u, 1)[0];
}

function resolveNavigationContainer(navigationContainer) {
  if (navigationContainer && typeof navigationContainer === "object" && "current" in navigationContainer) {
    return navigationContainer.current;
  }
  return navigationContainer;
}

function addNavigationListener(container, eventName, listener) {
  const subscription = container.addListener(eventName, listener);
  if (typeof subscription === "function") {
    return subscription;
  }
  if (subscription && typeof subscription.remove === "function") {
    return () => subscription.remove();
  }
  return () => {};
}

function safeNavigationListener(container, eventName, listener) {
  try {
    return addNavigationListener(container, eventName, listener);
  } catch {
    return undefined;
  }
}

function routeSnapshot(route) {
  return {
    key: normalizeMetadataValue(route?.key),
    name: typeof route?.name === "string" && route.name.trim() !== "" ? route.name : undefined,
    path: stripQueryAndHash(route?.path)
  };
}

function navigationActionType(event) {
  const action = event?.data?.action ?? event?.action ?? event;
  return typeof action?.type === "string" && action.type.trim() !== "" ? action.type : undefined;
}

function traceparentForRequest({
  init, input, randomValues, trace, traceFlags, traceparent, traceparentFactory, url
}) {
  const context = resolveTraceContext(trace) ?? getActiveLogBrewTrace();
  const nextTraceparent = typeof traceparentFactory === "function"
    ? traceparentFactory({ init, input, url })
    : traceparent ?? (context ? createReactNativeTraceHeaders(context).traceparent : createReactNativeTraceparent({ randomValues, traceFlags }));
  parseTraceparent(nextTraceparent);
  return nextTraceparent;
}

export default {
  LogBrewNativeProvider, captureAppStateChange, captureReactNativeAction, captureReactNativeError,
  captureReactNativeNetwork, captureReactNativeNavigationSpan, captureReactNativeResourceSpan, captureScreenView,
  bindLogBrewTrace, createAppStateListener, createLogBrewReactNativeClient, createReactNavigationSpanListener,
  createReactNativeSpanAttributes, createReactNativeTraceContext, createReactNativeTraceHeaders, createReactNativeActionEvent,
  createReactNativeErrorEvent, createReactNativeNetworkEvent, createReactNativeNavigationSpanEvent,
  createReactNativeResourceSpanEvent, createReactNativeTraceparent, createTraceparentFetch, getActiveLogBrewTrace,
  getReactNativeContext, getReactNativeTraceMetadata, shouldPropagateTraceparent, useLogBrewNative,
  useLogBrewNativeActions, withLogBrewTrace
};
