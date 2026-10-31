import { callNative, createNativeEventStore, requireStatus } from "./persistent-delivery-store.js";
import { SdkError } from "@logbrew/sdk";
import { lookupNativeModule } from "./native-module-lookup.js";
import { readField } from "./native-diagnostics-values.js";

/**
 * @typedef {{ durable: boolean, eventStore: unknown, abort: () => void, release: () => void }} ResolvedEventStore
 * @typedef {Readonly<{
 *   authKey: string,
 *   eventStore?: unknown,
 *   hasExplicitPersistentQueue?: boolean,
 *   maxQueueBytes?: unknown,
 *   maxQueueSize?: unknown,
 *   persistentQueue?: unknown
 * }>} PersistentEventStoreOptions
 */

/** @type {Set<string>} */
const ACTIVE_QUEUE_KEYS = new Set();
const MAX_NATIVE_QUEUE_BYTES = 4_194_304;
const MAX_NATIVE_QUEUE_EVENTS = 1000;
const MIN_QUEUE_LIMIT = 0;
const NATIVE_STORE_METHODS = [
  "acknowledgeEventRecords",
  "appendEventRecord",
  "closeEventStore",
  "loadEventRecords",
  "purgeEventRecords"
];
/** @type {ReadonlySet<unknown>} */
const PERSISTENT_QUEUE_MODES = new Set(["auto", "disabled", "required"]);
const UNAVAILABLE_NATIVE_QUEUE = "React Native persistent queue requires the linked LogBrew native module";

/**
 * @returns {unknown}
 */
function defaultNativeStore() {
  try {
    const nativeStore = lookupNativeModule("LogBrewFatalStore");
    return NATIVE_STORE_METHODS.every(method => typeof readField(nativeStore, method) === "function")
      ? nativeStore
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} limit
 * @param {number} maximum
 * @returns {boolean}
 */
function isValidQueueLimit(limit, maximum) {
  return limit === undefined
    || (typeof limit === "number" && Number.isSafeInteger(limit) && limit > MIN_QUEUE_LIMIT && limit <= maximum);
}

/**
 * @param {unknown} maxQueueBytes
 * @param {unknown} maxQueueSize
 */
function validateNativeQueueLimits(maxQueueBytes, maxQueueSize) {
  if (!isValidQueueLimit(maxQueueBytes, MAX_NATIVE_QUEUE_BYTES)) {
    throw new SdkError(
      "configuration_error",
      `persistent React Native maxQueueBytes must be at most ${MAX_NATIVE_QUEUE_BYTES}`
    );
  }
  if (!isValidQueueLimit(maxQueueSize, MAX_NATIVE_QUEUE_EVENTS)) {
    throw new SdkError(
      "configuration_error",
      `persistent React Native maxQueueSize must be at most ${MAX_NATIVE_QUEUE_EVENTS}`
    );
  }
}

/**
 * @param {unknown} mode
 */
function validatePersistentQueueMode(mode) {
  if (!PERSISTENT_QUEUE_MODES.has(mode)) {
    throw new SdkError(
      "configuration_error",
      "persistentQueue must be auto, required, or disabled"
    );
  }
}

/**
 * @param {unknown} eventStore
 * @returns {ResolvedEventStore}
 */
function memoryEventStore(eventStore) {
  return {
    eventStore,

    durable: false,

    abort() {
      return undefined;
    },
    release() {
      return undefined;
    }
  };
}

/**
 * @param {unknown} nativeStore
 * @param {string} authKey
 * @returns {ResolvedEventStore}
 */
function durableEventStore(nativeStore, authKey) {
  if (ACTIVE_QUEUE_KEYS.has(authKey)) {
    throw new SdkError(
      "configuration_error",
      "React Native persistent queue already has an active client for this key"
    );
  }
  ACTIVE_QUEUE_KEYS.add(authKey);
  let released = false;
  function release() {
    if (!released) {
      released = true;
      ACTIVE_QUEUE_KEYS.delete(authKey);
    }
  }
  const nativeEventStore = createNativeEventStore(nativeStore, authKey, release);
  return {
    durable: true,
    eventStore: nativeEventStore,

    abort() {
      try {
        nativeEventStore.close();
      } catch {
        release();
      }
    },
    release
  };
}

/**
 * @param {unknown} eventStore
 * @param {boolean} hasExplicitPersistentQueue
 * @returns {ResolvedEventStore}
 */
function explicitEventStore(eventStore, hasExplicitPersistentQueue) {
  if (hasExplicitPersistentQueue) {
    throw new SdkError(
      "configuration_error",
      "eventStore and persistentQueue are mutually exclusive"
    );
  }
  return memoryEventStore(eventStore);
}

/**
 * @param {unknown} persistentQueue
 * @returns {ResolvedEventStore}
 */
function unavailableEventStore(persistentQueue) {
  if (persistentQueue === "required") {
    throw new SdkError("configuration_error", UNAVAILABLE_NATIVE_QUEUE);
  }
  return memoryEventStore(undefined);
}

/**
 * @param {PersistentEventStoreOptions} options
 * @returns {ResolvedEventStore}
 */
function resolveReactNativePersistentEventStore({
  authKey,
  eventStore,
  hasExplicitPersistentQueue = false,
  maxQueueBytes,
  maxQueueSize,
  persistentQueue = "auto"
}) {
  validatePersistentQueueMode(persistentQueue);
  if (eventStore !== undefined) {
    return explicitEventStore(eventStore, hasExplicitPersistentQueue);
  }
  if (persistentQueue === "disabled") {
    return memoryEventStore(undefined);
  }
  const nativeStore = defaultNativeStore();
  if (nativeStore === undefined) {
    return unavailableEventStore(persistentQueue);
  }
  validateNativeQueueLimits(maxQueueBytes, maxQueueSize);
  return durableEventStore(nativeStore, authKey);
}

/**
 * @param {unknown} authKey
 * @returns {string}
 */
function purgeAuthKey(authKey) {
  if (typeof authKey !== "string" || authKey.trim() === "") {
    throw new SdkError(
      "configuration_error",
      "purgeLogBrewReactNativePersistentQueue requires clientKey or apiKey"
    );
  }
  if (ACTIVE_QUEUE_KEYS.has(authKey)) {
    throw new SdkError(
      "persistence_error",
      "cannot purge a React Native persistent queue while its client is active"
    );
  }
  return authKey;
}

/**
 * @param {() => void} operation
 * @returns {Error | undefined}
 */
function failureOf(operation) {
  try {
    operation();
    return undefined;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
}

/**
 * @param {Readonly<{ apiKey?: unknown, clientKey?: unknown }>} [config]
 */
function purgeReactNativePersistentQueue({ apiKey, clientKey } = {}) {
  const authKey = purgeAuthKey(clientKey ?? apiKey);
  const nativeStore = defaultNativeStore();
  if (nativeStore === undefined) {
    throw new SdkError("configuration_error", UNAVAILABLE_NATIVE_QUEUE);
  }
  const purged = failureOf(() => {
    requireStatus("purge", callNative(nativeStore, "purgeEventRecords", authKey), "purged");
  });
  const closed = failureOf(() => {
    requireStatus("close", callNative(nativeStore, "closeEventStore", authKey), "closed");
  });
  const failure = purged ?? closed;
  if (failure !== undefined) {
    throw failure;
  }
}

export { purgeReactNativePersistentQueue, resolveReactNativePersistentEventStore };
