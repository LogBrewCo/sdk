const { compactMetadata, isMetadataValue, traceMetadataFromLogContext } = require("./log-context.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { isObjectValue, isRecord, isTruthy, optionalProperty } = require("./validation.cjs");

/**
 * @import { Metadata, Severity } from "./index.cjs"
 * @typedef {Readonly<{ includeErrorStack?: unknown, logger?: unknown, metadata?: unknown, trace?: unknown }>} WinstonInfoOptions
 * @typedef {{ message: string, level: Severity, logger?: unknown, metadata: Metadata }} WinstonLogAttributes
 * @typedef {Readonly<Record<string, unknown>>} WinstonInfo
 */

const WINSTON_RESERVED_FIELDS = new Set(["level", "message", "timestamp", "time", "err", "error", "stack"]);
const LINE_BREAK_PATTERN = /\r?\n/u;
const FIRST_LINE = 0;
const STACK_HEADLINE_PATTERN = /^(?<name>[A-Za-z][A-Za-z0-9_.]*(?:Error|Exception)?):\s*(?<message>.*)$/u;
/** @type {ReadonlyMap<string, Severity>} */
const LOGBREW_LEVELS = new Map([
  ["warn", "warning"],
  ["warning", "warning"],
  ["error", "error"],
  ["crit", "critical"],
  ["critical", "critical"],
  ["fatal", "critical"]
]);

/**
 * @param {unknown} level
 * @returns {Severity}
 */
function logbrewLevelFromWinstonLevel(level) {
  return LOGBREW_LEVELS.get(String(level).toLowerCase()) ?? "info";
}

/**
 * @param {unknown} level
 * @returns {string}
 */
function winstonLevelLabel(level) {
  return typeof level === "string" && level.trim() !== "" ? level : "info";
}

/**
 * @param {unknown} text
 * @returns {text is string}
 */
function isNonBlankString(text) {
  return typeof text === "string" && text.trim() !== "";
}

/**
 * @param {WinstonInfo} info
 * @returns {string}
 */
function winstonMessage(info) {
  if (isNonBlankString(info["message"])) {
    return info["message"];
  }
  const error = info["err"] ?? info["error"];
  if (isObjectValue(error) && isNonBlankString(error["message"])) {
    return error["message"];
  }
  return "winston event";
}

/**
 * @param {WinstonInfo} info
 * @returns {Metadata}
 */
function winstonContextMetadata(info) {
  /** @type {Metadata} */
  const metadata = {};
  for (const [key, value] of Object.entries(info)) {
    if (!WINSTON_RESERVED_FIELDS.has(key) && isMetadataValue(value)) {
      metadata[`context.${key}`] = value;
    }
  }
  return metadata;
}

/**
 * @param {Readonly<Error>} error
 * @param {boolean} includeErrorStack
 * @returns {Metadata}
 */
function errorInstanceMetadata(error, includeErrorStack) {
  return {
    errorName: error.name || "Error",
    ...(error.message ? { errorMessage: error.message } : {}),
    ...(includeErrorStack && isTruthy(error.stack) ? { errorStack: error.stack } : {})
  };
}

/**
 * @param {Readonly<Record<string, unknown>>} error
 * @param {boolean} includeErrorStack
 * @returns {Metadata}
 */
function errorObjectMetadata(error, includeErrorStack) {
  const name = error["type"] ?? error["name"];
  const { message, stack } = error;
  return {
    ...(isNonBlankString(name) ? { errorName: name } : {}),
    ...(isNonBlankString(message) ? { errorMessage: message } : {}),
    ...(includeErrorStack && isNonBlankString(stack) ? { errorStack: stack } : {})
  };
}

/**
 * @param {unknown} error
 * @param {boolean} includeErrorStack
 * @returns {Metadata}
 */
function nestedErrorMetadata(error, includeErrorStack) {
  if (!isTruthy(error)) {
    return {};
  }
  if (error instanceof Error) {
    return errorInstanceMetadata(error, includeErrorStack);
  }
  if (isObjectValue(error)) {
    return errorObjectMetadata(error, includeErrorStack);
  }
  return isNonBlankString(error) ? { errorMessage: error } : {};
}

/**
 * @param {Readonly<Metadata>} metadata
 * @param {string} stack
 * @param {boolean} includeErrorStack
 * @returns {Metadata}
 */
function stackMetadata(metadata, stack, includeErrorStack) {
  const firstLine = stack.split(LINE_BREAK_PATTERN)[FIRST_LINE] ?? "";
  const groups = STACK_HEADLINE_PATTERN.exec(firstLine)?.groups;
  const name = groups?.["name"];
  const message = groups?.["message"];
  return {
    ...(name !== undefined && metadata["errorName"] === undefined ? { errorName: name } : {}),
    ...(message !== undefined && message !== "" && metadata["errorMessage"] === undefined ? { errorMessage: message } : {}),
    ...(includeErrorStack ? { errorStack: stack } : {})
  };
}

/**
 * @param {Readonly<Metadata>} metadata
 * @param {WinstonInfo} info
 * @param {boolean} includeErrorStack
 * @returns {Metadata}
 */
function withWinstonErrorMetadata(metadata, info, includeErrorStack) {
  const withError = { ...metadata, ...nestedErrorMetadata(info["err"] ?? info["error"], includeErrorStack) };
  const { stack } = info;
  return isNonBlankString(stack) ? { ...withError, ...stackMetadata(withError, stack, includeErrorStack) } : withError;
}

/**
 * @param {unknown} info
 * @param {WinstonInfoOptions} [options]
 * @returns {WinstonLogAttributes}
 */
function logAttributesFromWinstonInfo(info, options = {}) {
  if (!isRecord(info)) {
    throw new SdkError("validation_error", "Winston info must be an object");
  }
  const level = logbrewLevelFromWinstonLevel(info["level"]);
  const metadata = withWinstonErrorMetadata(
    {
      ...compactMetadata(options.metadata),
      winstonLevel: winstonLevelLabel(info["level"]),
      ...winstonContextMetadata(info),
      ...traceMetadataFromLogContext(options.trace)
    },
    info,
    options.includeErrorStack === true
  );
  return {
    message: winstonMessage(info),

    level,
    ...(isTruthy(options.logger) ? { logger: options.logger } : {}),
    metadata
  };
}

/**
 * @param {unknown} info
 * @param {() => unknown} fallbackTimestamp
 * @returns {unknown}
 */
function timestampFromWinstonInfo(info, fallbackTimestamp) {
  const value = optionalProperty(info, "timestamp") ?? optionalProperty(info, "time");
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (isNonBlankString(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
  }
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }
  return fallbackTimestamp();
}

module.exports = { logAttributesFromWinstonInfo, timestampFromWinstonInfo, winstonMessage };
