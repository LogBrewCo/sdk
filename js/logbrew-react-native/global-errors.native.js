import {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativeGlobalErrorHandler as installPlatformNeutralHandler,
  installLogBrewReactNativePromiseRejectionTracker as installPlatformNeutralTracker
} from "./global-errors.js";
import support from "./global-errors-support.cjs";

/**
 * @import { UnknownFunction } from "./global-errors-support.cjs"
 * @typedef {Readonly<{ enable: (options: unknown) => unknown }>} HermesTrackerAdapter
 * @typedef {Readonly<{ forwarded: Readonly<Record<string, unknown>>, injected: boolean }>} ForwardedOptions
 */

const { isFunction, isObjectLike } = support;
/** @type {(value: unknown) => boolean} */
const isTruthy = Boolean;

/** @type {WeakMap<object, HermesTrackerAdapter>} */
const hermesTrackerAdapters = new WeakMap();

/**
 * @returns {Readonly<{ enable: UnknownFunction, hermes: object }> | undefined}
 */
function activeHermesTracker() {
  try {
    /** @type {unknown} */
    const hermes = Reflect.get(globalThis, "HermesInternal");
    if (!isObjectLike(hermes)) {
      return undefined;
    }
    /** @type {unknown} */
    const enable = Reflect.get(hermes, "enablePromiseRejectionTracker");
    /** @type {unknown} */
    const hasPromise = Reflect.get(hermes, "hasPromise");
    if (!isFunction(enable) || !isFunction(hasPromise) || hasPromise.call(hermes) !== true) {
      return undefined;
    }
    return { enable, hermes };
  } catch {
    return undefined;
  }
}

/**
 * @returns {HermesTrackerAdapter | undefined}
 */
function defaultPromiseRejectionTracker() {
  const active = activeHermesTracker();
  if (!active) {
    return undefined;
  }
  const { enable, hermes } = active;
  const existing = hermesTrackerAdapters.get(hermes);
  if (existing) {
    return existing;
  }
  const adapter = Object.freeze({
    /**
     * @param {unknown} options
     * @returns {unknown}
     */
    enable(options) {
      return enable.call(hermes, options);
    }
  });
  hermesTrackerAdapters.set(hermes, adapter);
  return adapter;
}

/**
 * @param {unknown} options
 * @param {string} key
 * @returns {ForwardedOptions}
 */
function forwardedOptions(options, key) {
  let injected = false;
  try {
    const input = isObjectLike(options) ? options : {};
    injected = Object.getOwnPropertyDescriptor(input, key) !== undefined;
    return { forwarded: { ...input }, injected };
  } catch {
    return { forwarded: {}, injected };
  }
}

/**
 * @param {unknown} [options]
 * @returns {unknown}
 */
function installLogBrewReactNativeGlobalErrorHandler(options = {}) {
  const { forwarded, injected } = forwardedOptions(options, "fatalStore");
  /** @type {unknown} */
  const installation = Reflect.apply(installPlatformNeutralHandler, undefined, [{
    ...forwarded,
    fatalStore: injected ? forwarded["fatalStore"] : undefined
  }]);
  return installation;
}

/**
 * @param {unknown} [options]
 * @returns {unknown}
 */
function installLogBrewReactNativePromiseRejectionTracker(options = {}) {
  const { forwarded, injected } = forwardedOptions(options, "tracker");
  const tracker = injected ? forwarded["tracker"] : defaultPromiseRejectionTracker();
  /** @type {"custom" | "hermes" | undefined} */
  let trackerKind = undefined;
  if (injected) {
    trackerKind = "custom";
  } else if (isTruthy(tracker)) {
    trackerKind = "hermes";
  }
  /** @type {unknown} */
  const installation = Reflect.apply(installPlatformNeutralTracker, undefined, [{ ...forwarded, tracker, trackerKind }]);
  return installation;
}

const logBrewReactNativeGlobalErrors = {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativeGlobalErrorHandler,
  installLogBrewReactNativePromiseRejectionTracker
};

export { createLogBrewReactNativePromiseRejectionHandlers } from "./global-errors.js";
export {
  installLogBrewReactNativeGlobalErrorHandler,
  installLogBrewReactNativePromiseRejectionTracker
};
export default logBrewReactNativeGlobalErrors;
