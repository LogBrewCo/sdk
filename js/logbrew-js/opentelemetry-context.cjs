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
const OPENTELEMETRY_API_PACKAGE = "@opentelemetry/api";

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
 * @returns {{ value: unknown } | undefined}
 */
function callWithoutArguments(method, thisArg) {
  if (typeof method !== "function") {
    return undefined;
  }
  try {
    return { value: Reflect.apply(method, thisArg, []) };
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
  const spanContext = callWithoutArguments(getSpanContext, span);
  if (spanContext === undefined) {
    return NULL_VALUE;
  }
  return logbrewTraceContextFromOpenTelemetrySpanContext(spanContext.value, options);
}

/**
 * @returns {((id: string) => unknown) | undefined}
 */
function optionalRequire() {
  /** @type {unknown} */
  const moduleRequire = typeof module === "undefined" ? undefined : Reflect.get(module, "require");
  if (typeof moduleRequire === "function") {
    return (id) => {
      /** @type {unknown} */
      const required = Reflect.apply(moduleRequire, module, [id]);
      return required;
    };
  }
  return typeof require === "function" ? require : undefined;
}

/**
 * @returns {unknown}
 */
function optionalOpenTelemetryApi() {
  const requireOptional = optionalRequire();
  if (requireOptional === undefined) {
    return undefined;
  }
  try {
    return requireOptional(OPENTELEMETRY_API_PACKAGE);
  } catch {
    return undefined;
  }
}

/**
 * @param {ChildSpanOptions} [options]
 * @returns {LogCorrelationTraceContext | null}
 */
function logbrewTraceContextFromCurrentOpenTelemetrySpan(options = {}) {
  const openTelemetryApi = optionalProperty(options, "openTelemetryApi") ?? optionalOpenTelemetryApi();
  const trace = optionalProperty(openTelemetryApi, "trace");
  const getActiveSpan = optionalProperty(trace, "getActiveSpan");
  const activeSpan = callWithoutArguments(getActiveSpan, trace);
  if (activeSpan === undefined) {
    return NULL_VALUE;
  }
  return logbrewTraceContextFromOpenTelemetrySpan(activeSpan.value, options);
}

module.exports = {
  defaultSpanIdFactory,
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,
  normalizeOpenTelemetrySpanContextIds,
  normalizeSpanId
};
