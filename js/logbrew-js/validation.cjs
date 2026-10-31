const { SdkError } = require("./sdk-error.cjs");

const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";
const TRACE_ID_PATTERN = /^[0-9a-fA-F]{32}$/u;
const SPAN_ID_PATTERN = /^[0-9a-fA-F]{16}$/u;
const TRACE_FLAGS_PATTERN = /^[0-9a-fA-F]{2}$/u;
const NEGATIVE_OFFSET_PATTERN = /.+-.+/u;
const RFC3339_TIMESTAMP_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
const EPOCH_MS = 0;
const YEAR_ZERO = 0;
const FIRST_MONTH = 1;
const MIN_POSITIVE_INTEGER = 1;
const MIN_NON_NEGATIVE_INTEGER = 0;

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {string}
 */
function requireNonEmpty(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SdkError("validation_error", `${label} must be non-empty`);
  }
  return value;
}

/**
 * @param {string} label
 * @param {unknown} value
 * @param {Readonly<ReadonlySet<string>>} allowedValues
 * @returns {string}
 */
function requireAllowedValue(label, value, allowedValues) {
  const text = requireNonEmpty(label, value);
  if (!allowedValues.has(text)) {
    throw new SdkError("validation_error", `${label} must be one of: ${[...allowedValues].join(", ")}`);
  }
  return text;
}

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {number}
 */
function requireFiniteNumber(label, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SdkError("validation_error", `${label} must be a finite number`);
  }
  return value;
}

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {number}
 */
function requirePositiveInteger(label, value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_POSITIVE_INTEGER) {
    throw new SdkError("validation_error", `${label} must be a positive integer`);
  }
  return value;
}

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {number}
 */
function requireNonNegativeInteger(label, value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_NON_NEGATIVE_INTEGER) {
    throw new SdkError("validation_error", `${label} must be a non-negative integer`);
  }
  return value;
}

/**
 * @param {unknown} traceId
 * @returns {string}
 */
function requireTraceId(traceId) {
  if (typeof traceId !== "string" || !TRACE_ID_PATTERN.test(traceId)) {
    throw new SdkError("validation_error", "traceId must be 32 lowercase or uppercase hex characters");
  }
  if (traceId.toLowerCase() === ZERO_TRACE_ID) {
    throw new SdkError("validation_error", "traceId must not be all zeros");
  }
  return traceId;
}

/**
 * @param {string} label
 * @param {unknown} spanId
 * @returns {string}
 */
function requireSpanId(label, spanId) {
  if (typeof spanId !== "string" || !SPAN_ID_PATTERN.test(spanId)) {
    throw new SdkError("validation_error", `${label} must be 16 lowercase or uppercase hex characters`);
  }
  if (spanId.toLowerCase() === ZERO_SPAN_ID) {
    throw new SdkError("validation_error", `${label} must not be all zeros`);
  }
  return spanId;
}

/**
 * @param {unknown} traceFlags
 * @returns {string}
 */
function requireTraceFlags(traceFlags) {
  if (typeof traceFlags !== "string" || !TRACE_FLAGS_PATTERN.test(traceFlags)) {
    throw new SdkError("validation_error", "traceFlags must be 2 lowercase or uppercase hex characters");
  }
  return traceFlags;
}

/**
 * @param {string} timestamp
 * @returns {boolean}
 */
function hasTimezone(timestamp) {
  if (timestamp.endsWith("Z")) {
    return true;
  }
  const [, timePortion] = timestamp.split("T");
  return timePortion !== undefined && (timePortion.includes("+") || NEGATIVE_OFFSET_PATTERN.test(timePortion));
}

/**
 * @param {string} timestamp
 * @returns {boolean}
 */
function isCalendarDate(timestamp) {
  const parts = RFC3339_TIMESTAMP_PATTERN.exec(timestamp)?.groups;
  if (parts === undefined) {
    return false;
  }
  const year = Number(parts["year"]);
  const monthIndex = Number(parts["month"]) - FIRST_MONTH;
  const day = Number(parts["day"]);
  const calendar = new Date(EPOCH_MS);
  calendar.setUTCFullYear(year, monthIndex, day);
  return year !== YEAR_ZERO
    && calendar.getUTCFullYear() === year
    && calendar.getUTCMonth() === monthIndex
    && calendar.getUTCDate() === day;
}

/**
 * @param {unknown} timestamp
 * @returns {string}
 */
function requireTimestamp(timestamp) {
  const text = requireNonEmpty("timestamp", timestamp);
  if (!hasTimezone(text)) {
    throw new SdkError("validation_error", `timestamp must include a timezone offset: ${text}`);
  }
  if (!isCalendarDate(text)) {
    throw new SdkError("validation_error", `invalid timestamp: ${text}`);
  }
  return text;
}

module.exports = {
  ZERO_SPAN_ID,
  ZERO_TRACE_ID,
  isRecord,
  requireAllowedValue,
  requireFiniteNumber,
  requireNonEmpty,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireSpanId,
  requireTimestamp,
  requireTraceFlags,
  requireTraceId
};
