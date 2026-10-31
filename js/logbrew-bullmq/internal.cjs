"use strict";

const { SdkError, parseTraceparent } = require("@logbrew/sdk");

/**
 * @typedef {(...args: readonly unknown[]) => unknown} Callable
 */

const DEFAULT_QUEUE_NAME = "bullmq";

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<PropertyKey, unknown>}
 */
function hasFields(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is Callable}
 */
function isCallable(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {PropertyKey} name
 * @returns {unknown}
 */
function readField(value, name) {
  return hasFields(value) ? value[name] : undefined;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function cloneObject(value) {
  return isObject(value) ? { ...value } : {};
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeName(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * @param {unknown} queue
 * @param {unknown} fallback
 * @returns {string}
 */
function resolveQueueName(queue, fallback) {
  if (typeof fallback === "string" && fallback.trim() !== "") {
    return fallback.trim();
  }
  return normalizeName(readField(queue, "name"), DEFAULT_QUEUE_NAME);
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeTraceparent(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  try {
    const context = parseTraceparent(value);
    return `${context.version}-${context.traceId}-${context.parentSpanId}-${context.traceFlags}`;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {string} message
 * @returns {{ readonly method: Callable, readonly owner: Record<PropertyKey, unknown> }}
 */
function requireMethod(value, name, message) {
  if (!hasFields(value)) {
    throw new SdkError("configuration_error", message);
  }
  const method = value[name];
  if (!isCallable(method)) {
    throw new SdkError("configuration_error", message);
  }
  return { method, owner: value };
}

/**
 * @returns {SdkError}
 */
function missingClientError() {
  return new SdkError("configuration_error", "queueOperationWithLogBrewSpan requires client");
}

/**
 * @param {unknown} value
 * @param {symbol} marker
 * @returns {boolean}
 */
function isMarked(value, marker) {
  return readField(value, marker) === true;
}

/**
 * @param {Callable} wrapper
 * @param {symbol} marker
 * @returns {void}
 */
function mark(wrapper, marker) {
  Object.defineProperty(wrapper, marker, { value: true });
}

module.exports = {
  cloneObject,
  hasFields,
  isCallable,
  isList,
  isMarked,
  isObject,
  mark,
  missingClientError,
  normalizeName,
  normalizeTraceparent,
  readField,
  requireMethod,
  resolveQueueName
};
