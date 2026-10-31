const { NULL_VALUE } = require("./null-value.cjs");
const {
  normalizeOpenTelemetrySpanContextIds,
  normalizeSpanId
} = require("./opentelemetry-context.cjs");
const { openTelemetryExceptionEventSummary } = require("./opentelemetry-exceptions.cjs");
const {
  openTelemetrySelectedMetadata,
  resolveOpenTelemetryReadableSpanOptions
} = require("./opentelemetry-keys.cjs");
const { durationMsFromOpenTelemetryReadableSpan, timestampFromOpenTelemetryTime } = require("./opentelemetry-time.cjs");
const { isList, isRecord, optionalProperty, stringOrUndefined } = require("./validation.cjs");

/**
 * @import { Metadata, SpanAttributes, SpanEventSummary, SpanLinkSummary } from "./index.cjs"
 * @import { ReadableSpanOptions, ResolvedSpanOptions } from "./opentelemetry-keys.cjs"
 * @typedef {Readonly<Record<string, unknown>>} ReadableSpan
 * @typedef {{ traceId: string, spanId: string, parentSpanId?: string, sampled: boolean }} ReadableSpanContext
 */

const MAX_SPAN_EVENTS = 8;
const MAX_SPAN_LINKS = 8;
const FIRST_ITEM = 0;
const EMPTY = 0;
const OTEL_STATUS_CODE_ERROR = 2;
const OTEL_STATUS_CODE_OK = 1;
const SPAN_KIND_INTERNAL = 0;
const SPAN_KIND_SERVER = 1;
const SPAN_KIND_CLIENT = 2;
const SPAN_KIND_PRODUCER = 3;
const SPAN_KIND_CONSUMER = 4;
/** @type {ReadonlyMap<unknown, string>} */
const OTEL_SPAN_KIND_NAMES = new Map([
  [SPAN_KIND_INTERNAL, "internal"],
  [SPAN_KIND_SERVER, "server"],
  [SPAN_KIND_CLIENT, "client"],
  [SPAN_KIND_PRODUCER, "producer"],
  [SPAN_KIND_CONSUMER, "consumer"]
]);

/**
 * @param {ReadableSpan} span
 * @returns {unknown}
 */
function readOpenTelemetrySpanContext(span) {
  const { spanContext } = span;
  if (typeof spanContext !== "function") {
    return undefined;
  }
  try {
    return Reflect.apply(spanContext, span, []);
  } catch {
    return undefined;
  }
}

/**
 * @param {ReadableSpan} span
 * @returns {ReadableSpanContext | undefined}
 */
function normalizeOpenTelemetryReadableSpanContext(span) {
  const context = normalizeOpenTelemetrySpanContextIds(readOpenTelemetrySpanContext(span));
  if (context === undefined) {
    return undefined;
  }
  const parentContext = normalizeOpenTelemetrySpanContextIds(span["parentSpanContext"]);
  const parentSpanId = parentContext?.traceId === context.traceId
    ? parentContext.spanId
    : normalizeSpanId(span["parentSpanId"]);
  return {
    traceId: context.traceId,

    spanId: context.spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    sampled: context.sampled
  };
}

/**
 * @param {unknown} kind
 * @returns {string | undefined}
 */
function openTelemetrySpanKindName(kind) {
  if (typeof kind === "number") {
    return OTEL_SPAN_KIND_NAMES.get(kind);
  }
  if (typeof kind === "string" && kind.trim() !== "") {
    return kind.toLowerCase();
  }
  return undefined;
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {Metadata}
 */
function positiveOpenTelemetryCount(key, value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > EMPTY ? { [key]: value } : {};
}

/**
 * @param {string} key
 * @param {string | undefined} value
 * @returns {Metadata}
 */
function definedEntry(key, value) {
  return value === undefined ? {} : { [key]: value };
}

/**
 * @param {ReadableSpan} span
 * @param {ResolvedSpanOptions} options
 * @returns {Metadata}
 */
function openTelemetryReadableSpanMetadata(span, options) {
  const resource = openTelemetrySelectedMetadata(optionalProperty(span["resource"], "attributes"), options.resourceAttributeKeys);
  const kind = openTelemetrySpanKindName(span["kind"]);
  const scopeName = stringOrUndefined(optionalProperty(span["instrumentationScope"], "name"));
  const scopeVersion = stringOrUndefined(optionalProperty(span["instrumentationScope"], "version"));
  return {
    source: "opentelemetry.readable_span",
    ...options.metadata,
    ...resource,
    ...definedEntry("otel.kind", kind),
    ...definedEntry("otel.scope.name", scopeName),
    ...definedEntry("otel.scope.version", scopeVersion),
    ...positiveOpenTelemetryCount("otel.dropped_attributes_count", span["droppedAttributesCount"]),
    ...positiveOpenTelemetryCount("otel.dropped_events_count", span["droppedEventsCount"]),
    ...positiveOpenTelemetryCount("otel.dropped_links_count", span["droppedLinksCount"]),
    ...openTelemetrySelectedMetadata(span["attributes"], options.attributeKeys)
  };
}

/**
 * @param {Readonly<Record<string, unknown>>} event
 * @param {ResolvedSpanOptions} options
 * @returns {SpanEventSummary}
 */
function openTelemetryEventSummary(event, options) {
  const eventName = event["name"];
  const name = typeof eventName === "string" && eventName.trim() !== "" ? eventName : "opentelemetry.event";
  const timestamp = timestampFromOpenTelemetryTime(event["time"] ?? event["timestamp"]);
  const metadata = openTelemetrySelectedMetadata(event["attributes"], options.eventAttributeKeys);
  return {
    name,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(Object.keys(metadata).length > EMPTY ? { metadata } : {})
  };
}

/**
 * @param {unknown} events
 * @param {ResolvedSpanOptions} options
 * @returns {SpanEventSummary[] | undefined}
 */
function openTelemetryReadableSpanEvents(events, options) {
  if (!isList(events) || events.length === EMPTY) {
    return undefined;
  }
  /** @type {SpanEventSummary[]} */
  const summaries = [];
  for (const event of events.slice(FIRST_ITEM, MAX_SPAN_EVENTS)) {
    if (isRecord(event)) {
      summaries.push(openTelemetryEventSummary(event, options));
    }
  }
  return summaries.length > EMPTY ? summaries : undefined;
}

/**
 * @param {unknown} link
 * @param {ResolvedSpanOptions} options
 * @returns {SpanLinkSummary | undefined}
 */
function openTelemetryLinkSummary(link, options) {
  const context = normalizeOpenTelemetrySpanContextIds(
    optionalProperty(link, "context") ?? optionalProperty(link, "spanContext")
  );
  if (context === undefined) {
    return undefined;
  }
  const metadata = openTelemetrySelectedMetadata(optionalProperty(link, "attributes"), options.linkAttributeKeys);
  return {
    traceId: context.traceId,

    spanId: context.spanId,

    sampled: context.sampled,
    ...(Object.keys(metadata).length > EMPTY ? { metadata } : {})
  };
}

/**
 * @param {unknown} links
 * @param {ResolvedSpanOptions} options
 * @returns {SpanLinkSummary[] | undefined}
 */
function openTelemetryReadableSpanLinks(links, options) {
  if (!isList(links) || links.length === EMPTY) {
    return undefined;
  }
  /** @type {SpanLinkSummary[]} */
  const summaries = [];
  for (const link of links.slice(FIRST_ITEM, MAX_SPAN_LINKS)) {
    const summary = openTelemetryLinkSummary(link, options);
    if (summary !== undefined) {
      summaries.push(summary);
    }
  }
  return summaries.length > EMPTY ? summaries : undefined;
}

/**
 * @param {ReadableSpan} span
 * @returns {string}
 */
function openTelemetrySpanName(span) {
  const { name } = span;
  return typeof name === "string" && name.trim() !== "" ? name : "opentelemetry.span";
}

/**
 * @param {unknown} status
 * @param {number} escapedExceptions
 * @returns {"ok" | "error"}
 */
function openTelemetrySpanStatus(status, escapedExceptions) {
  const code = optionalProperty(status, "code");
  if (code === OTEL_STATUS_CODE_ERROR || code === "ERROR") {
    return "error";
  }
  if (code === OTEL_STATUS_CODE_OK || code === "OK") {
    return "ok";
  }
  if (escapedExceptions > EMPTY) {
    return "error";
  }
  return "ok";
}

/**
 * @param {ReadableSpan} span
 * @param {ResolvedSpanOptions} options
 * @returns {SpanAttributes | undefined}
 */
function readableSpanAttributes(span, options) {
  const context = normalizeOpenTelemetryReadableSpanContext(span);
  if (context === undefined || (!options.captureUnsampled && !context.sampled)) {
    return undefined;
  }
  const metadata = openTelemetryReadableSpanMetadata(span, options);
  const events = options.includeSpanEvents ? openTelemetryReadableSpanEvents(span["events"], options) : undefined;
  const links = options.includeSpanLinks ? openTelemetryReadableSpanLinks(span["links"], options) : undefined;
  const exceptionSummary = openTelemetryExceptionEventSummary(span["events"]);
  const durationMs = durationMsFromOpenTelemetryReadableSpan(span);
  const resolvedMetadata = { ...metadata, ...exceptionSummary?.metadata() };
  return {
    name: openTelemetrySpanName(span),

    traceId: context.traceId,

    spanId: context.spanId,
    ...(context.parentSpanId === undefined ? {} : { parentSpanId: context.parentSpanId }),
    status: openTelemetrySpanStatus(span["status"], exceptionSummary?.escapedCount ?? EMPTY),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(events === undefined ? {} : { events }),
    ...(links === undefined ? {} : { links }),
    ...(Object.keys(resolvedMetadata).length > EMPTY ? { metadata: resolvedMetadata } : {})
  };
}

/**
 * @param {unknown} span
 * @param {ReadableSpanOptions} [options]
 * @returns {SpanAttributes | null}
 */
function spanAttributesFromOpenTelemetryReadableSpan(span, options = {}) {
  const resolvedOptions = resolveOpenTelemetryReadableSpanOptions(options);
  if (!isRecord(span)) {
    return NULL_VALUE;
  }
  return readableSpanAttributes(span, resolvedOptions) ?? NULL_VALUE;
}

module.exports = { readableSpanAttributes, spanAttributesFromOpenTelemetryReadableSpan };
