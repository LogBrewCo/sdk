"use strict";

const { writeSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { inspect } = require("node:util");
const {
  LogBrewClient,
  SdkError,
  createIssueAttributesFromError
} = require("@logbrew/sdk");
const { createAutomaticEventId } = require("./automatic-event-id.cjs");
const { attempt } = require("./internal.cjs");

/**
 * @import { IssueAttributes, Transport } from "@logbrew/sdk"
 * @import { LogBrewTraceContext } from "./index.cjs"
 */

/**
 * @typedef {() => LogBrewTraceContext | undefined} ActiveTraceProvider
 * @typedef {Readonly<{
 *   markReported: (error: unknown) => void,
 *   report: (error: unknown, mechanism: string, level: "error" | "fatal") => void
 * }>} ProcessCapture
 * @typedef {Readonly<{
 *   client: LogBrewClient,
 *   flushTimeoutMs: number,
 *   includeErrorStack: boolean,
 *   onCaptureError: unknown,
 *   transport: Transport | undefined
 * }>} CaptureOptions
 */

const DEFAULT_FLUSH_TIMEOUT_MS = 2000;
const MAX_FLUSH_TIMEOUT_MS = 30_000;
const MIN_FLUSH_TIMEOUT_MS = 0;
const STDERR = 2;
const FAILURE_EXIT_CODE = 1;
const MECHANISM_PREFIX_LENGTH = "node.".length;
const UNCAUGHT_MECHANISM = "node.uncaught_exception";
const REJECTION_MECHANISM = "node.unhandled_rejection";
const WORKER_MECHANISM = "node.worker_error";
const NON_FATAL_REJECTION_MODES = new Set(["warn", "none", "warn-with-error-code"]);
const WHITESPACE = /\s+/u;
const UNHANDLED_REJECTIONS_FLAG = /^--unhandled-rejections=(?<mode>.+)$/u;

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

/**
 * @param {string} message
 * @returns {never}
 */
function configurationError(message) {
  throw new SdkError("configuration_error", message);
}

/**
 * @param {unknown} value
 * @returns {value is Transport}
 */
function isTransport(value) {
  return isObjectLike(value) && typeof Reflect.get(value, "send") === "function";
}

/**
 * @param {unknown} transport
 * @returns {Transport | undefined}
 */
function validateTransport(transport) {
  if (transport === undefined) {
    return undefined;
  }
  if (!isTransport(transport)) {
    return configurationError("process error capture transport.send must be a function");
  }
  return transport;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function validateFlushTimeout(value) {
  const flushTimeoutMs = value ?? DEFAULT_FLUSH_TIMEOUT_MS;
  if (
    typeof flushTimeoutMs !== "number" ||
    !Number.isInteger(flushTimeoutMs) ||
    flushTimeoutMs < MIN_FLUSH_TIMEOUT_MS ||
    flushTimeoutMs > MAX_FLUSH_TIMEOUT_MS
  ) {
    return configurationError(
      `process error capture flushTimeoutMs must be an integer from 0 to ${String(MAX_FLUSH_TIMEOUT_MS)}`
    );
  }
  return flushTimeoutMs;
}

/**
 * @param {object} config
 * @returns {Readonly<{ includeErrorStack: boolean, onCaptureError: unknown }>}
 */
function validateCallbacks(config) {
  /** @type {unknown} */
  const includeErrorStack = Reflect.get(config, "includeErrorStack");
  if (includeErrorStack !== undefined && typeof includeErrorStack !== "boolean") {
    return configurationError("process error capture includeErrorStack must be a boolean");
  }
  /** @type {unknown} */
  const onCaptureError = Reflect.get(config, "onCaptureError");
  if (onCaptureError !== undefined && typeof onCaptureError !== "function") {
    return configurationError("process error capture onCaptureError must be a function");
  }
  return { includeErrorStack: includeErrorStack === true, onCaptureError };
}

/**
 * @param {unknown} config
 * @returns {CaptureOptions}
 */
function validateConfig(config) {
  if (config === null || Array.isArray(config) || typeof config !== "object") {
    return configurationError("installLogBrewProcessErrorCapture requires a config object");
  }
  /** @type {unknown} */
  const client = Reflect.get(config, "client");
  if (!(client instanceof LogBrewClient)) {
    return configurationError("process error capture client must be a LogBrewClient");
  }
  const transport = validateTransport(Reflect.get(config, "transport"));
  const flushTimeoutMs = validateFlushTimeout(Reflect.get(config, "flushTimeoutMs"));
  const { includeErrorStack, onCaptureError } = validateCallbacks(config);
  return { client, flushTimeoutMs, includeErrorStack, onCaptureError, transport };
}

/**
 * @param {CaptureOptions} options
 * @param {unknown} error
 * @returns {void}
 */
function notifyCaptureError(options, error) {
  const { onCaptureError } = options;
  if (typeof onCaptureError !== "function") {
    return;
  }
  attempt(() => {
    Reflect.apply(onCaptureError, options, [error]);
  });
}

/**
 * @param {CaptureOptions} options
 * @returns {Promise<void>}
 */
async function flushReportingErrors(options) {
  try {
    await options.client.flush(options.transport);
  } catch (error) {
    notifyCaptureError(options, error);
  }
}

/**
 * @param {CaptureOptions} options
 * @returns {Promise<void>}
 */
async function flushWithin(options) {
  const controller = new AbortController();
  try {
    await Promise.race([
      flushReportingErrors(options),
      delay(options.flushTimeoutMs, undefined, { signal: controller.signal })
    ]);
  } finally {
    controller.abort();
  }
}

/**
 * @param {NodeJS.Process} nodeProcess
 * @returns {string}
 */
function unhandledRejectionsMode(nodeProcess) {
  const flags = [...nodeProcess.execArgv, ...(nodeProcess.env["NODE_OPTIONS"] ?? "").split(WHITESPACE)];
  let mode = "throw";
  for (const flag of flags) {
    const match = UNHANDLED_REJECTIONS_FLAG.exec(flag);
    const flagMode = match?.groups?.["mode"];
    if (flagMode !== undefined) {
      mode = flagMode;
    }
  }
  return mode;
}

/**
 * @param {unknown} reason
 * @returns {Error}
 */
function asUncaughtError(reason) {
  if (reason instanceof Error) {
    return reason;
  }
  return Object.assign(
    new Error(
      "This error originated either by throwing inside of an async function without a catch block, " +
        "or by rejecting a promise which was not handled with .catch(). " +
        `The promise rejected with the reason "${inspect(reason)}".`
    ),
    { code: "ERR_UNHANDLED_REJECTION" }
  );
}

/**
 * @param {CaptureOptions} options
 * @param {NodeJS.Process} nodeProcess
 * @param {unknown} error
 * @returns {Promise<void>}
 */
async function exitAfterFlush(options, nodeProcess, error) {
  try {
    await flushWithin(options);
  } finally {
    writeSync(STDERR, `${inspect(error)}\n\nNode.js ${nodeProcess.version}\n`);
    nodeProcess.exit(FAILURE_EXIT_CODE);
  }
}

/**
 * @param {CaptureOptions} options
 * @param {ActiveTraceProvider} activeTraceProvider
 * @returns {ProcessCapture}
 */
function createCapture(options, activeTraceProvider) {
  /** @type {WeakSet<object>} */
  const reported = new WeakSet();
  /**
   * @param {unknown} error
   * @param {string} mechanism
   * @param {"error" | "fatal"} level
   * @returns {void}
   */
  function report(error, mechanism, level) {
    if (isObjectLike(error)) {
      if (reported.has(error)) {
        return;
      }
      reported.add(error);
    }
    try {
      const trace = activeTraceProvider();
      /** @type {IssueAttributes} */
      const attributes = createIssueAttributesFromError(error, {
        handled: false,
        includeErrorStack: options.includeErrorStack,
        level,
        mechanism,
        runtime: "node",
        source: mechanism,
        ...(trace === undefined ? {} : { trace })
      });
      options.client.issue(
        createAutomaticEventId("evt_node_process", mechanism.slice(MECHANISM_PREFIX_LENGTH)),
        new Date().toISOString(),
        attributes
      );
    } catch (captureError) {
      notifyCaptureError(options, captureError);
    }
  }
  return {
    markReported: (error) => {
      if (isObjectLike(error)) {
        reported.add(error);
      }
    },
    report
  };
}

module.exports = {
  NON_FATAL_REJECTION_MODES,
  REJECTION_MECHANISM,
  UNCAUGHT_MECHANISM,
  WORKER_MECHANISM,
  asUncaughtError,
  createCapture,
  exitAfterFlush,
  flushWithin,
  unhandledRejectionsMode,
  validateConfig
};
