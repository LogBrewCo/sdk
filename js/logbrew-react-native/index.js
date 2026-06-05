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

export function createReactNativeTraceparent({
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

export function createTraceparentFetch({
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

export function shouldPropagateTraceparent(url, tracePropagationTargets = []) {
  if (!Array.isArray(tracePropagationTargets)) {
    throw new SdkError("configuration_error", "tracePropagationTargets must be an array");
  }
  return tracePropagationTargets.some((target) => {
    if (typeof target === "string") {
      return url.includes(target);
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
      ...metadata
    }
  });
}

export function captureAppStateChange(client, state, {
  id = `evt_app_state_${slugify(state)}`,
  timestamp = new Date().toISOString(),
  platform,
  appState,
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
      ...metadata
    }
  });
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
  timestamp
} = {}) {
  const details = errorDetails(error, includeStack);
  const eventMetadata = compactMetadata({
    ...getReactNativeContext({ platform, appState }),
    errorName: details.name,
    errorValueType: details.valueType,
    source: "react-native.error",
    screen,
    ...(includeStack ? { errorStack: details.stack } : {}),
    ...metadata
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

export function LogBrewNativeProvider({ client, platform, appState, children }) {
  requireClient(client);
  const value = React.useMemo(() => ({
    client,
    platform,
    appState
  }), [appState, client, platform]);
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
  const { client, platform, appState } = useLogBrewNative();
  return {
    release: client.release.bind(client),
    environment: client.environment.bind(client),
    issue: client.issue.bind(client),
    log: client.log.bind(client),
    span: client.span.bind(client),
    action: client.action.bind(client),
    flush: client.flush.bind(client),
    shutdown: client.shutdown.bind(client),
    previewJson: client.previewJson.bind(client),
    pendingEvents: client.pendingEvents.bind(client),
    captureScreenView: (screenName, options = {}) => captureScreenView(client, screenName, {
      platform,
      appState,
      ...options
    }),
    captureAppStateChange: (state, options = {}) => captureAppStateChange(client, state, {
      platform,
      appState,
      ...options
    }),
    captureReactNativeError: (error, options = {}) => captureReactNativeError(client, error, {
      platform,
      appState,
      ...options
    })
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
  return value
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
    : traceparent ?? createReactNativeTraceparent({ randomValues, traceFlags });
  parseTraceparent(nextTraceparent);
  return nextTraceparent;
}

export default {
  LogBrewNativeProvider,
  captureAppStateChange,
  captureReactNativeError,
  captureScreenView,
  createAppStateListener,
  createLogBrewReactNativeClient,
  createReactNativeErrorEvent,
  createReactNativeTraceparent,
  createTraceparentFetch,
  getReactNativeContext,
  shouldPropagateTraceparent,
  useLogBrewNative,
  useLogBrewNativeActions
};
