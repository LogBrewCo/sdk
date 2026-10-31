const { SdkError } = require("@logbrew/sdk");
const { captureReactNativeNavigationSpan } = require("./index-spans.cjs");
const { normalizeMetadataValue, readField, requireClient, stripQueryAndHash, subscriptionRemover } = require("./index-values.cjs");

/**
 * @import { ClientLike, ContextOptions } from "./index-values.cjs"
 * @typedef {{ readonly key?: unknown, readonly name?: string | undefined, readonly path?: string | undefined }} RouteSnapshot
 * @typedef {{ readonly actionType: string | undefined, readonly startedAtMs: number, readonly timestamp: string }} PendingNavigation
 * @typedef {{
 *   readonly addListener: (eventName: string, listener: (event: unknown) => void) => unknown,
 *   readonly getCurrentRoute: () => unknown
 * }} NavigationContainerLike
 * @typedef {ContextOptions & {
 *   readonly captureInitialRoute?: boolean | undefined,
 *   readonly includeRouteKey?: boolean | undefined,
 *   readonly now?: () => string,
 *   readonly nowMs?: () => number,
 *   readonly onError?: unknown,
 *   readonly trace?: unknown
 * }} NavigationListenerOptions
 * @typedef {{ readonly pendingNavigation: PendingNavigation | undefined, readonly previousRoute: RouteSnapshot }} NavigationState
 * @typedef {{ readonly read: () => NavigationState, readonly write: (next: NavigationState) => void }} NavigationStore
 * @typedef {{
 *   readonly appState: ContextOptions["appState"],
 *   readonly includeRouteKey: boolean,
 *   readonly metadata: ContextOptions["metadata"],
 *   readonly now: () => string,
 *   readonly platform: ContextOptions["platform"],
 *   readonly trace: unknown
 * }} NavigationSpanSettings
 * @typedef {{
 *   readonly client: ClientLike,
 *   readonly container: NavigationContainerLike,
 *   readonly nowMs: () => number,
 *   readonly onError: unknown,
 *   readonly settings: NavigationSpanSettings,
 *   readonly store: NavigationStore
 * }} RouteCaptureContext
 * @typedef {{ readonly add: (remover: () => unknown) => void, readonly removeListeners: () => void }} ListenerRemovers
 * @typedef {{
 *   readonly captureCurrentRoute: () => void,
 *   readonly captureInitialRoute: boolean,
 *   readonly container: NavigationContainerLike,
 *   readonly now: () => string,
 *   readonly nowMs: () => number,
 *   readonly removers: ListenerRemovers,
 *   readonly store: NavigationStore
 * }} AttachContext
 */

const NO_DURATION = 0;
const NO_FAILURES = 0;
const FIRST = 0;

/**
 * @returns {string}
 */
function currentTimestamp() {
  return new Date().toISOString();
}

/**
 * @returns {number}
 */
function currentTimeMs() {
  return Date.now();
}

/**
 * @param {unknown} value
 * @returns {value is NavigationContainerLike}
 */
function isNavigationContainer(value) {
  return typeof readField(value, "addListener") === "function" && typeof readField(value, "getCurrentRoute") === "function";
}

/**
 * @param {unknown} value
 * @returns {value is (error: unknown) => unknown}
 */
function isErrorHandler(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} navigationContainer
 * @returns {unknown}
 */
function resolveNavigationContainer(navigationContainer) {
  if (typeof navigationContainer === "object" && navigationContainer !== null && "current" in navigationContainer) {
    return navigationContainer.current;
  }
  return navigationContainer;
}

/**
 * @param {NavigationContainerLike} container
 * @param {string} eventName
 * @param {(event: unknown) => void} listener
 * @returns {() => unknown}
 */
function addNavigationListener(container, eventName, listener) {
  const subscription = container.addListener(eventName, listener);
  return subscriptionRemover(subscription);
}

/**
 * @param {NavigationContainerLike} container
 * @param {string} eventName
 * @param {(event: unknown) => void} listener
 * @returns {(() => unknown) | undefined}
 */
function safeNavigationListener(container, eventName, listener) {
  try {
    return addNavigationListener(container, eventName, listener);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} route
 * @returns {RouteSnapshot}
 */
function routeSnapshot(route) {
  const key = normalizeMetadataValue(readField(route, "key"));
  const name = readField(route, "name");
  return {
    key,
    name: typeof name === "string" && name.trim() !== "" ? name : undefined,
    path: stripQueryAndHash(readField(route, "path"))
  };
}

/**
 * @param {unknown} event
 * @returns {string | undefined}
 */
function navigationActionType(event) {
  const action = readField(readField(event, "data"), "action") ?? readField(event, "action") ?? event;
  const type = readField(action, "type");
  return typeof type === "string" && type.trim() !== "" ? type : undefined;
}

/**
 * @param {PendingNavigation | undefined} pendingNavigation
 * @param {() => number} nowMs
 * @returns {number | undefined}
 */
function navigationDuration(pendingNavigation, nowMs) {
  const startedAtMs = pendingNavigation?.startedAtMs;
  return startedAtMs === undefined ? undefined : Math.max(NO_DURATION, nowMs() - startedAtMs);
}

/**
 * @param {() => void} removeListeners
 * @returns {boolean}
 */
function tryRemoveListeners(removeListeners) {
  try {
    removeListeners();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {NavigationState} initial
 * @returns {NavigationStore}
 */
function createNavigationStore(initial) {
  let state = initial;
  return {
    read: () => state,
    write: next => {
      state = next;
    }
  };
}

/**
 * @returns {ListenerRemovers}
 */
function createListenerRemovers() {
  /** @type {(() => unknown)[]} */
  const removers = [];

  /**
   * @param {() => unknown} remover
   * @returns {void}
   */
  function add(remover) {
    removers.unshift(remover);
  }

  /**
   * @returns {void}
   */
  function removeListeners() {
    /** @type {unknown[]} */
    const failures = [];
    /** @type {(() => unknown)[]} */
    const failedRemovers = [];
    for (const remove of removers.splice(FIRST)) {
      try {
        remove();
      } catch (error) {
        failedRemovers.push(remove);
        failures.push(error);
      }
    }
    removers.unshift(...failedRemovers);
    if (failures.length > NO_FAILURES) {
      throw failures[FIRST];
    }
  }

  return { add, removeListeners };
}

/**
 * @param {RouteCaptureContext} context
 * @returns {() => void}
 */
function routeCapturer({ client, container, nowMs, onError, settings, store }) {
  /**
   * @returns {void}
   */
  function recordCurrentRoute() {
    const route = routeSnapshot(container.getCurrentRoute());
    if (route.name === undefined && (route.path === undefined || route.path === "")) {
      return;
    }
    const { pendingNavigation, previousRoute } = store.read();
    captureReactNativeNavigationSpan(client, {
      actionType: pendingNavigation?.actionType,
      appState: settings.appState,
      durationMs: navigationDuration(pendingNavigation, nowMs),
      includeRouteKey: settings.includeRouteKey,
      metadata: settings.metadata,
      now: settings.now,
      platform: settings.platform,
      previousRouteKey: previousRoute.key,
      previousRouteName: previousRoute.name,
      routeKey: route.key,
      routeName: route.name,
      routePath: route.path,
      timestamp: pendingNavigation?.timestamp,
      trace: settings.trace
    });
    store.write({ pendingNavigation: undefined, previousRoute: route });
  }

  /**
   * @returns {void}
   */
  function captureCurrentRoute() {
    try {
      recordCurrentRoute();
    } catch (error) {
      if (!isErrorHandler(onError)) {
        throw error;
      }
      onError(error);
    }
  }

  return captureCurrentRoute;
}

/**
 * @param {AttachContext} context
 * @returns {void}
 */
function attachNavigationListeners({ captureCurrentRoute, captureInitialRoute, container, now, nowMs, removers, store }) {
  try {
    const actionSubscription = safeNavigationListener(container, "__unsafe_action__", event => {
      store.write({
        ...store.read(),
        pendingNavigation: {
          actionType: navigationActionType(event),
          startedAtMs: nowMs(),
          timestamp: now()
        }
      });
    });
    if (actionSubscription) {
      removers.add(actionSubscription);
    }
    removers.add(addNavigationListener(container, "state", captureCurrentRoute));
    if (captureInitialRoute) {
      captureCurrentRoute();
    }
  } catch (error) {
    tryRemoveListeners(removers.removeListeners);
    throw error;
  }
}

/**
 * @param {ClientLike} client
 * @param {unknown} navigationContainer
 * @param {NavigationListenerOptions} [options]
 * @returns {() => void}
 */
function createReactNavigationSpanListener(client, navigationContainer, {
  captureInitialRoute = false, includeRouteKey = false, metadata = {}, now = currentTimestamp,
  nowMs = currentTimeMs, onError, platform, appState, trace
} = {}) {
  requireClient(client);
  const container = resolveNavigationContainer(navigationContainer);
  if (!isNavigationContainer(container)) {
    throw new SdkError("configuration_error", "createReactNavigationSpanListener requires a React Navigation container ref with addListener and getCurrentRoute");
  }
  const store = createNavigationStore({
    pendingNavigation: undefined,
    previousRoute: captureInitialRoute ? {} : routeSnapshot(container.getCurrentRoute())
  });
  const settings = { appState, includeRouteKey, metadata, now, platform, trace };
  const captureCurrentRoute = routeCapturer({ client, container, nowMs, onError, settings, store });
  const removers = createListenerRemovers();
  attachNavigationListeners({ captureCurrentRoute, captureInitialRoute, container, now, nowMs, removers, store });
  return removers.removeListeners;
}

module.exports = { createReactNavigationSpanListener };
