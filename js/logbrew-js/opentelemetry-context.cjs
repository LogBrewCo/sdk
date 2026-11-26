const { NULL_VALUE } = require("./null-value.cjs");
const { SdkError } = require("./sdk-error.cjs");
const {
  ZERO_SPAN_ID,
  isObjectValue,
  optionalProperty,
  requireSpanId,
  requireTraceId
} = require("./validation.cjs");

/**
 * @import { LogCorrelationTraceContext } from "./index.cjs"
 * @typedef {{ traceId: string, spanId: string, sampled: boolean }} SpanContextIds
 * @typedef {Readonly<{ spanId?: unknown, spanIdFactory?: unknown }>} ChildSpanOptions
 */

const SPAN_ID_BYTES = 8;
const MAX_SPAN_ID_ATTEMPTS = 3;
const FIRST_ATTEMPT = 0;
const ATTEMPT_STEP = 1;
const BYTE_VALUES = 256;
const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;
const SAMPLED_BIT_BASE = 2;
const SAMPLED_BIT = 1;
const OPENTELEMETRY_API_REGISTRY = Symbol.for("opentelemetry.js.api.1");
const OPENTELEMETRY_SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");

/**
 * @param {unknown} traceId
 * @returns {string | undefined}
 */
function normalizeTraceId(traceId) {
  try {
    return requireTraceId(traceId).toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} spanId
 * @returns {string | undefined}
 */
function normalizeSpanId(spanId) {
  try {
    return requireSpanId("trace spanId", spanId).toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} traceFlags
 * @returns {boolean}
 */
function openTelemetryTraceFlagsSampled(traceFlags) {
  const sampled = optionalProperty(traceFlags, "sampled");
  if (typeof sampled === "boolean") {
    return sampled;
  }
  if (typeof traceFlags === "number" && Number.isFinite(traceFlags)) {
    return Math.abs(Math.trunc(traceFlags) % SAMPLED_BIT_BASE) === SAMPLED_BIT;
  }
  return false;
}

/**
 * @param {unknown} spanContext
 * @returns {SpanContextIds | undefined}
 */
function normalizeOpenTelemetrySpanContextIds(spanContext) {
  if (!isObjectValue(spanContext) || spanContext["isValid"] === false) {
    return undefined;
  }
  const traceId = normalizeTraceId(spanContext["traceId"]);
  const spanId = normalizeSpanId(spanContext["spanId"]);
  if (traceId === undefined || spanId === undefined) {
    return undefined;
  }
  return {
    traceId,

    spanId,

    sampled: openTelemetryTraceFlagsSampled(spanContext["traceFlags"])
  };
}

/**
 * @param {number} byteLength
 * @returns {string}
 */
function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  const crypto = optionalProperty(globalThis, "crypto");
  const getRandomValues = optionalProperty(crypto, "getRandomValues");
  if (typeof getRandomValues === "function") {
    Reflect.apply(getRandomValues, crypto, [bytes]);
  } else {
    for (const index of bytes.keys()) {
      bytes[index] = Math.floor(Math.random() * BYTE_VALUES);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0")).join("");
}

/**
 * @returns {string}
 */
function defaultSpanIdFactory() {
  for (let attempt = FIRST_ATTEMPT; attempt < MAX_SPAN_ID_ATTEMPTS; attempt += ATTEMPT_STEP) {
    const spanId = randomHex(SPAN_ID_BYTES);
    if (spanId !== ZERO_SPAN_ID) {
      return spanId;
    }
  }
  throw new SdkError("configuration_error", "spanIdFactory must return a non-zero 16-character hex span id");
}

/**
 * @param {ChildSpanOptions} [options]
 * @returns {string}
 */
function resolveLogBrewChildSpanId(options = {}) {
  const explicitSpanId = options.spanId;
  if (explicitSpanId !== undefined) {
    return requireSpanId("spanId", explicitSpanId).toLowerCase();
  }
  const { spanIdFactory } = options;
  /** @type {unknown} */
  const spanId = typeof spanIdFactory === "function"
    ? Reflect.apply(spanIdFactory, undefined, [])
    : defaultSpanIdFactory();
  return requireSpanId("spanId", spanId).toLowerCase();
}

/**
 * @param {unknown} method
 * @param {unknown} thisArg
 * @param {readonly unknown[]} [args]
 * @returns {{ value: unknown } | undefined}
 */
function callMethod(method, thisArg, args = []) {
  if (typeof method !== "function") {
    return undefined;
  }
  try {
    return { value: Reflect.apply(method, thisArg, args) };
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} spanContext
 * @param {ChildSpanOptions} [options]
 * @returns {LogCorrelationTraceContext | null}
 */
function logbrewTraceContextFromOpenTelemetrySpanContext(spanContext, options = {}) {
  const context = normalizeOpenTelemetrySpanContextIds(spanContext);
  if (context === undefined) {
    return NULL_VALUE;
  }
  return {
    traceId: context.traceId,

    spanId: resolveLogBrewChildSpanId(options),

    parentSpanId: context.spanId,
    sampled: context.sampled
  };
}

/**
 * @param {unknown} span
 * @param {ChildSpanOptions} [options]
 * @returns {LogCorrelationTraceContext | null}
 */
function logbrewTraceContextFromOpenTelemetrySpan(span, options = {}) {
  if (!isObjectValue(span)) {
    return NULL_VALUE;
  }
  const getSpanContext = typeof span["spanContext"] === "function"
    ? span["spanContext"]
    : span["getSpanContext"];
  const spanContext = callMethod(getSpanContext, span);
  if (spanContext === undefined) {
    return NULL_VALUE;
  }
  return logbrewTraceContextFromOpenTelemetrySpanContext(spanContext.value, options);
}

/**
 * @returns {unknown}
 */
function registeredActiveOpenTelemetrySpan() {
  /** @type {unknown} */
  const registry = Reflect.get(globalThis, OPENTELEMETRY_API_REGISTRY);
  const contextManager = optionalProperty(registry, "context");
  const activeContext = callMethod(optionalProperty(contextManager, "active"), contextManager);
  if (activeContext === undefined) {
    return undefined;
  }
  const getValue = optionalProperty(activeContext.value, "getValue");
  return callMethod(getValue, activeContext.value, [OPENTELEMETRY_SPAN_KEY])?.value;
}

/**
 * @param {ChildSpanOptions} [options]
 * @returns {LogCorrelationTraceContext | null}
 */
function logbrewTraceContextFromCurrentOpenTelemetrySpan(options = {}) {
  const openTelemetryApi = optionalProperty(options, "openTelemetryApi");
  if (openTelemetryApi === undefined || openTelemetryApi === null) {
    return logbrewTraceContextFromOpenTelemetrySpan(registeredActiveOpenTelemetrySpan(), options);
  }
  const trace = optionalProperty(openTelemetryApi, "trace");
  const activeSpan = callMethod(optionalProperty(trace, "getActiveSpan"), trace)?.value;
  return logbrewTraceContextFromOpenTelemetrySpan(activeSpan, options);
}

module.exports = {
  defaultSpanIdFactory,
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,
  normalizeOpenTelemetrySpanContextIds,
  normalizeSpanId
};
