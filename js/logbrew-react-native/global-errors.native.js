import { NativeModules, TurboModuleRegistry } from "react-native";

import {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativeGlobalErrorHandler as installPlatformNeutralHandler,
  installLogBrewReactNativePromiseRejectionTracker as installPlatformNeutralTracker
} from "./global-errors.js";

export {
  createLogBrewReactNativePromiseRejectionHandlers
};

const hermesTrackerAdapters = new WeakMap();

function defaultFatalStore() {
  try {
    return TurboModuleRegistry?.get?.("LogBrewFatalStore")
      ?? NativeModules?.LogBrewFatalStore;
  } catch {
    return undefined;
  }
}

function defaultPromiseRejectionTracker() {
  let hermes;
  let enable;
  let hasPromise;
  try {
    hermes = globalThis?.HermesInternal;
    if (hermes === null
      || (typeof hermes !== "object" && typeof hermes !== "function")) {
      return undefined;
    }
    enable = hermes.enablePromiseRejectionTracker;
    hasPromise = hermes.hasPromise;
    if (typeof enable !== "function"
      || typeof hasPromise !== "function"
      || hasPromise.call(hermes) !== true) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const existing = hermesTrackerAdapters.get(hermes);
  if (existing) {
    return existing;
  }
  const adapter = Object.freeze({
    enable(options) {
      return enable.call(hermes, options);
    }
  });
  hermesTrackerAdapters.set(hermes, adapter);
  return adapter;
}

export function installLogBrewReactNativeGlobalErrorHandler(options = {}) {
  let forwarded;
  let hasInjectedStore = false;
  try {
    const input = options !== null
      && (typeof options === "object" || typeof options === "function")
      ? options
      : {};
    hasInjectedStore = Object.prototype.hasOwnProperty.call(input, "fatalStore");
    forwarded = { ...input };
  } catch {
    forwarded = {};
  }
  return installPlatformNeutralHandler({
    ...forwarded,
    fatalStore: hasInjectedStore ? forwarded.fatalStore : defaultFatalStore()
  });
}

export function installLogBrewReactNativePromiseRejectionTracker(options = {}) {
  let forwarded;
  let hasInjectedTracker = false;
  try {
    const input = options !== null
      && (typeof options === "object" || typeof options === "function")
      ? options
      : {};
    hasInjectedTracker = Object.prototype.hasOwnProperty.call(input, "tracker");
    forwarded = { ...input };
  } catch {
    forwarded = {};
  }
  const tracker = hasInjectedTracker
    ? forwarded.tracker
    : defaultPromiseRejectionTracker();
  return installPlatformNeutralTracker({
    ...forwarded,
    tracker,
    trackerKind: hasInjectedTracker ? "custom" : tracker ? "hermes" : undefined
  });
}

const logBrewReactNativeGlobalErrors = {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativeGlobalErrorHandler,
  installLogBrewReactNativePromiseRejectionTracker
};

export default logBrewReactNativeGlobalErrors;
