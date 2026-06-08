import { AppState, Platform } from "react-native";
import {
  captureAppStateChange,
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNetwork,
  captureScreenView,
  createAppStateListener,
  createLogBrewReactNativeClient,
  getReactNativeContext
} from "./index.js";

export * from "./index.js";

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
