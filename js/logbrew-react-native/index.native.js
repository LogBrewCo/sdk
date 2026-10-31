import { AppState, Platform } from "react-native";
import baseDefault, {
  captureAppStateChange,
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNetwork,
  captureScreenView,
  createAppStateListener,
  createLogBrewReactNativeClient as createPlatformNeutralClient,
  getReactNativeContext
} from "./index.js";
import { bindAndroidNativeDelivery, bindAppleNativeCrashBreadcrumbs } from "./native-client-bindings.js";
import {
  getLogBrewAndroidNativeDiagnosticsStatus,
  installLogBrewAndroidNativeDiagnostics,
  uninstallLogBrewAndroidNativeDiagnostics
} from "./android-native-diagnostics.js";
import {
  getLogBrewAppleNativeDiagnosticsStatus,
  installLogBrewAppleNativeDiagnostics,
  replayLogBrewAppleNativeDiagnostics,
  setLogBrewAppleNativeCrashContext
} from "./apple-native-diagnostics.js";
import { hasOwnKey, readField } from "./native-diagnostics-values.js";
import {
  purgeReactNativePersistentQueue,
  resolveReactNativePersistentEventStore
} from "./persistent-delivery.native.js";
import { lookupNativeModule } from "./native-module-lookup.js";

/**
 * @import { LogBrewClient, Metadata } from "@logbrew/sdk"
 * @import { ReactNativeActionEvent, ReactNativeErrorEvent } from "./index.js"
 * @typedef {(...args: readonly never[]) => unknown} Callable
 * @typedef {{ durable: boolean, eventStore: unknown, abort: () => void, release: () => void }} ResolvedEventStore
 */

const DURABLE_QUEUE = Symbol.for("co.logbrew.react-native.durable-event-queue");

/**
 * @param {unknown} value
 * @returns {value is Callable}
 */
function isCallable(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isObjectInput(value) {
  return value !== null && typeof value === "object";
}

const nativeRuntime = lookupNativeModule("LogBrewFatalStore");
const secureRandomHex = readField(nativeRuntime, "secureRandomHex");
if (isCallable(secureRandomHex)) {
  Reflect.set(globalThis, Symbol.for("co.logbrew.react-native.secure-random-hex"), secureRandomHex.bind(nativeRuntime));
}

/**
 * @param {Readonly<Record<string, unknown>>} settings
 * @param {Readonly<ResolvedEventStore>} resolved
 * @returns {LogBrewClient}
 */
function createResolvedClient(settings, resolved) {
  try {
    /** @type {Readonly<Record<string, unknown>>} */
    const clientConfig = { ...settings, eventStore: resolved.eventStore };
    const client = createPlatformNeutralClient(clientConfig);
    if (resolved.durable) {
      Object.defineProperty(client, DURABLE_QUEUE, { value: true });
    }
    return bindAndroidNativeDelivery(bindAppleNativeCrashBreadcrumbs(client), resolved.durable);
  } catch (error) {
    resolved.abort();
    throw error;
  }
}

/**
 * @param {unknown} [config]
 * @returns {LogBrewClient}
 */
function createLogBrewReactNativeClient(config = {}) {
  const input = isObjectInput(config) ? config : {};
  const {
    apiKey,
    clientKey,
    eventStore,
    maxQueueBytes,
    maxQueueSize,
    persistentQueue = "auto",
    ...forwarded
  } = input;
  const hasExplicitPersistentQueue = hasOwnKey(input, "persistentQueue") && input["persistentQueue"] !== undefined;
  const authKey = clientKey ?? apiKey;
  if (typeof authKey !== "string" || authKey.trim() === "") {
    return bindAppleNativeCrashBreadcrumbs(createPlatformNeutralClient(input));
  }
  const resolved = resolveReactNativePersistentEventStore({
    authKey,
    eventStore,
    hasExplicitPersistentQueue,
    maxQueueBytes,
    maxQueueSize,
    persistentQueue
  });
  return createResolvedClient({ ...forwarded, apiKey, clientKey, maxQueueBytes, maxQueueSize }, resolved);
}

/**
 * @param {Readonly<{ apiKey?: unknown, clientKey?: unknown }>} [config]
 */
function purgeLogBrewReactNativePersistentQueue(config = {}) {
  purgeReactNativePersistentQueue(config);
}

/**
 * @param {unknown} [config]
 * @returns {LogBrewClient}
 */
function createDefaultLogBrewReactNativeClient(config = {}) {
  return createLogBrewReactNativeClient(config);
}

/**
 * @param {unknown} value
 * @returns {Readonly<Record<string, unknown>>}
 */
function objectOptions(value) {
  if (isObjectInput(value)) {
    return value;
  }
  return value === null || value === undefined ? {} : Object.fromEntries(Object.entries(value));
}

/**
 * @param {unknown} options
 * @returns {Readonly<Record<string, unknown>>}
 */
function withDefaultRuntime(options) {
  return {
    platform: Platform,

    appState: AppState,
    ...objectOptions(options)
  };
}

/**
 * @param {Readonly<{ metadata?: unknown }>} [options]
 * @returns {Metadata}
 */
function getDefaultReactNativeContext({ metadata = {} } = {}) {
  /** @type {Readonly<Record<string, unknown>>} */
  const contextOptions = {
    platform: Platform,

    appState: AppState,
    metadata
  };
  return getReactNativeContext(contextOptions);
}

/**
 * @param {LogBrewClient} client
 * @param {string} screenName
 * @param {unknown} [options]
 */
function captureDefaultScreenView(client, screenName, options = {}) {
  captureScreenView(client, screenName, withDefaultRuntime(options));
}

/**
 * @param {LogBrewClient} client
 * @param {string} state
 * @param {unknown} [options]
 */
function captureDefaultAppStateChange(client, state, options = {}) {
  captureAppStateChange(client, state, withDefaultRuntime(options));
}

/**
 * @param {LogBrewClient} client
 * @param {unknown} [input]
 * @returns {ReactNativeActionEvent}
 */
function captureDefaultReactNativeAction(client, input = {}) {
  return captureReactNativeAction(client, withDefaultRuntime(input));
}

/**
 * @param {LogBrewClient} client
 * @param {unknown} [input]
 * @returns {ReactNativeActionEvent}
 */
function captureDefaultReactNativeNetwork(client, input = {}) {
  return captureReactNativeNetwork(client, withDefaultRuntime(input));
}

/**
 * @param {LogBrewClient} client
 * @param {unknown} error
 * @param {unknown} [options]
 * @returns {ReactNativeErrorEvent}
 */
function captureDefaultReactNativeError(client, error, options = {}) {
  return captureReactNativeError(client, error, withDefaultRuntime(options));
}

/**
 * @param {LogBrewClient} client
 * @param {unknown} [options]
 * @returns {() => void}
 */
function createDefaultAppStateListener(client, options = {}) {
  /** @type {Readonly<Record<string, unknown>>} */
  const listenerOptions = { platform: Platform, ...objectOptions(options) };
  return createAppStateListener(client, AppState, listenerOptions);
}

const defaultExport = {
  ...baseDefault,
  captureDefaultAppStateChange,
  captureDefaultReactNativeAction,
  captureDefaultReactNativeError,
  captureDefaultReactNativeNetwork,
  captureDefaultScreenView,
  createDefaultAppStateListener,
  createDefaultLogBrewReactNativeClient,
  createLogBrewReactNativeClient,
  getDefaultReactNativeContext,
  getLogBrewAndroidNativeDiagnosticsStatus,
  getLogBrewAppleNativeDiagnosticsStatus,
  installLogBrewAppleNativeDiagnostics,

  installLogBrewAndroidNativeDiagnostics,
  purgeLogBrewReactNativePersistentQueue,
  replayLogBrewAppleNativeDiagnostics,
  setLogBrewAppleNativeCrashContext,
  uninstallLogBrewAndroidNativeDiagnostics
};

export * from "./index.js";
export {
  getLogBrewAndroidNativeDiagnosticsStatus,
  installLogBrewAndroidNativeDiagnostics,
  uninstallLogBrewAndroidNativeDiagnostics
} from "./android-native-diagnostics.js";
export {
  getLogBrewAppleNativeDiagnosticsStatus,
  installLogBrewAppleNativeDiagnostics,
  replayLogBrewAppleNativeDiagnostics,
  setLogBrewAppleNativeCrashContext
} from "./apple-native-diagnostics.js";
export {
  installLogBrewReactNativeGlobalErrorHandler,
  installLogBrewReactNativePromiseRejectionTracker
} from "./global-errors.native.js";
export {
  captureDefaultAppStateChange,
  captureDefaultReactNativeAction,
  captureDefaultReactNativeError,
  captureDefaultReactNativeNetwork,
  captureDefaultScreenView,
  createDefaultAppStateListener,
  createDefaultLogBrewReactNativeClient,
  createLogBrewReactNativeClient,
  getDefaultReactNativeContext,
  purgeLogBrewReactNativePersistentQueue
};
export default defaultExport;
