"use strict";

const { cloneObject, normalizeTraceparent, readList, utf8ByteLength } = require("./internal.cjs");
const { createLogBrewQueueTraceHeaders } = require("@logbrew/node");
const { parseJsonEnvelope } = require("./trace.cjs");

/**
 * @typedef {{ readonly maxEventBridgeRequestBytes?: number | undefined, readonly maxRequestBytes?: number | undefined }} EventBridgeInputOptions
 */

const TRACEPARENT_ATTRIBUTE = "traceparent";
const MAX_MESSAGE_ATTRIBUTES = 10;
const MAX_EVENTBRIDGE_PUT_EVENTS_BYTES = 1_048_576;
const EVENTBRIDGE_TIME_BYTES = 14;
const NO_BYTES = 0;

/**
 * @param {string | undefined} traceparent
 * @returns {string | undefined}
 */
function resolveTraceparent(traceparent) {
  return normalizeTraceparent(traceparent ?? createLogBrewQueueTraceHeaders().traceparent);
}

/**
 * @param {unknown} attributes
 * @param {string | undefined} traceparent
 * @returns {Record<string, unknown>}
 */
function withTraceparentAttribute(attributes, traceparent) {
  const nextAttributes = cloneObject(attributes);
  const normalizedTraceparent = resolveTraceparent(traceparent);
  if (normalizedTraceparent === undefined) {
    return nextAttributes;
  }
  if (!Object.hasOwn(nextAttributes, TRACEPARENT_ATTRIBUTE) && Object.keys(nextAttributes).length >= MAX_MESSAGE_ATTRIBUTES) {
    return nextAttributes;
  }
  return {
    ...nextAttributes,
    [TRACEPARENT_ATTRIBUTE]: {
      DataType: "String",
      StringValue: normalizedTraceparent
    }
  };
}

/**
 * @param {unknown} attributeNames
 * @returns {unknown[]}
 */
function withTraceparentAttributeName(attributeNames) {
  const names = readList(attributeNames).filter((name) => typeof name === "string" && name.trim() !== "");
  if (names.includes("All") || names.includes(".*") || names.includes(TRACEPARENT_ATTRIBUTE)) {
    return names;
  }
  return [...names, TRACEPARENT_ATTRIBUTE];
}

/**
 * @param {unknown} input
 * @param {string | undefined} traceparent
 * @returns {Record<string, unknown>}
 */
function withMessageAttributes(input, traceparent) {
  const source = cloneObject(input);
  return {
    ...source,
    MessageAttributes: withTraceparentAttribute(source["MessageAttributes"], traceparent)
  };
}

/**
 * @param {unknown} input
 * @param {string} entriesKey
 * @param {string | undefined} traceparent
 * @returns {Record<string, unknown>}
 */
function withEntryMessageAttributes(input, entriesKey, traceparent) {
  const source = cloneObject(input);
  const entries = source[entriesKey];
  if (!Array.isArray(entries)) {
    return source;
  }
  const normalizedTraceparent = resolveTraceparent(traceparent);
  return {
    ...source,
    [entriesKey]: entries.map((entry) => withMessageAttributes(entry, normalizedTraceparent))
  };
}

/**
 * @param {unknown} [input]
 * @param {string} [traceparent]
 * @returns {Record<string, unknown>}
 */
function createLogBrewSqsSendMessageInput(input, traceparent) {
  return withMessageAttributes(input, traceparent);
}

/**
 * @param {unknown} [input]
 * @param {string} [traceparent]
 * @returns {Record<string, unknown>}
 */
function createLogBrewSqsSendMessageBatchInput(input, traceparent) {
  return withEntryMessageAttributes(input, "Entries", traceparent);
}

/**
 * @param {unknown} [input]
 * @returns {Record<string, unknown>}
 */
function createLogBrewSqsReceiveMessageInput(input) {
  const source = cloneObject(input);
  return {
    ...source,
    MessageAttributeNames: withTraceparentAttributeName(source["MessageAttributeNames"])
  };
}

/**
 * @param {unknown} [input]
 * @param {string} [traceparent]
 * @returns {Record<string, unknown>}
 */
function createLogBrewSnsPublishInput(input, traceparent) {
  return withMessageAttributes(input, traceparent);
}

/**
 * @param {unknown} [input]
 * @param {string} [traceparent]
 * @returns {Record<string, unknown>}
 */
function createLogBrewSnsPublishBatchInput(input, traceparent) {
  return withEntryMessageAttributes(input, "PublishBatchRequestEntries", traceparent);
}

/**
 * @param {Readonly<Record<string, unknown>>} entry
 * @param {string} traceparent
 * @returns {Record<string, unknown>}
 */
function withEventBridgeDetailTraceparent(entry, traceparent) {
  const nextEntry = cloneObject(entry);
  const { Detail: detailText } = nextEntry;
  if (typeof detailText !== "string" || detailText.trim() === "") {
    return nextEntry;
  }
  const detail = parseJsonEnvelope(detailText, MAX_EVENTBRIDGE_PUT_EVENTS_BYTES);
  if (detail === undefined) {
    return nextEntry;
  }
  nextEntry["Detail"] = JSON.stringify({ ...detail, traceparent });
  return nextEntry;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function byteLengthIfString(value) {
  return typeof value === "string" ? utf8ByteLength(value) : NO_BYTES;
}

/**
 * @param {readonly number[]} values
 * @returns {number}
 */
function sum(values) {
  return values.reduce((total, value) => total + value, NO_BYTES);
}

/**
 * @param {Readonly<Record<string, unknown>>} entry
 * @returns {number}
 */
function putEventEntrySize(entry) {
  const timeSize = entry["Time"] === null || entry["Time"] === undefined ? NO_BYTES : EVENTBRIDGE_TIME_BYTES;
  const fieldsSize = sum(["Source", "DetailType", "Detail", "EventBusName"].map((key) => byteLengthIfString(entry[key])));
  return timeSize + fieldsSize + sum(readList(entry["Resources"]).map((resource) => byteLengthIfString(resource)));
}

/**
 * @param {readonly Readonly<Record<string, unknown>>[]} entries
 * @returns {number}
 */
function requestSize(entries) {
  return sum(entries.map((entry) => putEventEntrySize(entry)));
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeEventBridgeRequestByteLimit(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= NO_BYTES) {
    return MAX_EVENTBRIDGE_PUT_EVENTS_BYTES;
  }
  return Math.min(Math.floor(value), MAX_EVENTBRIDGE_PUT_EVENTS_BYTES);
}

/**
 * @param {unknown} [input]
 * @param {string} [traceparent]
 * @param {EventBridgeInputOptions} [options]
 * @returns {Record<string, unknown>}
 */
function createLogBrewEventBridgePutEventsInput(input, traceparent, options) {
  const source = cloneObject(input);
  if (!Array.isArray(source["Entries"])) {
    return source;
  }
  /** @type {readonly Readonly<Record<string, unknown>>[]} */
  const entries = readList(source["Entries"]).map((entry) => cloneObject(entry));
  const normalizedTraceparent = resolveTraceparent(traceparent);
  if (normalizedTraceparent === undefined) {
    return { ...source, Entries: entries };
  }
  const nextEntries = entries.map((entry) => withEventBridgeDetailTraceparent(entry, normalizedTraceparent));
  const maxRequestBytes = normalizeEventBridgeRequestByteLimit(options?.maxEventBridgeRequestBytes ?? options?.maxRequestBytes);
  return { ...source, Entries: requestSize(nextEntries) >= maxRequestBytes ? entries : nextEntries };
}

module.exports = {
  createLogBrewEventBridgePutEventsInput,
  createLogBrewSnsPublishBatchInput,
  createLogBrewSnsPublishInput,
  createLogBrewSqsReceiveMessageInput,
  createLogBrewSqsSendMessageBatchInput,
  createLogBrewSqsSendMessageInput
};
