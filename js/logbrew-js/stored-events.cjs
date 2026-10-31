const { isObjectLike } = require("./error-details.cjs");
const { cloneEvent } = require("./event-clone.cjs");
const { EVENT_VALIDATORS, isEventType } = require("./event-validation.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { utf8ByteLength } = require("./utf8.cjs");
const { isRecord, requireNonEmpty, requireTimestamp } = require("./validation.cjs");

/**
 * @import { EventType, EventValidator, SdkEvent } from "./event-validation.cjs"
 * @import { DeepReadonly } from "./validation.cjs"
 * @typedef {{ event: DeepReadonly<SdkEvent>, eventBytes: number, serializedEvent: string }} StoredRecord
 * @typedef {Readonly<Record<string, unknown>>} UnknownRecord
 * @typedef {{
 *   attributes: UnknownRecord,
 *   event: UnknownRecord,
 *   eventBytes: number,
 *   header: { type: EventType, id: string, timestamp: string },
 *   serializedEvent: string,
 *   validator: EventValidator
 * }} RecordParts
 */

const MIN_EVENT_BYTES = 0;
const CONTEXT_SCHEMA_VERSION = 1;
const KEY_INDEX = 0;
const STEP = 1;

/**
 * @returns {InstanceType<typeof SdkError>}
 */
function invalidStoredRecord() {
  return new SdkError("persistence_error", "event store returned an invalid record");
}

/**
 * @param {string} operation
 * @param {unknown} result
 * @returns {unknown}
 */
function requireSynchronousStoreResult(operation, result) {
  if (isObjectLike(result) && typeof Reflect.get(result, "then") === "function") {
    throw new SdkError("persistence_error", `eventStore.${operation} must complete synchronously`);
  }
  return result;
}

/**
 * @param {readonly [string, unknown]} left
 * @param {readonly [string, unknown]} right
 * @returns {number}
 */
function byKey(left, right) {
  return left[KEY_INDEX].localeCompare(right[KEY_INDEX]);
}

/**
 * @param {string} _key
 * @param {unknown} entry
 * @returns {unknown}
 */
function sortedEntries(_key, entry) {
  if (!isRecord(entry)) {
    return entry;
  }
  const entries = Object.entries(entry);
  entries.sort(byKey);
  return Object.fromEntries(entries);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function structuralJson(value) {
  return JSON.stringify(value, sortedEntries);
}

/**
 * @param {UnknownRecord} event
 * @param {UnknownRecord} attributes
 * @returns {{ event: UnknownRecord, attributes: UnknownRecord }}
 */
function recoveredEvent(event, attributes) {
  const fatalAttributes = event["type"] === "issue" && attributes["level"] === "fatal"
    ? { ...attributes, level: "critical" }
    : attributes;
  const { context } = fatalAttributes;
  const recoveredAttributes = isRecord(context) && context["schemaVersion"] === undefined
    ? { ...fatalAttributes, context: { schemaVersion: CONTEXT_SCHEMA_VERSION, ...context } }
    : fatalAttributes;
  return { attributes: recoveredAttributes, event: { ...event, attributes: recoveredAttributes } };
}

/**
 * @param {unknown} eventBytes
 * @param {unknown} serializedEvent
 * @returns {Readonly<{ eventBytes: number, serializedEvent: string }>}
 */
function storedPayload(eventBytes, serializedEvent) {
  if (typeof eventBytes !== "number" || !Number.isSafeInteger(eventBytes) || eventBytes <= MIN_EVENT_BYTES || typeof serializedEvent !== "string") {
    throw invalidStoredRecord();
  }
  return { eventBytes, serializedEvent };
}

/**
 * @param {UnknownRecord} event
 * @param {Readonly<{ eventBytes: number, serializedEvent: string }>} payload
 * @returns {RecordParts}
 */
function storedEventParts(event, payload) {
  const { type } = event;
  const validator = isEventType(type) ? EVENT_VALIDATORS.get(type) : undefined;
  if (!isEventType(type) || validator === undefined) {
    throw invalidStoredRecord();
  }
  const header = {
    type,

    id: requireNonEmpty("event id", event["id"]),

    timestamp: requireTimestamp(event["timestamp"])
  };
  const { attributes } = event;
  if (!isRecord(attributes)) {
    throw invalidStoredRecord();
  }
  return { ...payload, attributes, event, header, validator };
}

/**
 * @param {UnknownRecord} record
 * @returns {RecordParts}
 */
function storedRecordParts(record) {
  const { event, eventBytes, serializedEvent } = record;
  if (!isRecord(event)) {
    throw invalidStoredRecord();
  }
  return storedEventParts(event, storedPayload(eventBytes, serializedEvent));
}

/**
 * @param {Readonly<RecordParts["header"]>} header
 * @param {Readonly<{ event: UnknownRecord, attributes: UnknownRecord }>} recovered
 * @param {EventValidator} validator
 * @returns {StoredRecord}
 */
function normalizedRecord(header, recovered, validator) {
  /** @type {SdkEvent} */
  const normalizedEvent = { ...header, attributes: validator(recovered.attributes) };
  const normalizedSerializedEvent = JSON.stringify(normalizedEvent);
  if (structuralJson(normalizedEvent) !== structuralJson(recovered.event)) {
    throw invalidStoredRecord();
  }
  return {
    event: cloneEvent(normalizedEvent),
    eventBytes: utf8ByteLength(normalizedSerializedEvent),
    serializedEvent: normalizedSerializedEvent
  };
}

/**
 * @param {unknown} record
 * @returns {StoredRecord}
 */
function normalizeRecord(record) {
  if (!isRecord(record)) {
    throw invalidStoredRecord();
  }
  const { attributes, event, eventBytes, header, serializedEvent, validator } = storedRecordParts(record);
  if (JSON.stringify(event) !== serializedEvent || utf8ByteLength(serializedEvent) !== eventBytes) {
    throw invalidStoredRecord();
  }
  return normalizedRecord(header, recoveredEvent(event, attributes), validator);
}

/**
 * @param {unknown} record
 * @returns {StoredRecord}
 */
function normalizeStoredRecord(record) {
  try {
    return normalizeRecord(record);
  } catch (error) {
    if (error instanceof SdkError && error.code === "persistence_error") {
      throw error;
    }
    throw invalidStoredRecord();
  }
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
    throw invalidStoredRecord();
  }
}

/**
 * @param {unknown} serializedEvent
 * @returns {DeepReadonly<SdkEvent>}
 */
function restoreStoredEvent(serializedEvent) {
  if (typeof serializedEvent !== "string" || serializedEvent === "") {
    throw invalidStoredRecord();
  }
  return normalizeStoredRecord({
    event: parseStoredEvent(serializedEvent),
    eventBytes: utf8ByteLength(serializedEvent),
    serializedEvent
  }).event;
}

/**
 * @param {readonly string[]} expected
 * @param {readonly string[]} actual
 * @returns {boolean}
 */
function isOrderedSubsequence(expected, actual) {
  let index = 0;
  for (const value of actual) {
    if (value === expected[index]) {
      index += STEP;
    }
  }
  return index === expected.length;
}

module.exports = {
  invalidStoredRecord,
  isOrderedSubsequence,
  normalizeStoredRecord,
  requireSynchronousStoreResult,
  restoreStoredEvent
};
