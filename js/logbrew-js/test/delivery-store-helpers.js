import assert from "node:assert/strict";

/**
 * @typedef {{ readonly event: unknown, readonly eventBytes: number, readonly serializedEvent: string }} StoredRecord
 * @typedef {{ readonly byteCount: number, readonly event: unknown, readonly serialized: string }} QueueRecord
 * @typedef {readonly [string, ...unknown[]]} StoreCall
 */

/**
 * @template R
 * @typedef {{ acknowledge: (count: number) => void, append: (record: Readonly<R>) => void, readonly calls: StoreCall[], close: () => void, readonly records: Readonly<R>[] }} MutableRecordingStore
 */

/**
 * @typedef {MutableRecordingStore<StoredRecord> & { readonly load: () => StoredRecord[], readonly purge: () => void }} RecordingEventStore
 * @typedef {MutableRecordingStore<QueueRecord> & {
 *   readonly byteCount: () => number,
 *   readonly eventBytesAt: (index: number) => number,
 *   readonly events: () => unknown[],
 *   readonly length: () => number,
 *   readonly serializedAt: (index: number) => string
 * }} RecordingEventQueue
 */

const EVENT_QUEUE_FACTORY = Symbol.for("@logbrew/sdk.eventQueueFactory");
const START = 0;

/**
 * @param {string} type
 * @param {string} id
 * @param {Readonly<Record<string, unknown>>} [attributes]
 * @returns {StoredRecord}
 */
function storedEvent(type, id, attributes) {
  const event = {
    attributes: attributes ?? { level: "info", message: "persisted" },
    id,
    timestamp: "2026-06-02T10:00:00Z",
    type
  };
  const serializedEvent = JSON.stringify(event);
  return { event, eventBytes: Buffer.byteLength(serializedEvent, "utf8"), serializedEvent };
}

/**
 * @param {readonly StoreCall[]} calls
 * @returns {string[]}
 */
function callNames(calls) {
  return calls.map(([name]) => name);
}

/**
 * @template R
 * @param {readonly Readonly<R>[]} initialRecords
 * @returns {MutableRecordingStore<R>}
 */
function mutableRecordingStore(initialRecords) {
  /** @type {StoreCall[]} */
  const calls = [];
  const records = [...initialRecords];
  return {
    acknowledge(count) {
      calls.push(["acknowledge", count]);
      records.splice(START, count);
    },
    append(record) {
      calls.push(["append", structuredClone(record)]);
      records.push(structuredClone(record));
    },
    calls,
    close() {
      calls.push(["close"]);
    },
    records
  };
}

/**
 * @param {readonly StoredRecord[]} initialRecords
 * @returns {RecordingEventStore}
 */
function recordingEventStore(initialRecords = []) {
  const store = mutableRecordingStore(initialRecords.map((record) => structuredClone(record)));
  return Object.assign(store, {
    load() {
      store.calls.push(["load"]);
      return store.records.map((record) => structuredClone(record));
    },
    purge() {
      store.calls.push(["purge"]);
      store.records.splice(START);
    }
  });
}

/**
 * @param {readonly QueueRecord[]} records
 * @param {number} index
 * @returns {QueueRecord}
 */
function queueRecordAt(records, index) {
  const record = records[index];
  assert.ok(record);
  return record;
}

/**
 * @param {readonly StoredRecord[]} initialRecords
 * @returns {RecordingEventQueue}
 */
function recordingEventQueue(initialRecords = []) {
  const store = mutableRecordingStore(initialRecords.map(({ event, eventBytes, serializedEvent }) => ({
    byteCount: eventBytes,
    event: structuredClone(event),
    serialized: serializedEvent
  })));
  return Object.assign(store, {
    byteCount() {
      return store.records.reduce((total, record) => total + record.byteCount, START);
    },
    /**
     * @param {number} index
     * @returns {number}
     */
    eventBytesAt(index) {
      return queueRecordAt(store.records, index).byteCount;
    },
    events() {
      return store.records.map((record) => structuredClone(record.event));
    },
    length() {
      return store.records.length;
    },
    /**
     * @param {number} index
     * @returns {string}
     */
    serializedAt(index) {
      return queueRecordAt(store.records, index).serialized;
    }
  });
}

export { EVENT_QUEUE_FACTORY, callNames, recordingEventQueue, recordingEventStore, storedEvent };
