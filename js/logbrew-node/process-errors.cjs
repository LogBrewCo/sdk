"use strict";

const diagnosticsChannel = require("node:diagnostics_channel");
const { SdkError } = require("@logbrew/sdk");
const {
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
} = require("./process-capture.cjs");
const { callMethod, readMember } = require("./internal.cjs");

/**
 * @import { LogBrewProcessErrorCaptureHandle } from "./index.cjs"
 * @import { ActiveTraceProvider, CaptureOptions, ProcessCapture } from "./process-capture.cjs"
 */

/**
 * @typedef {Readonly<{ get: () => boolean, set: (value: boolean) => void }>} Flag
 * @typedef {Readonly<{
 *   capture: ProcessCapture,
 *   exiting: Flag,
 *   installed: Flag,
 *   nodeProcess: NodeJS.Process,
 *   options: CaptureOptions
 * }>} HandlerContext
 */

const INSTALLED = Symbol.for("@logbrew/node.processErrorCapture");
const SINGLE_LISTENER = 1;
const FAILURE_EXIT_CODE = 1;

/**
 * @param {boolean} initial
 * @returns {Flag}
 */
function createFlag(initial) {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    }
  };
}

/**
 * @param {HandlerContext} context
 * @returns {(error: unknown, origin: unknown) => void}
 */
function createUncaughtExceptionHandler(context) {
  const { capture, exiting, nodeProcess, options } = context;
  return (error, origin) => {
    if (exiting.get()) {
      return;
    }
    capture.report(error, origin === "unhandledRejection" ? REJECTION_MECHANISM : UNCAUGHT_MECHANISM, "fatal");
    if (nodeProcess.listenerCount("uncaughtException") > SINGLE_LISTENER) {
      void flushWithin(options);
      return;
    }
    exiting.set(true);
    void exitAfterFlush(options, nodeProcess, error);
  };
}

/**
 * @param {HandlerContext} context
 * @param {unknown} reason
 * @param {string} mode
 * @returns {void}
 */
function reportNonFatalRejection(context, reason, mode) {
  const { capture, nodeProcess, options } = context;
  capture.report(reason, REJECTION_MECHANISM, "error");
  void flushWithin(options);
  if (mode === "warn-with-error-code" && nodeProcess.listenerCount("unhandledRejection") === SINGLE_LISTENER) {
    nodeProcess.exitCode = FAILURE_EXIT_CODE;
  }
}

/**
 * @param {HandlerContext} context
 * @returns {(reason: unknown) => void}
 */
function createUnhandledRejectionHandler(context) {
  const { capture, nodeProcess } = context;
  return (reason) => {
    const mode = unhandledRejectionsMode(nodeProcess);
    if (nodeProcess.listenerCount("unhandledRejection") > SINGLE_LISTENER || NON_FATAL_REJECTION_MODES.has(mode)) {
      reportNonFatalRejection(context, reason, mode);
      return;
    }
    capture.report(reason, REJECTION_MECHANISM, "fatal");
    const uncaught = asUncaughtError(reason);
    capture.markReported(uncaught);
    nodeProcess.nextTick(() => {
      throw uncaught;
    });
  };
}

/**
 * @param {HandlerContext} context
 * @returns {(message: unknown) => void}
 */
function createWorkerHandler(context) {
  const { capture, installed, options } = context;
  return (message) => {
    const worker = readMember(message, "worker");
    callMethod(worker, "on", [
      "error",
      /**
       * @param {unknown} error
       * @returns {void}
       */
      function onWorkerError(error) {
        if (callMethod(worker, "listenerCount", ["error"]) === SINGLE_LISTENER) {
          callMethod(worker, "off", ["error", onWorkerError]);
          callMethod(worker, "emit", ["error", error]);
        } else if (installed.get()) {
          capture.report(error, WORKER_MECHANISM, "error");
          void flushWithin(options);
        }
      }
    ]);
  };
}

/**
 * @param {HandlerContext} context
 * @returns {() => void}
 */
function attachHandlers(context) {
  const { nodeProcess } = context;
  const onUncaughtException = createUncaughtExceptionHandler(context);
  const onUnhandledRejection = createUnhandledRejectionHandler(context);
  const onWorkerCreated = createWorkerHandler(context);
  nodeProcess.on("uncaughtException", onUncaughtException);
  nodeProcess.on("unhandledRejection", onUnhandledRejection);
  diagnosticsChannel.subscribe("worker_threads", onWorkerCreated);
  return () => {
    nodeProcess.off("uncaughtException", onUncaughtException);
    nodeProcess.off("unhandledRejection", onUnhandledRejection);
    diagnosticsChannel.unsubscribe("worker_threads", onWorkerCreated);
  };
}

/**
 * @param {unknown} config
 * @param {ActiveTraceProvider} [activeTraceProvider]
 * @returns {LogBrewProcessErrorCaptureHandle}
 */
function installLogBrewProcessErrorCapture(config, activeTraceProvider = () => undefined) {
  const options = validateConfig(config);
  const nodeProcess = globalThis.process;
  const alreadyInstalled = Boolean(Reflect.get(nodeProcess, INSTALLED));
  if (alreadyInstalled) {
    throw new SdkError("configuration_error", "process error capture is already installed");
  }
  const installed = createFlag(false);
  const detach = attachHandlers({
    capture: createCapture(options, activeTraceProvider),
    exiting: createFlag(false),
    installed,
    nodeProcess,
    options
  });
  Reflect.set(nodeProcess, INSTALLED, true);
  installed.set(true);
  return {
    uninstall: () => {
      if (!installed.get()) {
        return;
      }
      installed.set(false);
      detach();
      Reflect.deleteProperty(nodeProcess, INSTALLED);
    }
  };
}

module.exports = { installLogBrewProcessErrorCapture };
