const { isList } = require("./validation.cjs");

/**
 * @typedef {Readonly<Record<string, unknown>>} ReadableSpan
 */

const HR_TIME_PARTS = 2;
const MS_PER_SECOND = 1000;
const NANOS_PER_MS = 1_000_000;
const MIN_HR_TIME_PART = 0;

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function openTelemetryTimeMs(value) {
  if (isList(value) && value.length >= HR_TIME_PARTS) {
    const [seconds, nanos] = value;
    if (isFiniteNumber(seconds) && isFiniteNumber(nanos)) {
      return seconds * MS_PER_SECOND + nanos / NANOS_PER_MS;
    }
  }
  if (isFiniteNumber(value)) {
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.valueOf();
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function openTelemetryDurationMs(value) {
  if (!isList(value) || value.length < HR_TIME_PARTS) {
    return undefined;
  }
  const [seconds, nanos] = value;
  if (
    !isFiniteNumber(seconds)
    || !isFiniteNumber(nanos)
    || seconds < MIN_HR_TIME_PART
    || nanos < MIN_HR_TIME_PART
  ) {
    return undefined;
  }
  return seconds * MS_PER_SECOND + nanos / NANOS_PER_MS;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function timestampFromOpenTelemetryTime(value) {
  const milliseconds = openTelemetryTimeMs(value);
  if (milliseconds === undefined) {
    return undefined;
  }
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

/**
 * @param {(() => unknown) | undefined} fallbackTimestamp
 * @returns {unknown}
 */
function fallbackTimestampValue(fallbackTimestamp) {
  return fallbackTimestamp === undefined ? new Date().toISOString() : fallbackTimestamp();
}

/**
 * @param {ReadableSpan} span
 * @returns {number | undefined}
 */
function durationMsFromOpenTelemetryReadableSpan(span) {
  const durationMs = openTelemetryDurationMs(span["duration"]);
  if (durationMs !== undefined) {
    return durationMs;
  }
  const startMs = openTelemetryTimeMs(span["startTime"]);
  const endMs = openTelemetryTimeMs(span["endTime"]);
  if (startMs !== undefined && endMs !== undefined && endMs >= startMs) {
    return endMs - startMs;
  }
  return undefined;
}

/**
 * @param {ReadableSpan} span
 * @param {number | undefined} startMs
 * @param {number | undefined} durationMs
 * @returns {number | undefined}
 */
function endMsFromOpenTelemetryReadableSpan(span, startMs, durationMs) {
  const endMs = openTelemetryTimeMs(span["endTime"]);
  if (endMs !== undefined) {
    return endMs;
  }
  if (startMs !== undefined && durationMs !== undefined) {
    return startMs + durationMs;
  }
  return undefined;
}

/**
 * @param {ReadableSpan} span
 * @param {(() => unknown) | undefined} fallbackTimestamp
 * @returns {unknown}
 */
function timestampFromOpenTelemetryReadableSpan(span, fallbackTimestamp) {
  return timestampFromOpenTelemetryTime(span["startTime"]) ?? fallbackTimestampValue(fallbackTimestamp);
}

module.exports = {
  durationMsFromOpenTelemetryReadableSpan,
  endMsFromOpenTelemetryReadableSpan,
  fallbackTimestampValue,
  openTelemetryTimeMs,
  timestampFromOpenTelemetryReadableSpan,
  timestampFromOpenTelemetryTime
};
