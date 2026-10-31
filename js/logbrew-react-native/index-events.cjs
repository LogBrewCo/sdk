const { SdkError } = require("@logbrew/sdk");
const { productAnalyticsMetadata, recordIssueBreadcrumb, screenActionName } = require("./index-breadcrumbs.cjs");
const { defaultEventId } = require("./index-random.cjs");
const { getActiveLogBrewTrace, getReactNativeTraceMetadata } = require("./index-trace.cjs");
const {
  compactMetadata,
  getReactNativeContext,
  readField,
  requireClient,
  requireNonEmpty,
  statusFromStatusCode,
  stripQueryAndHash,
  subscriptionRemover,
  textOf
} = require("./index-values.cjs");

/**
 * @import { AppStateLike, ClientLike, ContextOptions, LooseRecord } from "./index-values.cjs"
 * @typedef {ContextOptions & { readonly trace?: unknown }} TracedContextOptions
 * @typedef {TracedContextOptions & {
 *   readonly id?: string | undefined,
 *   readonly timestamp?: string | undefined,
 *   readonly status?: unknown
 * }} CaptureScreenViewOptions
 * @typedef {TracedContextOptions & {
 *   readonly id?: string | undefined,
 *   readonly timestamp?: string | undefined
 * }} CaptureAppStateChangeOptions
 * @typedef {CaptureAppStateChangeOptions & {
 *   readonly flushOnBackground?: unknown,
 *   readonly onFlushError?: unknown
 * }} AppStateListenerOptions
 * @typedef {TracedContextOptions & {
 *   readonly id?: string | undefined,
 *   readonly idFactory?: (context: { readonly name: unknown, readonly screen: unknown }) => string,
 *   readonly name?: unknown,
 *   readonly now?: () => string,
 *   readonly screen?: unknown,
 *   readonly sessionId?: unknown,
 *   readonly status?: unknown,
 *   readonly timestamp?: string | undefined,
 *   readonly traceId?: unknown
 * }} ActionInput
 * @typedef {TracedContextOptions & {
 *   readonly durationMs?: unknown,
 *   readonly id?: string | undefined,
 *   readonly idFactory?: (context: { readonly method: string | undefined, readonly routeTemplate: string | undefined, readonly screen: unknown }) => string,
 *   readonly method?: unknown,
 *   readonly name?: string | undefined,
 *   readonly now?: () => string,
 *   readonly routeTemplate?: unknown,
 *   readonly screen?: unknown,
 *   readonly sessionId?: unknown,
 *   readonly status?: unknown,
 *   readonly statusCode?: unknown,
 *   readonly timestamp?: string | undefined,
 *   readonly traceId?: unknown
 * }} NetworkInput
 * @typedef {{ readonly id: string, readonly timestamp: string, readonly attributes: LooseRecord }} ActionEvent
 * @typedef {{ readonly addEventListener: (type: string, listener: (state: string) => void) => unknown }} AppStateSource
 */

const BACKGROUND_APP_STATES = new Set(["background", "inactive"]);

/**
 * @returns {string}
 */
function currentTimestamp() {
  return new Date().toISOString();
}

/**
 * @returns {string}
 */
function defaultActionEventId() {
  return defaultEventId("action");
}

/**
 * @returns {string}
 */
function defaultNetworkEventId() {
  return defaultEventId("network");
}

/**
 * @param {ClientLike} client
 * @param {unknown} screenName
 * @param {CaptureScreenViewOptions} [options]
 * @returns {void}
 */
function captureScreenView(client, screenName, {
  id,
  timestamp = new Date().toISOString(),
  status = "success",
  platform,
  appState,
  trace,
  metadata = {}
} = {}) {
  requireClient(client);
  requireNonEmpty("screen name", screenName);
  client.action(id ?? defaultEventId("screen"), timestamp, {
    name: screenActionName(textOf(screenName)),
    status,

    metadata: {
      ...getReactNativeContext({ appState, platform }),
      screen: screenName,
      ...metadata,
      ...getReactNativeTraceMetadata(trace ?? getActiveLogBrewTrace()),
      ...productAnalyticsMetadata("screen_view", screenName)
    }
  });
  recordIssueBreadcrumb(client, {
    timestamp,

    attributes: { name: screenActionName(textOf(screenName)), status }
  }, { category: "navigation", type: "navigation" });
}

/**
 * @param {ClientLike} client
 * @param {unknown} state
 * @param {CaptureAppStateChangeOptions} [options]
 * @returns {void}
 */
function captureAppStateChange(client, state, {
  id,
  timestamp = new Date().toISOString(),
  platform,
  appState,
  trace,
  metadata = {}
} = {}) {
  requireClient(client);
  requireNonEmpty("app state", state);
  client.action(id ?? defaultEventId("app_state"), timestamp, {
    name: "app_state_change",
    status: "success",

    metadata: {
      ...getReactNativeContext({ appState, platform }),
      appState: state,
      ...metadata,
      ...getReactNativeTraceMetadata(trace ?? getActiveLogBrewTrace())
    }
  });
  recordIssueBreadcrumb(client, {
    timestamp,

    attributes: { name: "app_state_change", status: "success" }
  }, { category: "app.state", type: "state" });
}

/**
 * @param {ActionInput} [input]
 * @returns {ActionEvent}
 */
function createReactNativeActionEvent({
  id,
  idFactory = defaultActionEventId,
  metadata = {},
  name,
  now = currentTimestamp,
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
        ...getReactNativeContext({ appState, platform }),
        source: "react-native.action",

        screen,
        sessionId,
        traceId,
        ...metadata,
        ...getReactNativeTraceMetadata(trace ?? getActiveLogBrewTrace()),
        ...productAnalyticsMetadata("interaction", screen)
      })
    }
  };
}

/**
 * @param {ClientLike} client
 * @param {ActionInput} [input]
 * @returns {ActionEvent}
 */
function captureReactNativeAction(client, input = {}) {
  requireClient(client);
  const event = createReactNativeActionEvent(input);
  client.action(event.id, event.timestamp, event.attributes);
  recordIssueBreadcrumb(client, event, { category: "ui.action", type: "user" });
  return event;
}

/**
 * @param {NetworkInput} [input]
 * @returns {ActionEvent}
 */
function createReactNativeNetworkEvent({
  durationMs,
  id,
  idFactory = defaultNetworkEventId,
  metadata = {},
  method,
  name,
  now = currentTimestamp,
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
  const safeMethod = method === undefined ? undefined : textOf(method).toUpperCase();
  const actionName = name ?? [safeMethod, safeRouteTemplate].filter(Boolean).join(" ");
  return {
    id: id ?? idFactory({ method: safeMethod, routeTemplate: safeRouteTemplate, screen }),
    timestamp: timestamp ?? now(),

    attributes: {
      name: actionName,
      status: status ?? statusFromStatusCode(statusCode),

      metadata: compactMetadata({
        ...getReactNativeContext({ appState, platform }),
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

/**
 * @param {ClientLike} client
 * @param {NetworkInput} [input]
 * @returns {ActionEvent}
 */
function captureReactNativeNetwork(client, input = {}) {
  requireClient(client);
  const event = createReactNativeNetworkEvent(input);
  client.action(event.id, event.timestamp, event.attributes);
  recordIssueBreadcrumb(client, event, { category: "http", type: "http" });
  return event;
}

/**
 * @param {unknown} value
 * @returns {value is AppStateSource}
 */
function isAppStateSource(value) {
  return typeof readField(value, "addEventListener") === "function";
}

/**
 * @param {unknown} value
 * @returns {value is (error: unknown) => unknown}
 */
function isErrorObserver(value) {
  return typeof value === "function";
}

/**
 * @param {(error: unknown) => unknown} onFlushError
 * @param {unknown} error
 * @returns {boolean}
 */
function notifyFlushError(onFlushError, error) {
  try {
    onFlushError(error);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} pending
 * @param {unknown} onFlushError
 * @returns {Promise<void>}
 */
async function observeBackgroundFlush(pending, onFlushError) {
  try {
    await pending;
  } catch (error) {
    if (isErrorObserver(onFlushError)) {
      notifyFlushError(onFlushError, error);
    }
  }
}

/**
 * @param {ClientLike} client
 * @param {AppStateLike | null | undefined} appState
 * @param {AppStateListenerOptions} [options]
 * @returns {() => unknown}
 */
function createAppStateListener(client, appState, options = {}) {
  requireClient(client);
  if (!isAppStateSource(appState)) {
    throw new SdkError("configuration_error", "createAppStateListener requires AppState.addEventListener");
  }
  const {
    flushOnBackground = false,
    onFlushError,
    ...captureOptions
  } = options;
  if (typeof flushOnBackground !== "boolean") {
    throw new SdkError("configuration_error", "createAppStateListener flushOnBackground must be a boolean");
  }
  if (onFlushError !== undefined && typeof onFlushError !== "function") {
    throw new SdkError("configuration_error", "createAppStateListener onFlushError must be a function");
  }

  const subscription = appState.addEventListener("change", nextState => {
    captureAppStateChange(client, nextState, {
      ...captureOptions,
      appState
    });
    if (flushOnBackground && BACKGROUND_APP_STATES.has(nextState)) {
      void observeBackgroundFlush(client.flush(), onFlushError);
    }
  });

  return subscriptionRemover(subscription);
}

module.exports = {
  captureAppStateChange,
  captureReactNativeAction,
  captureReactNativeNetwork,
  captureScreenView,
  createAppStateListener,
  createReactNativeActionEvent,
  createReactNativeNetworkEvent
};
