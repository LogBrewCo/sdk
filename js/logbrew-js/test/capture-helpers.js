import { LogBrewClient } from "@logbrew/sdk";
import assert from "node:assert/strict";

/**
 * @import { DroppedEvent, EventFilter, EventStore, StoredEvent } from "@logbrew/sdk"
 */

/**
 * @typedef {{
 *   readonly eventFilter?: EventFilter,
 *   readonly eventStore?: Readonly<EventStore>,
 *   readonly maxBatchBytes?: number,
 *   readonly maxBatchEvents?: number,
 *   readonly maxQueueBytes?: number,
 *   readonly maxQueueSize?: number,
 *   readonly maxRetries?: number,
 *   readonly onEventDropped?: (drop: Readonly<DroppedEvent>) => void
 * }} ClientOptions
 * @typedef {EventStore & { readonly calls: string[], readonly records: StoredEvent[] }} MemoryEventStore
 */

const CLIENT_IDENTITY = Object.freeze({ apiKey: "LOGBREW_API_KEY", sdkName: "logbrew-js", sdkVersion: "0.1.0" });
const FIRST_INDEX = 0;
const LAST_INDEX = -1;

/**
 * @param {ClientOptions} [options]
 * @returns {LogBrewClient}
 */
function createClient(options = {}) {
  return LogBrewClient.create({ ...CLIENT_IDENTITY, ...options });
}

/**
 * @param {string} value
 * @returns {unknown}
 */
function parseJson(value) {
  /** @type {unknown} */
  const parsed = JSON.parse(value);
  return parsed;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
  return isRecord(value) ? value[key] : undefined;
}

/**
 * @param {unknown} value
 * @param {string} keyPath
 * @returns {unknown}
 */
function pick(value, keyPath) {
  let current = value;
  for (const key of keyPath.split(".")) {
    current = field(current, key);
  }
  return current;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function recordAt(value, key) {
  const member = field(value, key);
  assert.ok(isRecord(member), `expected an object at ${key}`);
  return member;
}

/**
 * @param {unknown} value
 * @returns {readonly unknown[]}
 */
function items(value) {
  assert.ok(Array.isArray(value), "expected an array");
  /** @type {readonly unknown[]} */
  const list = value;
  return list;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {readonly unknown[]}
 */
function fieldOfEach(value, key) {
  return items(value).map((item) => field(item, key));
}

/**
 * @param {LogBrewClient} client
 * @returns {readonly unknown[]}
 */
function previewEvents(client) {
  const payload = parseJson(client.previewJson());
  return items(field(payload, "events"));
}

/**
 * @param {LogBrewClient} client
 * @returns {readonly unknown[]}
 */
function previewIds(client) {
  return fieldOfEach(previewEvents(client), "id");
}

/**
 * @param {LogBrewClient} client
 * @returns {Record<string, unknown>}
 */
function lastEventAttributes(client) {
  return recordAt(previewEvents(client).at(LAST_INDEX), "attributes");
}

/**
 * @param {unknown} value
 * @returns {value is StoredEvent}
 */
function isStoredEvent(value) {
  return isRecord(field(value, "event")) && typeof field(value, "serializedEvent") === "string" && typeof field(value, "eventBytes") === "number";
}

/**
 * @returns {MemoryEventStore}
 */
function memoryEventStore() {
  /** @type {string[]} */
  const calls = [];
  /** @type {StoredEvent[]} */
  const records = [];
  return {
    acknowledge(count) {
      records.splice(FIRST_INDEX, count);
    },
    /**
     * @param {unknown} record
     * @returns {void}
     */
    append(record) {
      assert.ok(isStoredEvent(record));
      records.push(structuredClone(record));
    },
    calls,
    close() {
      calls.push("close");
    },
    load() {
      return structuredClone(records);
    },
    purge() {
      records.splice(FIRST_INDEX);
    },
    records
  };
}

/**
 * @returns {MemoryEventStore}
 */
function removableEventStore() {
  const store = memoryEventStore();
  return {
    ...store,
    /**
     * @param {readonly number[]} indexes
     * @returns {void}
     */
    remove(indexes) {
      /** @type {StoredEvent[]} */
      const kept = [];
      for (const [index, record] of store.records.entries()) {
        if (!indexes.includes(index)) {
          kept.push(record);
        }
      }
      store.records.splice(FIRST_INDEX, store.records.length, ...kept);
    }
  };
}

export {
  CLIENT_IDENTITY,
  createClient,
  field,
  fieldOfEach,
  isRecord,
  items,
  lastEventAttributes,
  memoryEventStore,
  parseJson,
  pick,
  previewEvents,
  previewIds,
  recordAt,
  removableEventStore
};
