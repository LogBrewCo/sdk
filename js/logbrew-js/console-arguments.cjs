const { compactMetadata } = require("./log-context.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { isTruthy } = require("./validation.cjs");

/**
 * @import { ConsoleMethodName, Severity } from "./index.cjs"
 * @typedef {Readonly<{ includeErrorStack?: unknown, logger?: unknown, metadata?: unknown }>} ConsoleArgumentsOptions
 * @typedef {{ message: string, level: Severity, logger?: unknown, metadata: Record<string, unknown> }} ConsoleLogAttributes
 */

const NO_ARGUMENTS = 0;
/** @type {ReadonlySet<ConsoleMethodName>} */
const CONSOLE_METHODS = new Set(["debug", "info", "log", "warn", "error"]);

/**
 * @param {unknown} method
 * @returns {Severity}
 */
function logbrewLevelFromConsoleMethod(method) {
  switch (method) {
    case "debug": {
      return "info";
    }
    case "warn": {
      return "warning";
    }
    case "error": {
      return "error";
    }
    case "info":
    case "log": {
      return "info";
    }
    default: {
      throw new SdkError("validation_error", `console method must be one of: ${[...CONSOLE_METHODS].join(", ")}`);
    }
  }
}

/** @type {(value: unknown) => string} */
const stringFromValue = String;

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function jsonText(value) {
  return JSON.stringify(value);
}

/**
 * @param {Readonly<Error>} error
 * @param {boolean} includeErrorStack
 * @returns {unknown}
 */
function formatConsoleError(error, includeErrorStack) {
  if (includeErrorStack && isTruthy(error.stack)) {
    return error.stack;
  }
  return isTruthy(error.message) ? `${error.name}: ${error.message}` : error.name;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatConsoleObject(value) {
  try {
    return jsonText(value) ?? stringFromValue(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * @param {unknown} value
 * @param {boolean} includeErrorStack
 * @returns {unknown}
 */
function formatConsoleArgument(value, includeErrorStack) {
  if (value instanceof Error) {
    return formatConsoleError(value, includeErrorStack);
  }
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined || typeof value !== "object" && typeof value !== "function") {
    return String(value);
  }
  return formatConsoleObject(value);
}

/**
 * @param {unknown} args
 * @param {boolean} includeErrorStack
 * @returns {string}
 */
function consoleMessage(args, includeErrorStack) {
  /** @type {readonly unknown[]} */
  const values = Array.isArray(args) ? args : [];
  const message = values.map((value) => formatConsoleArgument(value, includeErrorStack)).join(" ");
  return message.trim() === "" ? "console event" : message;
}

/**
 * @param {Readonly<Record<string, unknown>>} metadata
 * @param {readonly unknown[]} args
 * @param {boolean} includeErrorStack
 * @returns {Record<string, unknown>}
 */
function withConsoleErrorMetadata(metadata, args, includeErrorStack) {
  const error = args.find((value) => value instanceof Error);
  if (!(error instanceof Error)) {
    return metadata;
  }
  return {
    ...metadata,
    errorName: isTruthy(error.name) ? error.name : "Error",
    ...(isTruthy(error.message) ? { errorMessage: error.message } : {}),
    ...(includeErrorStack && isTruthy(error.stack) ? { errorStack: error.stack } : {})
  };
}

/**
 * @param {unknown} method
 * @param {unknown} args
 * @param {ConsoleArgumentsOptions} [options]
 * @returns {ConsoleLogAttributes}
 */
function logAttributesFromConsoleArgs(method, args, options = {}) {
  const level = logbrewLevelFromConsoleMethod(method);
  const includeErrorStack = options.includeErrorStack === true;
  const message = consoleMessage(args, includeErrorStack);
  /** @type {readonly unknown[]} */
  const values = Array.isArray(args) ? args : [];
  const metadata = withConsoleErrorMetadata({
    ...compactMetadata(options.metadata),
    consoleMethod: method,

    argumentCount: Array.isArray(args) ? values.length : NO_ARGUMENTS
  }, values, includeErrorStack);
  return {
    message,

    level,
    ...(isTruthy(options.logger) ? { logger: options.logger } : {}),
    metadata
  };
}

module.exports = { CONSOLE_METHODS, logAttributesFromConsoleArgs, logbrewLevelFromConsoleMethod };
