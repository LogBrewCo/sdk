import { NativeModules, Platform, TurboModuleRegistry } from "react-native";
import { readField } from "./native-diagnostics-values.js";

/**
 * @param {string} name
 * @returns {unknown}
 */
function lookupNativeModule(name) {
  /** @type {unknown} */
  const registry = TurboModuleRegistry;
  const get = readField(registry, "get");
  if (get !== undefined && get !== null && typeof get !== "function") {
    throw new TypeError("TurboModuleRegistry.get is not a function");
  }
  /** @type {unknown} */
  const fromRegistry = typeof get === "function" ? Reflect.apply(get, registry, [name]) : undefined;
  /** @type {unknown} */
  const legacy = NativeModules;
  return fromRegistry ?? readField(legacy, name);
}

/**
 * @returns {unknown}
 */
function platformOS() {
  /** @type {unknown} */
  const platform = Platform;
  return readField(platform, "OS");
}

export { lookupNativeModule, platformOS };
