const { withMetadata } = require("./event-metadata.cjs");
const { compactMetadata } = require("./log-context.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { parseTraceparent } = require("./trace-context.cjs");
const {
  isRecord,
  optionalEntry,
  requireAllowedValue,
  requireNonEmpty,
  requireSpanId,
  requireTimestamp,
  requireTraceId
} = require("./validation.cjs");

/**
 * @import { Metadata, SpanAttributes, SpanEventSummary, SpanLinkSummary } from "./index.cjs"
 * @import { EventAttributes } from "./event-validation.cjs"
 */

const MAX_SPAN_EVENTS = 8;
const MAX_SPAN_LINKS = 8;
const NO_ENTRIES = 0;
const MIN_DURATION_MS = 0;
/** @type {ReadonlySet<SpanAttributes["status"]>} */
const SPAN_STATUSES = new Set(["ok", "error"]);

/**
 * @param {unknown} metadata
 * @returns {Metadata | undefined}
 */
function nonEmptyMetadata(metadata) {
  if (metadata === undefined) {
    return undefined;
  }
  const compacted = compactMetadata(metadata);
  return Object.keys(compacted).length > NO_ENTRIES ? compacted : undefined;
}

/**
 * @param {unknown} durationMs
 * @returns {number | undefined}
 */
function optionalSpanDuration(durationMs) {
  if (durationMs === undefined) {
    return undefined;
  }
  if (typeof durationMs !== "number" || Number.isNaN(durationMs) || durationMs < MIN_DURATION_MS) {
    throw new SdkError("validation_error", "span durationMs must be non-negative");
  }
  return durationMs;
}

/**
 * @param {unknown} list
 * @param {string} label
 * @param {number} maxEntries
 * @returns {readonly unknown[] | undefined}
 */
function optionalBoundedList(list, label, maxEntries) {
  if (list === undefined) {
    return undefined;
  }
  if (!Array.isArray(list)) {
    throw new SdkError("validation_error", `${label} must be an array`);
  }
  if (list.length > maxEntries) {
    throw new SdkError("validation_error", `${label} must contain at most ${maxEntries} entries`);
  }
  return list.length === NO_ENTRIES ? undefined : list;
}

/**
 * @param {unknown} event
 * @returns {SpanEventSummary}
 */
function validateSpanEvent(event) {
  if (!isRecord(event)) {
    throw new SdkError("validation_error", "span event must be an object");
  }
  const name = requireNonEmpty("span event name", event["name"]);
  const timestamp = event["timestamp"] === undefined ? undefined : requireTimestamp(event["timestamp"]);
  return {
    name,
    ...optionalEntry("timestamp", timestamp),
    ...optionalEntry("metadata", nonEmptyMetadata(event["metadata"]))
  };
}

/**
 * @param {unknown} events
 * @returns {SpanEventSummary[] | undefined}
 */
function validateSpanEvents(events) {
  return optionalBoundedList(events, "span events", MAX_SPAN_EVENTS)?.map((event) => validateSpanEvent(event));
}

/**
 * @param {unknown} link
 * @returns {SpanLinkSummary}
 */
function validateSpanLink(link) {
  if (!isRecord(link)) {
    throw new SdkError("validation_error", "span link must be an object");
  }
  const traceId = requireTraceId(link["traceId"]);
  const spanId = requireSpanId("span link spanId", link["spanId"]);
  const { sampled } = link;
  if (sampled !== undefined && typeof sampled !== "boolean") {
    throw new SdkError("validation_error", "span link sampled must be a boolean");
  }
  return {
    traceId: traceId.toLowerCase(),

    spanId: spanId.toLowerCase(),
    ...optionalEntry("sampled", sampled),
    ...optionalEntry("metadata", nonEmptyMetadata(link["metadata"]))
  };
}

/**
 * @param {unknown} links
 * @returns {SpanLinkSummary[] | undefined}
 */
function validateSpanLinks(links) {
  return optionalBoundedList(links, "span links", MAX_SPAN_LINKS)?.map((link) => validateSpanLink(link));
}

/**
 * @param {Readonly<Record<string, unknown>>} attributes
 * @returns {EventAttributes}
 */
function validateSpan(attributes) {
  const name = requireNonEmpty("span name", attributes["name"]);
  const traceId = requireNonEmpty("span traceId", attributes["traceId"]);
  const spanId = requireNonEmpty("span spanId", attributes["spanId"]);
  const status = requireAllowedValue("span status", attributes["status"], SPAN_STATUSES);
  const parentSpanId = attributes["parentSpanId"] === undefined
    ? undefined
    : requireNonEmpty("span parentSpanId", attributes["parentSpanId"]);
  const durationMs = optionalSpanDuration(attributes["durationMs"]);
  const events = validateSpanEvents(attributes["events"]);
  const links = validateSpanLinks(attributes["links"]);
  return withMetadata({
    name,

    traceId,

    spanId,

    status,
    ...optionalEntry("parentSpanId", parentSpanId),
    ...optionalEntry("durationMs", durationMs),
    ...optionalEntry("events", events),
    ...optionalEntry("links", links)
  }, attributes["metadata"], attributes["context"]);
}

/**
 * @param {unknown} traceparent
 * @param {unknown} attributes
 * @returns {SpanAttributes}
 */
function spanAttributesFromTraceparent(traceparent, attributes) {
  if (!isRecord(attributes)) {
    throw new SdkError("validation_error", "span attributes must be an object");
  }
  const context = parseTraceparent(traceparent);
  const name = requireNonEmpty("span name", attributes["name"]);
  const spanId = requireSpanId("spanId", attributes["spanId"]);
  const status = requireAllowedValue("span status", attributes["status"], SPAN_STATUSES);
  const durationMs = optionalSpanDuration(attributes["durationMs"]);
  const events = validateSpanEvents(attributes["events"]);
  const links = validateSpanLinks(attributes["links"]);
  return {
    name,

    traceId: context.traceId,

    spanId: spanId.toLowerCase(),

    parentSpanId: context.parentSpanId,

    status,
    ...optionalEntry("durationMs", durationMs),
    ...optionalEntry("events", events),
    ...optionalEntry("links", links),
    ...optionalEntry("metadata", attributes["metadata"] === undefined ? undefined : compactMetadata(attributes["metadata"]))
  };
}

module.exports = { spanAttributesFromTraceparent, validateSpan };
