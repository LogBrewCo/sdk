import React from "react";
import {
  createTraceparent,
  LogBrewClient,
  parseTraceparent,
  SdkError
} from "@logbrew/sdk";

const LogBrewContext = React.createContext(null);

export function createLogBrewReactClient({
  apiKey,
  clientKey,
  sdkName = "logbrew-react",
  sdkVersion = "0.1.0",
  maxRetries = 2
}) {
  const authKey = clientKey ?? apiKey;
  if (!authKey) {
    throw new SdkError("configuration_error", "createLogBrewReactClient requires clientKey or apiKey");
  }
  return LogBrewClient.create({ apiKey: authKey, sdkName, sdkVersion, maxRetries });
}

export function createReactTraceparent({
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

export function LogBrewProvider({ client, children }) {
  if (!client) {
    throw new SdkError("configuration_error", "LogBrewProvider requires a client");
  }
  return React.createElement(LogBrewContext.Provider, { value: client }, children);
}

export function useLogBrew() {
  const client = React.useContext(LogBrewContext);
  if (!client) {
    throw new SdkError("configuration_error", "useLogBrew must be used inside LogBrewProvider");
  }
  return client;
}

export function useLogBrewActions() {
  const client = useLogBrew();
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
    captureReactError: (error, options = {}) => captureReactError(client, error, options)
  };
}

export function createReactActionEvent({
  id,
  idFactory = defaultActionEventId,
  metadata = {},
  name,
  now = () => new Date().toISOString(),
  sessionId,
  status = "success",
  timestamp,
  traceId
} = {}) {
  return {
    id: id ?? idFactory({ name }),
    timestamp: timestamp ?? now(),
    attributes: {
      name,
      status,
      metadata: compactMetadata({
        source: "react.action",
        sessionId,
        traceId,
        ...metadata
      })
    }
  };
}

export function captureReactAction(client, input = {}) {
  if (!client) {
    throw new SdkError("configuration_error", "captureReactAction requires a client");
  }
  const event = createReactActionEvent(input);
  client.action(event.id, event.timestamp, event.attributes);
  return event;
}

export function useLogBrewAction(defaults = {}) {
  const client = useLogBrew();
  return (input = {}) => captureReactAction(client, mergeEventInput(defaults, input));
}

export function createReactNetworkEvent({
  durationMs,
  id,
  idFactory = defaultNetworkEventId,
  metadata = {},
  method,
  name,
  now = () => new Date().toISOString(),
  routeTemplate,
  sessionId,
  status,
  statusCode,
  timestamp,
  traceId
} = {}) {
  const safeRouteTemplate = stripQueryAndHash(routeTemplate);
  const safeMethod = method === undefined ? undefined : String(method).toUpperCase();
  const actionName = name ?? [safeMethod, safeRouteTemplate].filter(Boolean).join(" ");
  return {
    id: id ?? idFactory({ method: safeMethod, routeTemplate: safeRouteTemplate }),
    timestamp: timestamp ?? now(),
    attributes: {
      name: actionName,
      status: status ?? statusFromStatusCode(statusCode),
      metadata: compactMetadata({
        source: "react.network",
        durationMs,
        method: safeMethod,
        routeTemplate: safeRouteTemplate,
        sessionId,
        statusCode,
        traceId,
        ...metadata
      })
    }
  };
}

export function captureReactNetwork(client, input = {}) {
  if (!client) {
    throw new SdkError("configuration_error", "captureReactNetwork requires a client");
  }
  const event = createReactNetworkEvent(input);
  client.action(event.id, event.timestamp, event.attributes);
  return event;
}

export function useLogBrewNetwork(defaults = {}) {
  const client = useLogBrew();
  return (input = {}) => captureReactNetwork(client, mergeEventInput(defaults, input));
}

export function createReactErrorEvent(error, {
  componentStack,
  id,
  idFactory = defaultErrorEventId,
  includeComponentStack = true,
  includeStack = false,
  level = "error",
  metadata = {},
  now = () => new Date().toISOString(),
  timestamp
} = {}) {
  const details = errorDetails(error, includeStack);
  const eventMetadata = compactMetadata({
    errorName: details.name,
    errorValueType: details.valueType,
    source: "react.error",
    ...(includeComponentStack ? { componentStack } : {}),
    ...(includeStack ? { errorStack: details.stack } : {}),
    ...metadata
  });
  return {
    id: id ?? idFactory({ error, message: details.message }),
    timestamp: timestamp ?? now(),
    attributes: {
      title: `React error: ${details.message}`,
      level,
      message: details.message,
      metadata: eventMetadata
    }
  };
}

export function captureReactError(client, error, options = {}) {
  if (!client) {
    throw new SdkError("configuration_error", "captureReactError requires a client");
  }
  const event = createReactErrorEvent(error, options);
  client.issue(event.id, event.timestamp, event.attributes);
  return event;
}

export class LogBrewErrorBoundary extends React.Component {
  static contextType = LogBrewContext;

  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: "" };
    this.resetError = this.resetError.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    const componentStack = info?.componentStack ?? "";
    this.setState({ componentStack });
    try {
      const event = captureReactError(this.props.client ?? this.context, error, {
        componentStack,
        id: this.props.id,
        idFactory: this.props.idFactory,
        includeComponentStack: this.props.includeComponentStack,
        includeStack: this.props.includeStack,
        level: this.props.level,
        metadata: this.props.metadata,
        now: this.props.now,
        timestamp: this.props.timestamp
      });
      if (typeof this.props.onError === "function") {
        this.props.onError(error, info, event);
      }
    } catch (captureError) {
      if (typeof this.props.onCaptureError === "function") {
        this.props.onCaptureError(captureError);
      }
      if (this.props.raiseCaptureErrors === true) {
        throw captureError;
      }
    }
  }

  resetError() {
    this.setState({ error: null, componentStack: "" });
  }

  render() {
    if (this.state.error) {
      const fallback = this.props.fallback ?? null;
      if (typeof fallback === "function") {
        return fallback({
          componentStack: this.state.componentStack,
          error: this.state.error,
          resetError: this.resetError
        });
      }
      return fallback;
    }
    return this.props.children;
  }
}

function defaultFetch() {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
}

function defaultRandomValues(length) {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new SdkError("configuration_error", "createReactTraceparent requires crypto.getRandomValues or randomValues");
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

function mergeEventInput(defaults, input) {
  return {
    ...defaults,
    ...input,
    metadata: {
      ...(defaults.metadata ?? {}),
      ...(input.metadata ?? {})
    }
  };
}

function errorDetails(error, includeStack) {
  const message = errorMessage(error);
  return {
    message,
    name: errorName(error),
    stack: includeStack && typeof error?.stack === "string" ? error.stack : undefined,
    valueType: error === null ? "null" : typeof error
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

function defaultErrorEventId({ message }) {
  return `evt_react_error_${slugify(message)}`;
}

function defaultActionEventId({ name }) {
  return `evt_react_action_${slugify(name ?? "event")}`;
}

function defaultNetworkEventId({ method, routeTemplate }) {
  return `evt_react_network_${slugify([method, routeTemplate].filter(Boolean).join("_") || "request")}`;
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

function stripQueryAndHash(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value).split(/[?#]/u, 1)[0];
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
    : traceparent ?? createReactTraceparent({ randomValues, traceFlags });
  parseTraceparent(nextTraceparent);
  return nextTraceparent;
}

export default {
  LogBrewErrorBoundary,
  LogBrewProvider,
  captureReactAction,
  captureReactError,
  captureReactNetwork,
  createLogBrewReactClient,
  createReactActionEvent,
  createReactErrorEvent,
  createReactNetworkEvent,
  createReactTraceparent,
  createTraceparentFetch,
  shouldPropagateTraceparent,
  useLogBrew,
  useLogBrewAction,
  useLogBrewActions,
  useLogBrewNetwork
};
