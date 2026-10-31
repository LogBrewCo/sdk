const { compactMetadata, isMetadataValue, traceMetadataFromLogContext } = require("./log-context.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { isObjectValue, isRecord, isTruthy, stringOrUndefined } = require("./validation.cjs");

/**
 * @import { Severity } from "./index.cjs"
 * @typedef {Readonly<{ includeErrorStack?: unknown, logger?: unknown, metadata?: unknown, trace?: unknown }>} PinoRecordOptions
 * @typedef {{ message: string, level: Severity, logger?: unknown, metadata: Record<string, unknown> }} PinoLogAttributes
 */

const CRITICAL_LEVEL = 60;
const ERROR_LEVEL = 50;
const WARNING_LEVEL = 40;
const TRACE_LEVEL = 10;
const DEBUG_LEVEL = 20;
const INFO_LEVEL = 30;
/** @type {ReadonlyMap<number, string>} */
const PINO_LEVEL_LABELS = new Map([
  [TRACE_LEVEL, "trace"],
  [DEBUG_LEVEL, "debug"],
  [INFO_LEVEL, "info"],
  [WARNING_LEVEL, "warn"],
  [ERROR_LEVEL, "error"],
  [CRITICAL_LEVEL, "fatal"]
]);
/** @type {ReadonlyMap<string, Severity>} */
const PINO_LEVEL_NAMES = new Map([
  ["trace", "info"],
  ["debug", "info"],
  ["warn", "warning"],
  ["warning", "warning"],
  ["error", "error"],
  ["fatal", "critical"],
  ["critical", "critical"]
]);
const PINO_HOST_FIELD = ["host", "name"].join("");
const PINO_RESERVED_FIELDS = new Set(["level", "time", "timestamp", "msg", "message", "err", "error", "pid", PINO_HOST_FIELD, "v"]);
const PINO_SENSITIVE_CONTEXT_FIELDS = new Set([
  "apikey",
  "authorization",
  "baggage",
  "body",
  "cookie",
  "credentials",
  "cwd",
  "directory",
  "dirname",
  "errorstack",
  "file",
  "filename",
  "filepath",
  "headers",
  "href",
  "key",
  "password",
  "payload",
  "proxyauthorization",
  "query",
  "querystring",
  "requestbody",
  "requestheaders",
  "requesturl",
  "responsebody",
  "responseheaders",
  "responseurl",
  "search",
  "secret",
  "setcookie",
  "stack",
  "token",
  "traceparent",
  "tracestate",
  "uri",
  "url"
]);
const PINO_SENSITIVE_FIELD_SUFFIXES = [
  "accesskey",
  "apikey",
  "authorization",
  "body",
  "cookie",
  "credentials",
  "headers",
  "password",
  "payload",
  "privatekey",
  "query",
  "secret",
  "stack",
  "token",
  "url"
];
const FIELD_SEPARATOR_PATTERN = /[^a-z0-9]+/gu;

/**
 * @param {unknown} level
 * @returns {Severity}
 */
function logbrewLevelFromPinoLevel(level) {
  if (typeof level === "number" && Number.isFinite(level)) {
    if (level >= CRITICAL_LEVEL) {
      return "critical";
    }
    if (level >= ERROR_LEVEL) {
      return "error";
    }
    return level >= WARNING_LEVEL ? "warning" : "info";
  }
  return PINO_LEVEL_NAMES.get(String(level).toLowerCase()) ?? "info";
}

/**
 * @param {unknown} level
 * @returns {string}
 */
function pinoLevelLabel(level) {
  if (typeof level === "string" && level.trim() !== "") {
    return level;
  }
  if (typeof level !== "number" || !Number.isFinite(level)) {
    return "info";
  }
  return PINO_LEVEL_LABELS.get(level) ?? String(level);
}

/**
 * @param {Readonly<Record<string, unknown>>} record
 * @returns {string}
 */
function pinoMessage(record) {
  const { msg, message } = record;
  const error = record["err"] ?? record["error"];
  const errorMessage = isObjectValue(error) ? error["message"] : undefined;
  return stringOrUndefined(msg) ?? stringOrUndefined(message) ?? stringOrUndefined(errorMessage) ?? "pino event";
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function isSensitivePinoContextField(key) {
  const normalized = key.toLowerCase().replaceAll(FIELD_SEPARATOR_PATTERN, "");
  return PINO_SENSITIVE_CONTEXT_FIELDS.has(normalized)
    || PINO_SENSITIVE_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * @param {Readonly<Record<string, unknown>>} record
 * @returns {Record<string, unknown>}
 */
function pinoContextMetadata(record) {
  /** @type {Record<string, unknown>} */
  const metadata = {};
  for (const [key, value] of Object.entries(record)) {
    if (!PINO_RESERVED_FIELDS.has(key) && !isSensitivePinoContextField(key) && isMetadataValue(value)) {
      metadata[`context.${key}`] = value;
    }
  }
  return metadata;
}

/**
 * @param {unknown} error
 * @param {boolean} includeErrorStack
 * @returns {Record<string, unknown>}
 */
function pinoErrorMetadata(error, includeErrorStack) {
  if (error instanceof Error) {
    return {
      errorName: isTruthy(error.name) ? error.name : "Error",
      ...(isTruthy(error.message) ? { errorMessage: error.message } : {}),
      ...(includeErrorStack && isTruthy(error.stack) ? { errorStack: error.stack } : {})
    };
  }
  if (isObjectValue(error)) {
    const name = stringOrUndefined(error["type"] ?? error["name"]);
    const message = stringOrUndefined(error["message"]);
    const stack = stringOrUndefined(error["stack"]);
    return {
      ...(name === undefined ? {} : { errorName: name }),
      ...(message === undefined ? {} : { errorMessage: message }),
      ...(includeErrorStack && stack !== undefined ? { errorStack: stack } : {})
    };
  }
  return typeof error === "string" && error.trim() !== "" ? { errorMessage: error } : {};
}

/**
 * @param {unknown} record
 * @param {PinoRecordOptions} [options]
 * @returns {PinoLogAttributes}
 */
function logAttributesFromPinoRecord(record, options = {}) {
  if (!isRecord(record)) {
    throw new SdkError("validation_error", "Pino record must be an object");
  }
  const level = logbrewLevelFromPinoLevel(record["level"]);
  const metadata = {
    ...compactMetadata(options.metadata),
    pinoLevel: pinoLevelLabel(record["level"]),
    ...pinoContextMetadata(record),
    ...traceMetadataFromLogContext(options.trace)
  };
  const pinoLevelNumber = record["level"];
  const errorMetadata = pinoErrorMetadata(record["err"] ?? record["error"], options.includeErrorStack === true);
  return {
    message: pinoMessage(record),

    level,
    ...(isTruthy(options.logger) ? { logger: options.logger } : {}),

    metadata: {
      ...metadata,
      ...(typeof pinoLevelNumber === "number" && Number.isFinite(pinoLevelNumber) ? { pinoLevelNumber } : {}),
      ...errorMetadata
    }
  };
}

/**
 * @param {unknown} record
 * @param {() => unknown} fallbackTimestamp
 * @returns {unknown}
 */
function timestampFromPinoRecord(record, fallbackTimestamp) {
  const value = isObjectValue(record) ? record["time"] ?? record["timestamp"] : undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
  }
  return fallbackTimestamp();
}

module.exports = { logAttributesFromPinoRecord, timestampFromPinoRecord };
