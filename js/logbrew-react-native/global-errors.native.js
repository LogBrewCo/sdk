import { NativeModules, TurboModuleRegistry } from "react-native";

import {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativeGlobalErrorHandler as installPlatformNeutralHandler
} from "./global-errors.js";

export {
  createLogBrewReactNativePromiseRejectionHandlers
};

function defaultFatalStore() {
  try {
    return TurboModuleRegistry?.get?.("LogBrewFatalStore")
      ?? NativeModules?.LogBrewFatalStore;
  } catch {
    return undefined;
  }
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

const logBrewReactNativeGlobalErrors = {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativeGlobalErrorHandler
};

export default logBrewReactNativeGlobalErrors;
