const { compactMetadata } = require("./log-context.cjs");
const { NULL_VALUE } = require("./null-value.cjs");

/**
 * @import { Metadata } from "./index.cjs"
 * @typedef {(reason: unknown) => void} ErrorHandler
 * @typedef {Readonly<{
 *   log: (id: string, timestamp: unknown, attributes: unknown) => void,
 *   flush: (transport: unknown) => Promise<unknown>,
 *   pendingEvents: () => number
 * }>} CaptureClient
 * @typedef {{
 *   transport: unknown,
 *   flushOnEvent: boolean,
 *   includeErrorStack: boolean,
 *   logger: unknown,
 *   metadata: Metadata,
 *   timestamp: () => unknown,
 *   eventIdPrefix: unknown,
 *   onError: ErrorHandler
 * }} CaptureSettings
 */

/**
 * @param {unknown} flushing
 * @param {ErrorHandler} onError
 * @returns {Promise<unknown>}
 */
async function settledFlush(flushing, onError) {
  try {
    return await flushing;
  } catch (error) {
    onError(error);
    return NULL_VALUE;
  }
}

/**
 * @param {unknown} source
 * @returns {(() => unknown) | undefined}
 */
function callableOrUndefined(source) {
  if (typeof source !== "function") {
    return undefined;
  }
  return () => {
    /** @type {unknown} */
    const value = Reflect.apply(source, undefined, []);
    return value;
  };
}

/**
 * @param {unknown} handler
 * @returns {ErrorHandler}
 */
function errorHandler(handler) {
  if (typeof handler !== "function") {
    return () => undefined;
  }
  return (reason) => {
    Reflect.apply(handler, undefined, [reason]);
  };
}

/**
 * @param {unknown} timestamp
 * @returns {() => unknown}
 */
function timestampSource(timestamp) {
  return callableOrUndefined(timestamp) ?? (() => new Date().toISOString());
}

/**
 * @param {Readonly<Record<string, unknown>>} config
 * @param {string} flushKey
 * @param {string} defaultName
 * @returns {CaptureSettings}
 */
function captureSettings(config, flushKey, defaultName) {
  return {
    transport: config["transport"],

    flushOnEvent: config[flushKey] === true,

    includeErrorStack: config["includeErrorStack"] === true,

    logger: config["logger"] ?? defaultName,

    metadata: compactMetadata(config["metadata"]),

    timestamp: timestampSource(config["timestamp"]),

    eventIdPrefix: config["eventIdPrefix"] ?? defaultName,

    onError: errorHandler(config["onError"])
  };
}

module.exports = { callableOrUndefined, captureSettings, settledFlush };
