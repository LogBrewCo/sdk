import { isRecord, nativeMethod, readField } from "./native-diagnostics-values.js";
import { SdkError } from "@logbrew/sdk";

/**
 * @typedef {{ event: unknown, eventBytes: number, serializedEvent: string }} NativeStoredEvent
 * @typedef {Readonly<{ eventBytes: unknown, serializedEvent: unknown }>} NativeAppendRecord
 * @typedef {{
 *   load: () => NativeStoredEvent[],
 *   append: (record: NativeAppendRecord) => void,
 *   acknowledge: (count: unknown) => void,
 *   purge: () => void,
 *   loadClientReport: () => unknown,
 *   saveClientReport: (state: unknown) => void,
 *   close: () => void,
 *   remove?: (indexes: unknown) => Readonly<Record<string, unknown>>
 * }} NativeEventStore
 */

/** @type {ReadonlyMap<string, string>} */
const METHOD_OPERATIONS = new Map([
  ["acknowledgeEventRecords", "acknowledge"],
  ["appendEventRecord", "append"],
  ["closeEventStore", "close"],
  ["loadEventRecords", "load"],
  ["purgeEventRecords", "purge"],
  ["removeEventRecords", "remove"]
]);
const CLIENT_REPORT_QUEUE_SUFFIX = ":client-report";
const MIN_EVENT_BYTES = 0;
const NO_RECORDS = 0;
const LAST_RECORD = -1;

/**
 * @param {string} operation
 * @returns {SdkError}
 */
function persistenceFailure(operation) {
  return new SdkError(
    "persistence_error",
    `React Native persistent queue ${operation} failed`
  );
}

/**
 * @param {unknown} nativeStore
 * @param {string} method
 * @param {readonly unknown[]} args
 * @returns {unknown}
 */
function callNative(nativeStore, method, ...args) {
  const native = nativeMethod(nativeStore, method, args);
  const operation = METHOD_OPERATIONS.get(method) ?? "operation";
  if (!native.found) {
    throw persistenceFailure(operation);
  }
  try {
    return native.call();
  } catch {
    throw persistenceFailure(operation);
  }
}

/**
 * @param {string} operation
 * @param {unknown} result
 * @param {string} expected
 * @returns {Readonly<Record<string, unknown>>}
 */
function requireStatus(operation, result, expected) {
  if (!isRecord(result) || result["status"] !== expected) {
    throw persistenceFailure(operation);
  }
  return result;
}

/**
 * @param {string} serializedEvent
 * @returns {unknown}
 */
function parseStoredEvent(serializedEvent) {
  try {
    /** @type {unknown} */
    const event = JSON.parse(serializedEvent);
    return event;
  } catch {
    throw persistenceFailure("load");
  }
}

/**
 * @param {unknown} record
 * @returns {NativeStoredEvent}
 */
function storedEvent(record) {
  if (!isRecord(record)) {
    throw persistenceFailure("load");
  }
  const { eventBytes, serializedEvent } = record;
  if (typeof serializedEvent !== "string"
    || typeof eventBytes !== "number"
    || !Number.isSafeInteger(eventBytes)
    || eventBytes <= MIN_EVENT_BYTES) {
    throw persistenceFailure("load");
  }
  return { event: parseStoredEvent(serializedEvent), eventBytes, serializedEvent };
}

/**
 * @param {unknown} nativeStore
 * @param {string} queueKey
 * @returns {NativeStoredEvent[]}
 */
function loadEvents(nativeStore, queueKey) {
  const { records } = requireStatus("load", callNative(nativeStore, "loadEventRecords", queueKey), "loaded");
  if (!Array.isArray(records)) {
    throw persistenceFailure("load");
  }
  return records.map(record => storedEvent(record));
}

/**
 * @param {unknown} nativeStore
 * @param {string} reportKey
 * @returns {unknown}
 */
function loadClientReport(nativeStore, reportKey) {
  const { records } = requireStatus("load", callNative(nativeStore, "loadEventRecords", reportKey), "loaded");
  const latest = Array.isArray(records) ? readField(records.at(LAST_RECORD), "serializedEvent") : undefined;
  if (typeof latest !== "string") {
    return undefined;
  }
  /** @type {unknown} */
  const state = JSON.parse(latest);
  return state;
}

/**
 * @param {unknown} nativeStore
 * @param {string} reportKey
 * @param {unknown} state
 */
function saveClientReport(nativeStore, reportKey, state) {
  const { records } = requireStatus("load", callNative(nativeStore, "loadEventRecords", reportKey), "loaded");
  const serialized = JSON.stringify(state);
  requireStatus(
    "append",
    callNative(nativeStore, "appendEventRecord", reportKey, serialized, serialized.length),
    "appended"
  );
  if (Array.isArray(records) && records.length > NO_RECORDS) {
    requireStatus(
      "acknowledge",
      callNative(nativeStore, "acknowledgeEventRecords", reportKey, records.length),
      "acknowledged"
    );
  }
}

/**
 * @param {unknown} nativeStore
 * @param {string} queueKey
 * @returns {boolean}
 */
function closeQuietly(nativeStore, queueKey) {
  try {
    callNative(nativeStore, "closeEventStore", queueKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} nativeStore
 * @param {string} authKey
 * @param {string} reportKey
 * @returns {NativeEventStore}
 */
function baseEventStore(nativeStore, authKey, reportKey) {
  return {
    load() {
      return loadEvents(nativeStore, authKey);
    },

    append(record) {
      requireStatus(
        "append",
        callNative(nativeStore, "appendEventRecord", authKey, record.serializedEvent, record.eventBytes),
        "appended"
      );
    },

    acknowledge(count) {
      requireStatus("acknowledge", callNative(nativeStore, "acknowledgeEventRecords", authKey, count), "acknowledged");
    },

    purge() {
      requireStatus("purge", callNative(nativeStore, "purgeEventRecords", authKey), "purged");
    },

    loadClientReport() {
      return loadClientReport(nativeStore, reportKey);
    },

    saveClientReport(state) {
      saveClientReport(nativeStore, reportKey, state);
    },

    close() {
      closeQuietly(nativeStore, reportKey);
      requireStatus("close", callNative(nativeStore, "closeEventStore", authKey), "closed");
    }
  };
}

/**
 * @param {unknown} nativeStore
 * @param {string} authKey
 * @param {() => void} release
 * @returns {NativeEventStore}
 */
function createNativeEventStore(nativeStore, authKey, release) {
  const reportKey = `${authKey}${CLIENT_REPORT_QUEUE_SUFFIX}`;
  const eventStore = baseEventStore(nativeStore, authKey, reportKey);
  const closeStore = eventStore.close;
  eventStore.close = function close() {
    try {
      closeStore();
    } finally {
      release();
    }
  };
  if (typeof readField(nativeStore, "removeEventRecords") === "function") {
    /**
     * @param {unknown} indexes
     * @returns {Readonly<Record<string, unknown>>}
     */
    eventStore.remove = indexes => requireStatus(
      "remove",
      callNative(nativeStore, "removeEventRecords", authKey, indexes),
      "removed"
    );
  }
  return eventStore;
}

export { callNative, createNativeEventStore, requireStatus };
