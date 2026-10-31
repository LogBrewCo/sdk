"use strict";

const { createTraceparentHeaders, parseTraceparent } = require("@logbrew/sdk");

/**
 * @import { SpanLinkSummary, TraceparentContext } from "@logbrew/sdk"
 * @import { LogBrewQueueTraceHeaders, LogBrewTraceContext } from "./index.cjs"
 */

/**
 * @typedef {string | number | boolean | null} QueueLinkMetadataValue
 * @typedef {{ readonly sampled: boolean, readonly spanId: string, readonly traceId: string }} NormalizedTraceContext
 * @typedef {{ readonly metadata?: Readonly<Record<string, QueueLinkMetadataValue>> }} QueueLinkMetadataFields
 * @typedef {{ links?: unknown, linkMetadata?: unknown, messageCount?: unknown, messages?: unknown }} QueueBatchSpanOptionsInput
 */

const MAX_QUEUE_TRACE_LINKS = 8;
const FIRST_ITEM = 0;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/u;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const ZERO_SPAN_ID = "0000000000000000";
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const UNSAFE_KEY_CHARACTERS = /[^a-z0-9]/gu;
const UNSAFE_QUEUE_LINK_METADATA_KEYS = new Set([
  "args",
  "body",
  "brokerurl",
  "cookie",
  "headers",
  "message",
  "messagebody",
  "payload",
  "rawmessage",
  ["se", "cret"].join(""),
  ["to", "ken"].join(""),
  "traceparent",
  "url"
]);

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {unknown}
 */
function readMember(value, name) {
  if (isObjectLike(value) || typeof value === "function") {
    return Reflect.get(value, name);
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  return Reflect.get(new Object(value), name);
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeSpanId(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const spanId = value.toLowerCase();
  if (!SPAN_ID_PATTERN.test(spanId) || spanId === ZERO_SPAN_ID) {
    return undefined;
  }
  return spanId;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeTraceId(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const traceId = value.toLowerCase();
  if (!TRACE_ID_PATTERN.test(traceId) || traceId === ZERO_TRACE_ID) {
    return undefined;
  }
  return traceId;
}

/**
 * @param {unknown} trace
 * @returns {NormalizedTraceContext | undefined}
 */
function normalizeTraceContext(trace) {
  if (!isObjectLike(trace)) {
    return undefined;
  }
  const traceId = normalizeTraceId(Reflect.get(trace, "traceId"));
  const spanId = normalizeSpanId(Reflect.get(trace, "spanId"));
  if (traceId === undefined || traceId === "" || spanId === undefined || spanId === "") {
    return undefined;
  }
  return {
    traceId,

    spanId,

    sampled: Reflect.get(trace, "sampled") === true
  };
}

/**
 * @param {unknown} value
 * @returns {TraceparentContext | undefined}
 */
function tryParseTraceparent(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return parseTraceparent(value);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {Function | undefined}
 */
function nodeBufferToString(value) {
  if (!isObjectLike(value)) {
    return undefined;
  }
  const toString = readMember(value, "toString");
  if (typeof toString !== "function") {
    return undefined;
  }
  const constructor = readMember(value, "constructor");
  const isBuffer = readMember(constructor, "isBuffer");
  return typeof isBuffer === "function" && Boolean(Reflect.apply(isBuffer, constructor, [value])) ? toString : undefined;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function carrierValue(value) {
  if (Array.isArray(value)) {
    /** @type {readonly unknown[]} */
    const values = value;
    const [first] = values;
    return typeof first === "string" ? first : undefined;
  }
  const toString = nodeBufferToString(value);
  if (toString) {
    return Reflect.apply(toString, value, ["utf8"]);
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {unknown} carrier
 * @returns {unknown}
 */
function getTraceparentValue(carrier) {
  if (typeof carrier === "string") {
    return carrier;
  }
  if (!isObjectLike(carrier)) {
    return undefined;
  }
  const get = readMember(carrier, "get");
  if (typeof get === "function") {
    /** @type {unknown} */
    const value = Reflect.apply(get, carrier, ["traceparent"]);
    return typeof value === "string" ? value : undefined;
  }
  return carrierValue(Reflect.get(carrier, "traceparent") ?? Reflect.get(carrier, "traceParent"));
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function isSafeQueueLinkMetadataKey(key) {
  return !UNSAFE_QUEUE_LINK_METADATA_KEYS.has(key.toLowerCase().replaceAll(UNSAFE_KEY_CHARACTERS, ""));
}

/**
 * @param {unknown} value
 * @returns {value is QueueLinkMetadataValue}
 */
function isQueueLinkMetadataValue(value) {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * @param {unknown} metadata
 * @returns {Record<string, QueueLinkMetadataValue>}
 */
function primitiveMetadata(metadata) {
  if (!isObjectLike(metadata) || Array.isArray(metadata)) {
    return {};
  }
  /** @type {[string, QueueLinkMetadataValue][]} */
  const entries = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (isSafeQueueLinkMetadataKey(key) && isQueueLinkMetadataValue(value)) {
      entries.push([key, value]);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * @param {unknown} metadata
 * @returns {QueueLinkMetadataFields}
 */
function safeQueueLinkMetadata(metadata) {
  const safeMetadata = primitiveMetadata(metadata);
  return Object.keys(safeMetadata).length > FIRST_ITEM ? { metadata: safeMetadata } : {};
}

/**
 * @param {unknown} trace
 * @returns {LogBrewQueueTraceHeaders}
 */
function createLogBrewQueueTraceHeaders(trace) {
  const context = normalizeTraceContext(trace);
  if (!context) {
    return {};
  }
  return createTraceparentHeaders({
    traceId: context.traceId,

    spanId: context.spanId,

    traceFlags: context.sampled ? "01" : "00"
  });
}

/**
 * @param {unknown} carrier
 * @param {QueueLinkMetadataFields} metadataFields
 * @returns {SpanLinkSummary | undefined}
 */
function queueTraceLink(carrier, metadataFields) {
  const traceparent = getTraceparentValue(carrier);
  const context = traceparent === undefined || traceparent === "" ? undefined : tryParseTraceparent(traceparent);
  if (!context) {
    return undefined;
  }
  return {
    traceId: context.traceId,

    spanId: context.parentSpanId,

    sampled: context.sampled,
    ...metadataFields
  };
}

/**
 * @param {unknown} carriers
 * @param {unknown} metadata
 * @returns {SpanLinkSummary[]}
 */
function createLogBrewQueueTraceLinks(carriers, metadata) {
  /** @type {readonly unknown[]} */
  const values = Array.isArray(carriers) ? carriers : [carriers];
  const metadataFields = safeQueueLinkMetadata(metadata);
  /** @type {SpanLinkSummary[]} */
  const links = [];
  for (const carrier of values) {
    if (links.length >= MAX_QUEUE_TRACE_LINKS) {
      break;
    }
    const link = queueTraceLink(carrier, metadataFields);
    if (link) {
      links.push(link);
    }
  }
  return links;
}

/**
 * @param {unknown} message
 * @returns {unknown}
 */
function queueMessageTraceCarrier(message) {
  if (isObjectLike(message) && "headers" in message) {
    return message.headers;
  }
  return message;
}

/**
 * @param {readonly SpanLinkSummary[]} generatedLinks
 * @param {unknown} explicitLinks
 * @returns {unknown[]}
 */
function mergeQueueSpanLinks(generatedLinks, explicitLinks) {
  /** @type {unknown[]} */
  const links = generatedLinks.slice(FIRST_ITEM, MAX_QUEUE_TRACE_LINKS);
  if (links.length < MAX_QUEUE_TRACE_LINKS && Array.isArray(explicitLinks)) {
    /** @type {readonly unknown[]} */
    const explicit = explicitLinks;
    links.push(...explicit.slice(FIRST_ITEM, MAX_QUEUE_TRACE_LINKS - links.length));
  }
  return links;
}

/**
 * @template {QueueBatchSpanOptionsInput} Options
 * @param {Options} options
 * @returns {Options & { links?: unknown[], messageCount?: number }}
 */
function createLogBrewQueueBatchSpanOptions(options) {
  /** @type {readonly unknown[] | undefined} */
  const messages = Array.isArray(options.messages) ? options.messages : undefined;
  const generatedLinks = messages
    ? createLogBrewQueueTraceLinks(messages.map((message) => queueMessageTraceCarrier(message)), options.linkMetadata)
    : [];
  const links = mergeQueueSpanLinks(generatedLinks, options.links);
  return {
    ...options,
    ...(messages && options.messageCount === undefined ? { messageCount: messages.length } : {}),
    ...(links.length > FIRST_ITEM ? { links } : {})
  };
}

/**
 * @param {unknown} value
 * @returns {LogBrewTraceContext | undefined}
 */
function traceContextFromTraceparent(value) {
  const context = tryParseTraceparent(value);
  if (!context) {
    return undefined;
  }
  return {
    traceId: context.traceId,

    spanId: context.parentSpanId,

    sampled: context.sampled
  };
}

/**
 * @template Trace
 * @param {{ readonly trace?: Trace, readonly traceparent?: unknown }} options
 * @param {Trace | undefined} activeTrace
 * @returns {Trace | LogBrewTraceContext | undefined}
 */
function resolveOperationTrace(options, activeTrace) {
  return options.trace ?? traceContextFromTraceparent(options.traceparent) ?? activeTrace;
}

module.exports = {
  createLogBrewQueueBatchSpanOptions,
  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  normalizeSpanId,
  normalizeTraceId,
  resolveOperationTrace
};
