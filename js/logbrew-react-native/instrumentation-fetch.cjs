"use strict";

const { SdkError } = require("@logbrew/sdk");
const { isCallable, isWritableRecord, readField } = require("./instrumentation-values.cjs");
const { resourceFetchRuntime } = require("./instrumentation-runtime.cjs");

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import { ResourceFetch, ResourceFetchOptions } from "./instrumentation-runtime.cjs"
 * @import { Callable } from "./instrumentation-values.cjs"
 */

/**
 * @typedef {{
 *   readonly globalObject: unknown,
 *   readonly measureResponseBodySize: boolean,
 *   readonly resourceOptions: ResourceFetchOptions
 * }} GlobalFetchOptions
 */

/**
 * @param {unknown} globalObject
 * @returns {{ readonly globalObject: Record<PropertyKey, unknown>, readonly originalFetch: Callable }}
 */
function requireGlobalFetch(globalObject) {
  if (!isWritableRecord(globalObject)) {
    throw new SdkError("configuration_error", "instrumentGlobalFetch requires a globalObject");
  }
  const originalFetch = globalObject["fetch"];
  if (!isCallable(originalFetch)) {
    throw new SdkError("configuration_error", "instrumentGlobalFetch requires globalObject.fetch");
  }
  return { globalObject, originalFetch };
}

/**
 * @param {LogBrewClient} client
 * @param {GlobalFetchOptions} options
 * @param {Callable} originalFetch
 * @returns {ResourceFetch}
 */
function createGlobalResourceFetch(client, { globalObject, measureResponseBodySize, resourceOptions }, originalFetch) {
  /** @type {{ readonly fetchImpl: (input: unknown, init?: unknown) => unknown }} */
  const fetchOptions = {
    fetchImpl: (input, init) => Reflect.apply(originalFetch, globalObject, [input, init])
  };
  return resourceFetchRuntime.createReactNativeResourceFetch(client, {
    ...resourceOptions,
    fetchImpl: fetchOptions.fetchImpl,
    measureResponseBodySize
  });
}

/**
 * @param {LogBrewClient} client
 * @param {GlobalFetchOptions} options
 * @param {Callable} originalFetch
 * @returns {ResourceFetch}
 */
function createWrappedFetch(client, options, originalFetch) {
  const globalResourceFetch = createGlobalResourceFetch(client, options, originalFetch);
  /** @type {{ readonly wrappedFetch: ResourceFetch }} */
  const wrapper = {
    wrappedFetch: (input, init) => globalResourceFetch(input, init)
  };
  return wrapper.wrappedFetch;
}

/**
 * @param {unknown} globalObject
 * @param {ResourceFetch} wrappedFetch
 * @returns {void}
 */
function requirePatched(globalObject, wrappedFetch) {
  if (readField(globalObject, "fetch") !== wrappedFetch) {
    throw new SdkError("configuration_error", "instrumentGlobalFetch could not patch globalObject.fetch");
  }
}

/**
 * @param {LogBrewClient} client
 * @param {GlobalFetchOptions} options
 * @returns {Readonly<{ fetch: ResourceFetch, remove: () => void, stop: () => void }>}
 */
function installGlobalFetchInstrumentation(client, options) {
  const { globalObject, originalFetch } = requireGlobalFetch(options.globalObject);
  const wrappedFetch = createWrappedFetch(client, options, originalFetch);
  try {
    globalObject["fetch"] = wrappedFetch;
  } catch {
    throw new SdkError("configuration_error", "instrumentGlobalFetch could not patch globalObject.fetch");
  }
  requirePatched(globalObject, wrappedFetch);
  let removed = false;
  const { remove } = {
    remove: () => {
      if (removed) {
        return;
      }
      removed = true;
      if (globalObject["fetch"] === wrappedFetch) {
        globalObject["fetch"] = originalFetch;
      }
    }
  };
  return Object.freeze({
    fetch: wrappedFetch,
    remove,
    stop: remove
  });
}

module.exports = { installGlobalFetchInstrumentation };
