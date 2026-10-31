const { isObjectLike } = require("./error-details.cjs");
const { SdkError } = require("./sdk-error.cjs");
const {
  invalidStoredRecord,
  normalizeStoredRecord,
  requireSynchronousStoreResult,
  restoreStoredEvent
} = require("./stored-events.cjs");
const { isRecord } = require("./validation.cjs");

/**
 * @import { SdkEvent } from "./event-validation.cjs"
 * @import { StoredRecord } from "./stored-events.cjs"
 * @import { Callable, DeepReadonly } from "./validation.cjs"
 * @typedef {Readonly<{
 *   loadClientReport: () => unknown,
 *   saveClientReport: (state: unknown) => unknown
 * }>} ClientReportStore
 * @typedef {Readonly<{
 *   load: () => unknown,
 *   append: (record: Readonly<StoredRecord>) => unknown,
 *   acknowledge: (count: number) => unknown,
 *   purge: () => unknown,
 *   close: () => unknown,
 *   remove?: (indexes: readonly number[]) => unknown,
 *   loadClientReport?: () => unknown,
 *   saveClientReport?: (state: unknown) => unknown
 * }>} EventStore
 * @typedef {Readonly<{
 *   acknowledge: (count: unknown) => unknown,
 *   append: (record: unknown) => unknown,
 *   byteCount: () => unknown,
 *   close: () => unknown,
 *   eventBytesAt: (index: number) => unknown,
 *   events: () => unknown,
 *   length: () => unknown,
 *   serializedAt: (index: number) => unknown,
 *   remove?: (indexes: readonly number[]) => unknown,
 *   loadClientReport?: () => unknown,
 *   saveClientReport?: (state: unknown) => unknown
 * }>} EventQueueBackend
 * @typedef {Readonly<{
 *   batchPrefixBytes: number,
 *   batchSuffixBytes: number,
 *   maxBatchBytes: number,
 *   maxQueueBytes: number,
 *   maxQueueSize: number
 * }>} StoreLimits
 */

const EVENT_STORE_METHODS = Object.freeze(["load", "append", "acknowledge", "purge", "close"]);
const EVENT_QUEUE_METHODS = Object.freeze(["acknowledge", "append", "byteCount", "close", "eventBytesAt", "events", "length", "serializedAt"]);

/**
 * @param {unknown} store
 * @returns {store is ClientReportStore}
 */
function isClientReportStore(store) {
  return isObjectLike(store)
    && typeof Reflect.get(store, "loadClientReport") === "function"
    && typeof Reflect.get(store, "saveClientReport") === "function";
}

/**
 * @param {Readonly<Record<string, unknown>>} value
 * @param {readonly string[]} methods
 * @returns {string | undefined}
 */
function missingMethod(value, methods) {
  return methods.find((method) => typeof value[method] !== "function");
}

/**
 * @param {Readonly<Record<string, unknown>>} value
 * @returns {value is EventStore}
 */
function isEventStore(value) {
  return missingMethod(value, EVENT_STORE_METHODS) === undefined;
}

/**
 * @param {unknown} eventStore
 * @returns {EventStore | undefined}
 */
function validateEventStore(eventStore) {
  if (eventStore === undefined) {
    return undefined;
  }
  if (!isRecord(eventStore)) {
    throw new SdkError("validation_error", "eventStore must be an object");
  }
  const missing = missingMethod(eventStore, EVENT_STORE_METHODS);
  if (missing !== undefined) {
    throw new SdkError("validation_error", `eventStore.${missing} must be a function`);
  }
  return isEventStore(eventStore) ? eventStore : undefined;
}

/**
 * @param {unknown} queue
 * @returns {queue is EventQueueBackend}
 */
function isEventQueueBackend(queue) {
  return isRecord(queue) && missingMethod(queue, EVENT_QUEUE_METHODS) === undefined;
}

/**
 * @param {EventQueueBackend} queue
 * @returns {unknown[]}
 */
function loadQueueRecords(queue) {
  const events = queue.events();
  const count = queue.length();
  if (!Array.isArray(events) || events.length !== count) {
    throw invalidStoredRecord();
  }
  /** @type {readonly unknown[]} */
  const loaded = events;
  return loaded.map((event, index) => ({
    event,
    eventBytes: queue.eventBytesAt(index),
    serializedEvent: queue.serializedAt(index)
  }));
}

/**
 * @param {EventQueueBackend} queue
 * @returns {Partial<EventStore>}
 */
function optionalQueueMethods(queue) {
  const { remove } = queue;
  return {
    ...(typeof remove === "function" ? { remove: (indexes) => queue.remove?.(indexes) } : {}),
    ...(isClientReportStore(queue)
      ? { loadClientReport: () => queue.loadClientReport(), saveClientReport: (state) => queue.saveClientReport(state) }
      : {})
  };
}

/**
 * @param {Callable} eventQueueFactory
 * @param {StoreLimits} limits
 * @returns {EventStore}
 */
function createEventStoreFromQueueFactory(eventQueueFactory, limits) {
  /** @type {unknown} */
  const queue = Reflect.apply(eventQueueFactory, undefined, [{ ...limits, restoreEvent: restoreStoredEvent }]);
  if (!isEventQueueBackend(queue)) {
    throw new SdkError("validation_error", "event queue factory returned an invalid queue");
  }
  return {
    load: () => loadQueueRecords(queue),

    append: (record) => queue.append({
      event: record.event,

      byteCount: record.eventBytes,

      serialized: record.serializedEvent
    }),

    acknowledge: (count) => queue.acknowledge(count),

    purge: () => queue.acknowledge(queue.length()),

    close: () => queue.close(),
    ...optionalQueueMethods(queue)
  };
}

class RecoveredEvents {
  /**
   * @param {StoreLimits} limits
   */
  constructor(limits) {
    this.limits = limits;
    /** @type {DeepReadonly<SdkEvent>[]} */
    this.events = [];
    this.queuedEventBytes = 0;
    /** @type {number[]} */
    this.serializedEventBytes = [];
    /** @type {string[]} */
    this.serializedEvents = [];
  }

  /**
   * @param {Readonly<StoredRecord>} normalized
   * @returns {void}
   */
  add(normalized) {
    const { limits } = this;
    if (limits.batchPrefixBytes + normalized.eventBytes + limits.batchSuffixBytes > limits.maxBatchBytes) {
      throw new SdkError("persistence_error", "recovered event exceeds maxBatchBytes");
    }
    this.queuedEventBytes += normalized.eventBytes;
    if (this.queuedEventBytes > limits.maxQueueBytes) {
      throw new SdkError("persistence_error", "recovered event bytes exceed maxQueueBytes");
    }
    this.events.push(normalized.event);
    this.serializedEvents.push(normalized.serializedEvent);
    this.serializedEventBytes.push(normalized.eventBytes);
  }
}

/**
 * @param {EventStore} eventStore
 * @param {number} maxQueueSize
 * @returns {readonly unknown[]}
 */
function storedRecords(eventStore, maxQueueSize) {
  const records = requireSynchronousStoreResult("load", eventStore.load());
  if (!Array.isArray(records)) {
    throw invalidStoredRecord();
  }
  if (records.length > maxQueueSize) {
    throw new SdkError("persistence_error", "recovered event count exceeds maxQueueSize");
  }
  /** @type {readonly unknown[]} */
  const loaded = records;
  return loaded;
}

/**
 * @param {EventStore | undefined} eventStore
 * @param {StoreLimits} limits
 * @returns {RecoveredEvents}
 */
function loadStoredEvents(eventStore, limits) {
  const recovered = new RecoveredEvents(limits);
  const records = eventStore === undefined ? [] : storedRecords(eventStore, limits.maxQueueSize);
  for (const record of records) {
    recovered.add(normalizeStoredRecord(record));
  }
  return recovered;
}

module.exports = { createEventStoreFromQueueFactory, isClientReportStore, loadStoredEvents, validateEventStore };
