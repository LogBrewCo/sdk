import { AppState, Platform } from "react-native";
import {
  captureAppStateChange,
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNetwork,
  captureScreenView,
  createAppStateListener,
  createLogBrewReactNativeClient as createPlatformNeutralClient,
  getReactNativeContext
} from "./index.js";
import baseDefault from "./index.js";
import {
  purgeReactNativePersistentQueue,
  resolveReactNativePersistentEventStore
} from "./persistent-delivery.native.js";
export {
  installLogBrewReactNativeGlobalErrorHandler,
  installLogBrewReactNativePromiseRejectionTracker
} from "./global-errors.native.js";

export * from "./index.js";

export function createLogBrewReactNativeClient(config = {}) {
  const input = config !== null && typeof config === "object" ? config : {};
  const {
    apiKey,
    clientKey,
    eventStore,
    maxQueueBytes,
    maxQueueSize,
    persistentQueue = "auto",
    ...forwarded
  } = input;
  const hasExplicitPersistentQueue = Object.prototype.hasOwnProperty.call(
    input,
    "persistentQueue"
  ) && input.persistentQueue !== undefined;
  const authKey = clientKey ?? apiKey;
  if (typeof authKey !== "string" || authKey.trim() === "") {
    return createPlatformNeutralClient(input);
  }
  const resolved = resolveReactNativePersistentEventStore({
    authKey,
    eventStore,
    maxQueueBytes,
    maxQueueSize,
    persistentQueue,
    hasExplicitPersistentQueue
  });
  try {
    return createPlatformNeutralClient({
      ...forwarded,
      apiKey,
      clientKey,
      eventStore: resolved.eventStore,
      maxQueueBytes,
      maxQueueSize
    });
  } catch (error) {
    resolved.abort();
    throw error;
  }
}

export function purgeLogBrewReactNativePersistentQueue(config = {}) {
  purgeReactNativePersistentQueue(config);
}

export function createDefaultLogBrewReactNativeClient(config = {}) {
  return createLogBrewReactNativeClient(config);
}

export function getDefaultReactNativeContext({ metadata = {} } = {}) {
  return getReactNativeContext({ platform: Platform, appState: AppState, metadata });
}

export function captureDefaultScreenView(client, screenName, options = {}) {
  return captureScreenView(client, screenName, {
    platform: Platform,
    appState: AppState,
    ...options
  });
}

export function captureDefaultAppStateChange(client, state, options = {}) {
  return captureAppStateChange(client, state, {
    platform: Platform,
    appState: AppState,
    ...options
  });
}

export function captureDefaultReactNativeAction(client, input = {}) {
  return captureReactNativeAction(client, {
    platform: Platform,
    appState: AppState,
    ...input
  });
}

export function captureDefaultReactNativeNetwork(client, input = {}) {
  return captureReactNativeNetwork(client, {
    platform: Platform,
    appState: AppState,
    ...input
  });
}

export function captureDefaultReactNativeError(client, error, options = {}) {
  return captureReactNativeError(client, error, {
    platform: Platform,
    appState: AppState,
    ...options
  });
}

export function createDefaultAppStateListener(client, options = {}) {
  return createAppStateListener(client, AppState, {
    platform: Platform,
    ...options
  });
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
  purgeLogBrewReactNativePersistentQueue
};

export default defaultExport;
