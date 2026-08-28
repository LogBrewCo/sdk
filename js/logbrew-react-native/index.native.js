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
  getLogBrewAppleNativeDiagnosticsStatus,
  installLogBrewAppleNativeDiagnostics,
  replayLogBrewAppleNativeDiagnostics,
  setLogBrewAppleNativeCrashContext,
  syncLogBrewAppleNativeCrashBreadcrumbs
} from "./apple-native-diagnostics.js";
import {
  purgeReactNativePersistentQueue,
  resolveReactNativePersistentEventStore
} from "./persistent-delivery.native.js";
export {
  installLogBrewReactNativeGlobalErrorHandler,
  installLogBrewReactNativePromiseRejectionTracker
} from "./global-errors.native.js";
export {
  getLogBrewAppleNativeDiagnosticsStatus,
  installLogBrewAppleNativeDiagnostics,
  replayLogBrewAppleNativeDiagnostics,
  setLogBrewAppleNativeCrashContext
};

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
    return bindAppleNativeCrashBreadcrumbs(createPlatformNeutralClient(input));
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
    return bindAppleNativeCrashBreadcrumbs(createPlatformNeutralClient({
      ...forwarded,
      apiKey,
      clientKey,
      eventStore: resolved.eventStore,
      maxQueueBytes,
      maxQueueSize
    }));
  } catch (error) {
    resolved.abort();
    throw error;
  }
}

function bindAppleNativeCrashBreadcrumbs(client) {
  if (Platform?.OS !== "ios") {
    return client;
  }
  const addBreadcrumb = client.addBreadcrumb.bind(client);
  const clearBreadcrumbs = client.clearBreadcrumbs.bind(client);
  client.addBreadcrumb = (...args) => {
    const previous = [client.issueBreadcrumbs.slice(), client.issueBreadcrumbsTruncated];
    const result = addBreadcrumb(...args);
    try {
      syncAppleNativeCrashBreadcrumbs(client);
    } catch (error) {
      restoreBreadcrumbs(client, previous);
      throw error;
    }
    return result;
  };
  client.clearBreadcrumbs = () => {
    const previous = [client.issueBreadcrumbs.slice(), client.issueBreadcrumbsTruncated];
    const result = clearBreadcrumbs();
    try {
      syncAppleNativeCrashBreadcrumbs(client);
    } catch (error) {
      restoreBreadcrumbs(client, previous);
      throw error;
    }
    return result;
  };
  syncAppleNativeCrashBreadcrumbs(client);
  return client;
}

function restoreBreadcrumbs(client, [breadcrumbs, truncated]) {
  client.issueBreadcrumbs.splice(0, client.issueBreadcrumbs.length, ...breadcrumbs);
  client.issueBreadcrumbsTruncated = truncated;
}

function syncAppleNativeCrashBreadcrumbs(client) {
  const snapshot = client.issueBreadcrumbs.length === 0
    ? null
    : {
        breadcrumbs: client.issueBreadcrumbs.map(({ data, ...breadcrumb }) => ({
          ...breadcrumb,
          ...(data === undefined ? {} : { data: { ...data } })
        })),
        schemaVersion: 1,
        truncated: client.issueBreadcrumbsTruncated
      };
  try {
    syncLogBrewAppleNativeCrashBreadcrumbs(snapshot);
  } catch (error) {
    if (error?.code !== "native_diagnostics_unavailable"
      && error?.code !== "native_diagnostics_not_installed") {
      throw error;
    }
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
  getLogBrewAppleNativeDiagnosticsStatus,
  installLogBrewAppleNativeDiagnostics,
  purgeLogBrewReactNativePersistentQueue,
  replayLogBrewAppleNativeDiagnostics,
  setLogBrewAppleNativeCrashContext
};

export default defaultExport;
