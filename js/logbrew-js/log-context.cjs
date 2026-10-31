const { SdkError } = require("./sdk-error.cjs");
const { ZERO_SPAN_ID, ZERO_TRACE_ID, isRecord } = require("./validation.cjs");

/**
 * @import { LogCorrelationTraceContext, Metadata, MetadataValue } from "./index.cjs"
 */

const TRACE_ID_PATTERN = /^[0-9a-fA-F]{32}$/u;
const SPAN_ID_PATTERN = /^[0-9a-fA-F]{16}$/u;

/**
 * @param {unknown} value
 * @returns {value is MetadataValue}
 */
function isMetadataValue(value) {
  return (
    value === null
    || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))
    || typeof value === "boolean"
  );
}

/**
 * @param {unknown} metadata
 * @returns {Metadata}
 */
function compactMetadata(metadata) {
  if (metadata === undefined) {
    return {};
  }
  if (!isRecord(metadata)) {
    throw new SdkError("validation_error", "metadata must be an object");
  }
  /** @type {Metadata} */
  const safeMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isMetadataValue(value)) {
      safeMetadata[key] = value;
    }
  }
  return safeMetadata;
}

/**
 * @template Trace
 * @param {(() => Trace) | null | undefined} provider
 * @param {(error: unknown) => void} onError
 * @returns {Trace | undefined}
 */
function traceFromProvider(provider, onError) {
  if (!provider) {
    return undefined;
  }
  try {
    return provider();
  } catch (error) {
    onError(error);
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @param {Readonly<RegExp>} pattern
 * @param {string} zeroValue
 * @returns {string | undefined}
 */
function normalizeHexId(value, pattern, zeroValue) {
  if (typeof value !== "string" || !pattern.test(value) || value.toLowerCase() === zeroValue) {
    return undefined;
  }
  return value.toLowerCase();
}

/**
 * @param {unknown} trace
 * @returns {LogCorrelationTraceContext | undefined}
 */
function normalizeLogTraceContext(trace) {
  if (!isRecord(trace)) {
    return undefined;
  }
  const traceId = normalizeHexId(trace["traceId"], TRACE_ID_PATTERN, ZERO_TRACE_ID);
  const spanId = normalizeHexId(trace["spanId"], SPAN_ID_PATTERN, ZERO_SPAN_ID);
  if (traceId === undefined || spanId === undefined) {
    return undefined;
  }
  const parentSpanId = normalizeHexId(trace["parentSpanId"], SPAN_ID_PATTERN, ZERO_SPAN_ID);
  const { sampled } = trace;
  return {
    spanId,
    traceId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    ...(typeof sampled === "boolean" ? { sampled } : {})
  };
}

/**
 * @param {unknown} trace
 * @returns {Metadata}
 */
function traceMetadataFromLogContext(trace) {
  const normalized = normalizeLogTraceContext(trace);
  return normalized === undefined ? {} : { ...normalized };
}

module.exports = {
  compactMetadata,
  isMetadataValue,
  normalizeLogTraceContext,
  traceFromProvider,
  traceMetadataFromLogContext
};
