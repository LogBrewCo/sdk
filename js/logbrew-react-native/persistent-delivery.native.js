import { SdkError } from "@logbrew/sdk";
import { NativeModules, TurboModuleRegistry } from "react-native";

const ACTIVE_QUEUE_KEYS = new Set();
const MAX_NATIVE_QUEUE_BYTES = 4 * 1024 * 1024;
const MAX_NATIVE_QUEUE_EVENTS = 1000;
const NATIVE_STORE_METHODS = [
  "acknowledgeEventRecords",
  "appendEventRecord",
  "closeEventStore",
  "loadEventRecords",
  "purgeEventRecords"
];
const PERSISTENT_QUEUE_MODES = new Set(["auto", "disabled", "required"]);

export function resolveReactNativePersistentEventStore({
  authKey,
  eventStore,
  hasExplicitPersistentQueue = false,
  maxQueueBytes,
  maxQueueSize,
  persistentQueue = "auto"
}) {
  validatePersistentQueueMode(persistentQueue);
  if (eventStore !== undefined) {
    if (hasExplicitPersistentQueue) {
      throw new SdkError(
        "configuration_error",
        "eventStore and persistentQueue are mutually exclusive"
      );
    }
    return { eventStore, abort() {}, release() {} };
  }
  if (persistentQueue === "disabled") {
    return { eventStore: undefined, abort() {}, release() {} };
  }

  const nativeStore = defaultNativeStore();
  if (!nativeStore) {
    if (persistentQueue === "required") {
      throw new SdkError(
        "configuration_error",
        "React Native persistent queue requires the linked LogBrew native module"
      );
    }
    return { eventStore: undefined, abort() {}, release() {} };
  }
  validateNativeQueueLimits({ maxQueueBytes, maxQueueSize });
  if (ACTIVE_QUEUE_KEYS.has(authKey)) {
    throw new SdkError(
      "configuration_error",
      "React Native persistent queue already has an active client for this key"
    );
  }

  ACTIVE_QUEUE_KEYS.add(authKey);
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      ACTIVE_QUEUE_KEYS.delete(authKey);
    }
  };
  const nativeEventStore = createNativeEventStore(nativeStore, authKey, release);
  return {
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

export function purgeReactNativePersistentQueue({ apiKey, clientKey } = {}) {
  const authKey = clientKey ?? apiKey;
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
  const nativeStore = defaultNativeStore();
  if (!nativeStore) {
    throw new SdkError(
      "configuration_error",
      "React Native persistent queue requires the linked LogBrew native module"
    );
  }
  let failure;
  try {
    requireStatus(
      "purge",
      callNative(nativeStore, "purgeEventRecords", authKey),
      "purged"
    );
  } catch (error) {
    failure = error;
  }
  try {
    requireStatus(
      "close",
      callNative(nativeStore, "closeEventStore", authKey),
      "closed"
    );
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    throw failure;
  }
}

function createNativeEventStore(nativeStore, authKey, release) {
  return {
    load() {
      const result = requireStatus(
        "load",
        callNative(nativeStore, "loadEventRecords", authKey),
        "loaded"
      );
      if (!Array.isArray(result.records)) {
        throw persistenceFailure("load");
      }
      return result.records.map((record) => {
        if (!record
          || Array.isArray(record)
          || typeof record !== "object"
          || typeof record.serializedEvent !== "string"
          || !Number.isSafeInteger(record.eventBytes)
          || record.eventBytes <= 0) {
          throw persistenceFailure("load");
        }
        let event;
        try {
          event = JSON.parse(record.serializedEvent);
        } catch {
          throw persistenceFailure("load");
        }
        return {
          event,
          eventBytes: record.eventBytes,
          serializedEvent: record.serializedEvent
        };
      });
    },
    append(record) {
      requireStatus(
        "append",
        callNative(
          nativeStore,
          "appendEventRecord",
          authKey,
          record.serializedEvent,
          record.eventBytes
        ),
        "appended"
      );
    },
    acknowledge(count) {
      requireStatus(
        "acknowledge",
        callNative(nativeStore, "acknowledgeEventRecords", authKey, count),
        "acknowledged"
      );
    },
    purge() {
      requireStatus(
        "purge",
        callNative(nativeStore, "purgeEventRecords", authKey),
        "purged"
      );
    },
    close() {
      try {
        requireStatus(
          "close",
          callNative(nativeStore, "closeEventStore", authKey),
          "closed"
        );
      } finally {
        release();
      }
    }
  };
}

function defaultNativeStore() {
  try {
    const nativeStore = TurboModuleRegistry?.get?.("LogBrewFatalStore")
      ?? NativeModules?.LogBrewFatalStore;
    return NATIVE_STORE_METHODS.every((method) => typeof nativeStore?.[method] === "function")
      ? nativeStore
      : undefined;
  } catch {
    return undefined;
  }
}

function validateNativeQueueLimits({ maxQueueBytes, maxQueueSize }) {
  if (maxQueueBytes !== undefined
    && (!Number.isSafeInteger(maxQueueBytes)
      || maxQueueBytes <= 0
      || maxQueueBytes > MAX_NATIVE_QUEUE_BYTES)) {
    throw new SdkError(
      "configuration_error",
      `persistent React Native maxQueueBytes must be at most ${MAX_NATIVE_QUEUE_BYTES}`
    );
  }
  if (maxQueueSize !== undefined
    && (!Number.isSafeInteger(maxQueueSize)
      || maxQueueSize <= 0
      || maxQueueSize > MAX_NATIVE_QUEUE_EVENTS)) {
    throw new SdkError(
      "configuration_error",
      `persistent React Native maxQueueSize must be at most ${MAX_NATIVE_QUEUE_EVENTS}`
    );
  }
}

function validatePersistentQueueMode(mode) {
  if (!PERSISTENT_QUEUE_MODES.has(mode)) {
    throw new SdkError(
      "configuration_error",
      "persistentQueue must be auto, required, or disabled"
    );
  }
}

function callNative(nativeStore, method, ...args) {
  if (typeof nativeStore?.[method] !== "function") {
    throw persistenceFailure(methodName(method));
  }
  try {
    return nativeStore[method](...args);
  } catch {
    throw persistenceFailure(methodName(method));
  }
}

function requireStatus(operation, result, expected) {
  if (!result
    || Array.isArray(result)
    || typeof result !== "object"
    || result.status !== expected) {
    throw persistenceFailure(operation);
  }
  return result;
}

function methodName(method) {
  switch (method) {
    case "loadEventRecords":
      return "load";
    case "appendEventRecord":
      return "append";
    case "acknowledgeEventRecords":
      return "acknowledge";
    case "purgeEventRecords":
      return "purge";
    case "closeEventStore":
      return "close";
    default:
      return "operation";
  }
}

function persistenceFailure(operation) {
  return new SdkError(
    "persistence_error",
    `React Native persistent queue ${operation} failed`
  );
}
