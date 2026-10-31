"use strict";

const { readMember } = require("./internal.cjs");

/**
 * @import { LogBrewTraceContext } from "./index.cjs"
 */

/**
 * @typedef {Readonly<{
 *   span: (id: unknown, timestamp: unknown, attributes: Readonly<Record<string, unknown>>) => unknown
 * }>} SpanSink
 * @typedef {Readonly<{
 *   client?: SpanSink | undefined,
 *   links?: unknown,
 *   now?: unknown,
 *   nowMs?: unknown,
 *   onCaptureError?: unknown
 * }>} SpanOptions
 * @typedef {SpanOptions & Readonly<{ client: SpanSink }>} ClientSpanOptions
 * @typedef {Readonly<{ nowMs?: unknown, onCaptureError?: unknown }>} HookOptions
 * @typedef {Readonly<{
 *   durationMs: number,
 *   events: unknown,
 *   id: unknown,
 *   metadata: Readonly<Record<string, unknown>>,
 *   name: string,
 *   status: "error" | "ok",
 *   trace: LogBrewTraceContext
 * }>} SpanRecord
 * @typedef {string | number | boolean | null} PrimitiveMetadataValue
 * @typedef {Record<string, PrimitiveMetadataValue>} PrimitiveMetadata
 */

const MAX_SPAN_EVENTS = 8;
const NO_DURATION = 0;
const NO_EVENTS = 0;
const FIRST_ITEM = 0;
const NON_SLUG_CHARACTERS = /[^a-z0-9]+/gu;
const EDGE_UNDERSCORES = /^_+|_+$/gu;
const NON_KEY_CHARACTERS = /[^a-z0-9]/gu;
const LOCAL_ORIGIN = "http://localhost";
const BLOCKED_FETCH_METADATA_KEYS = new Set([
  "authorization",
  "body",
  "cookie",
  "error",
  "errormessage",
  "headers",
  "host",
  "message",
  "payload",
  "query",
  "rawurl",
  ["se", "cret"].join(""),
  ["to", "ken"].join(""),
  "traceparent",
  "url"
]);

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @template Options
 * @param {Options} options
 * @returns {options is Options & ClientSpanOptions}
 */
function hasClient(options) {
  return Boolean(readMember(options, "client"));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function pathOnly(value) {
  const rawValue = typeof value === "string" ? value : String(value);
  try {
    return new URL(rawValue, LOCAL_ORIGIN).pathname || "/";
  } catch {
    const [path = ""] = rawValue.split("?");
    return path || "/";
  }
}

/**
 * @param {HookOptions} options
 * @returns {number}
 */
function nowMs(options) {
  if (typeof options.nowMs === "function") {
    return Number(Reflect.apply(options.nowMs, options, []));
  }
  return performance.now();
}

/**
 * @param {HookOptions} options
 * @param {number} startedAt
 * @returns {number}
 */
function durationSince(options, startedAt) {
  return Math.max(NO_DURATION, Math.round(nowMs(options) - startedAt));
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorType(error) {
  return error instanceof Error && error.name ? error.name : "Error";
}

/**
 * @param {string} value
 * @returns {string}
 */
function slugify(value) {
  return value
    .toLowerCase()
    .replaceAll(NON_SLUG_CHARACTERS, "_")
    .replaceAll(EDGE_UNDERSCORES, "") || "event";
}

/**
 * @param {unknown} error
 * @returns {readonly Readonly<Record<string, unknown>>[]}
 */
function exceptionSpanEvent(error) {
  return error === undefined
    ? []
    : [{
      name: "exception",

      metadata: { exceptionEscaped: true, exceptionType: errorType(error) }
    }];
}

/**
 * @param {unknown} events
 * @param {unknown} error
 * @returns {unknown}
 */
function spanEvents(events, error) {
  const exceptionEvents = exceptionSpanEvent(error);
  if (events === undefined) {
    return exceptionEvents.length > NO_EVENTS ? exceptionEvents : undefined;
  }
  if (!Array.isArray(events) || events.length > MAX_SPAN_EVENTS) {
    return events;
  }
  /** @type {readonly unknown[]} */
  const list = events;
  if (exceptionEvents.length === NO_EVENTS) {
    return list.length > NO_EVENTS ? list : undefined;
  }
  return [...list.slice(FIRST_ITEM, MAX_SPAN_EVENTS - exceptionEvents.length), ...exceptionEvents];
}

/**
 * @param {HookOptions} options
 * @param {unknown} error
 * @param {unknown} context
 * @returns {Promise<void>}
 */
async function notifyFailure(options, error, context) {
  const handler = options.onCaptureError;
  if (typeof handler === "function") {
    await Reflect.apply(handler, options, [error, context]);
  }
}

/**
 * @param {SpanOptions} options
 * @param {unknown} error
 * @param {unknown} context
 * @returns {Promise<boolean>}
 */
async function notifyQuietly(options, error, context) {
  try {
    await notifyFailure(options, error, context);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {SpanOptions} options
 * @returns {unknown}
 */
function spanTimestamp(options) {
  return typeof options.now === "function" ? Reflect.apply(options.now, options, []) : new Date().toISOString();
}

/**
 * @param {ClientSpanOptions} options
 * @param {SpanRecord} span
 * @param {unknown} failureContext
 * @returns {Promise<void>}
 */
async function emitSpan(options, span, failureContext) {
  const { trace } = span;
  try {
    options.client.span(span.id, spanTimestamp(options), {
      name: span.name,

      traceId: trace.traceId,

      spanId: trace.spanId,
      ...(trace.parentSpanId === undefined ? {} : { parentSpanId: trace.parentSpanId }),

      status: span.status,

      durationMs: span.durationMs,
      ...(span.events === undefined ? {} : { events: span.events }),
      ...(options.links === undefined ? {} : { links: options.links }),
      metadata: span.metadata
    });
  } catch (captureError) {
    await notifyQuietly(options, captureError, failureContext);
  }
}

/**
 * @param {readonly [string, unknown]} entry
 * @returns {entry is readonly [string, PrimitiveMetadataValue]}
 */
function isPrimitiveEntry(entry) {
  const [, value] = entry;
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * @param {unknown} metadata
 * @returns {PrimitiveMetadata}
 */
function primitiveMetadata(metadata) {
  if (!isRecord(metadata) || Array.isArray(metadata)) {
    return {};
  }
  /** @type {readonly (readonly [string, unknown])[]} */
  const entries = Object.entries(metadata);
  return Object.fromEntries(entries.filter((entry) => isPrimitiveEntry(entry)));
}

/**
 * @param {(normalizedKey: string) => boolean} isBlocked
 * @returns {(entry: readonly [string, PrimitiveMetadataValue]) => boolean}
 */
function allowedEntry(isBlocked) {
  return ([key]) => !isBlocked(key.toLowerCase().replaceAll(NON_KEY_CHARACTERS, ""));
}

/**
 * @param {unknown} metadata
 * @param {(normalizedKey: string) => boolean} isBlocked
 * @returns {PrimitiveMetadata}
 */
function filteredMetadata(metadata, isBlocked) {
  return Object.fromEntries(Object.entries(primitiveMetadata(metadata)).filter(allowedEntry(isBlocked)));
}

/**
 * @param {unknown} metadata
 * @returns {PrimitiveMetadata}
 */
function fetchInstrumentationMetadata(metadata) {
  return filteredMetadata(metadata, (key) => BLOCKED_FETCH_METADATA_KEYS.has(key));
}

module.exports = {
  durationSince,
  emitSpan,
  errorMessage,
  errorType,
  fetchInstrumentationMetadata,
  filteredMetadata,
  hasClient,
  isRecord,
  notifyFailure,
  nowMs,
  pathOnly,
  primitiveMetadata,
  slugify,
  spanEvents
};
