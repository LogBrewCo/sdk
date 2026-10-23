"use strict";

const diagnosticsChannel = require("node:diagnostics_channel");
const { writeSync } = require("node:fs");
const { inspect } = require("node:util");
const {
  LogBrewClient,
  SdkError,
  createIssueAttributesFromError
} = require("@logbrew/sdk");
const { createAutomaticEventId } = require("./automatic-event-id.cjs");

const INSTALLED = Symbol.for("@logbrew/node.processErrorCapture");
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;
const MAX_FLUSH_TIMEOUT_MS = 30_000;
const UNCAUGHT_MECHANISM = "node.uncaught_exception";
const REJECTION_MECHANISM = "node.unhandled_rejection";
const WORKER_MECHANISM = "node.worker_error";
const NON_FATAL_REJECTION_MODES = new Set(["warn", "none", "warn-with-error-code"]);

// Reports uncaught exceptions, unhandled rejections, and worker thread errors, then keeps
// Node's own exit behavior.
function installLogBrewProcessErrorCapture(config, activeTraceProvider = () => undefined) {
  const options = validateConfig(config);
  const nodeProcess = globalThis.process;
  if (nodeProcess[INSTALLED]) {
    throw new SdkError("configuration_error", "process error capture is already installed");
  }
  const reported = new WeakSet();
  let exiting = false;

  const onUncaughtException = (error, origin) => {
    if (exiting) {
      return;
    }
    capture(error, origin === "unhandledRejection" ? REJECTION_MECHANISM : UNCAUGHT_MECHANISM, "fatal");
    if (nodeProcess.listenerCount("uncaughtException") > 1) {
      // Another handler owns the decision to keep running.
      void flushWithin(options);
      return;
    }
    exiting = true;
    void flushWithin(options).finally(() => {
      writeSync(2, `${inspect(error)}\n\nNode.js ${nodeProcess.version}\n`);
      nodeProcess.exit(1);
    });
  };

  const onUnhandledRejection = (reason) => {
    const mode = unhandledRejectionsMode(nodeProcess);
    if (nodeProcess.listenerCount("unhandledRejection") > 1 || NON_FATAL_REJECTION_MODES.has(mode)) {
      capture(reason, REJECTION_MECHANISM, "error");
      void flushWithin(options);
      if (mode === "warn-with-error-code" && nodeProcess.listenerCount("unhandledRejection") === 1) {
        nodeProcess.exitCode = 1;
      }
      return;
    }
    // Node raises an unhandled rejection as an uncaught exception when no other handler exists.
    capture(reason, REJECTION_MECHANISM, "fatal");
    const uncaught = asUncaughtError(reason);
    markReported(uncaught);
    nodeProcess.nextTick(() => {
      throw uncaught;
    });
  };

  // A worker error with no app listener ends the main thread, as an uncaught exception.
  // One with an app listener is the app's to handle, so it is only reported.
  const onWorkerCreated = ({ worker }) => {
    worker.on("error", function onWorkerError(error) {
      if (worker.listenerCount("error") === 1) {
        // Without listeners, emit throws exactly as it would without the SDK.
        worker.off("error", onWorkerError);
        worker.emit("error", error);
      } else if (installed) {
        capture(error, WORKER_MECHANISM, "error");
        void flushWithin(options);
      }
    });
  };

  function capture(error, mechanism, level) {
    if (isObjectLike(error)) {
      if (reported.has(error)) {
        return;
      }
      reported.add(error);
    }
    try {
      options.client.issue(
        createAutomaticEventId("evt_node_process", mechanism.slice("node.".length)),
        new Date().toISOString(),
        createIssueAttributesFromError(error, {
          handled: false,
          includeErrorStack: options.includeErrorStack,
          level,
          mechanism,
          runtime: "node",
          source: mechanism,
          trace: activeTraceProvider()
        })
      );
    } catch (captureError) {
      notifyCaptureError(options, captureError);
    }
  }

  function markReported(error) {
    if (isObjectLike(error)) {
      reported.add(error);
    }
  }

  nodeProcess.on("uncaughtException", onUncaughtException);
  nodeProcess.on("unhandledRejection", onUnhandledRejection);
  diagnosticsChannel.subscribe("worker_threads", onWorkerCreated);
  nodeProcess[INSTALLED] = true;
  let installed = true;
  return {
    uninstall() {
      if (!installed) {
        return;
      }
      installed = false;
      nodeProcess.off("uncaughtException", onUncaughtException);
      nodeProcess.off("unhandledRejection", onUnhandledRejection);
      diagnosticsChannel.unsubscribe("worker_threads", onWorkerCreated);
      delete nodeProcess[INSTALLED];
    }
  };
}

function validateConfig(config) {
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new SdkError("configuration_error", "installLogBrewProcessErrorCapture requires a config object");
  }
  if (!(config.client instanceof LogBrewClient)) {
    throw new SdkError("configuration_error", "process error capture client must be a LogBrewClient");
  }
  if (config.transport !== undefined && (!config.transport || typeof config.transport.send !== "function")) {
    throw new SdkError("configuration_error", "process error capture transport.send must be a function");
  }
  const flushTimeoutMs = config.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  if (!Number.isInteger(flushTimeoutMs) || flushTimeoutMs < 0 || flushTimeoutMs > MAX_FLUSH_TIMEOUT_MS) {
    throw new SdkError(
      "configuration_error",
      `process error capture flushTimeoutMs must be an integer from 0 to ${MAX_FLUSH_TIMEOUT_MS}`
    );
  }
  if (config.includeErrorStack !== undefined && typeof config.includeErrorStack !== "boolean") {
    throw new SdkError("configuration_error", "process error capture includeErrorStack must be a boolean");
  }
  if (config.onCaptureError !== undefined && typeof config.onCaptureError !== "function") {
    throw new SdkError("configuration_error", "process error capture onCaptureError must be a function");
  }
  return {
    client: config.client,
    flushTimeoutMs,
    includeErrorStack: config.includeErrorStack === true,
    onCaptureError: config.onCaptureError,
    transport: config.transport
  };
}

async function flushWithin(options) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, options.flushTimeoutMs);
  });
  try {
    await Promise.race([
      options.client.flush(options.transport).catch((error) => notifyCaptureError(options, error)),
      deadline
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function notifyCaptureError(options, error) {
  if (typeof options.onCaptureError !== "function") {
    return;
  }
  try {
    options.onCaptureError(error);
  } catch {
    // A failing observer must not replace the original process failure.
  }
}

function unhandledRejectionsMode(nodeProcess) {
  const flags = [...nodeProcess.execArgv, ...(nodeProcess.env.NODE_OPTIONS ?? "").split(/\s+/u)];
  let mode = "throw";
  for (const flag of flags) {
    const match = /^--unhandled-rejections=(.+)$/u.exec(flag);
    if (match) {
      mode = match[1];
    }
  }
  return mode;
}

function asUncaughtError(reason) {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(
    "This error originated either by throwing inside of an async function without a catch block, "
      + "or by rejecting a promise which was not handled with .catch(). "
      + `The promise rejected with the reason "${inspect(reason)}".`
  );
  error.code = "ERR_UNHANDLED_REJECTION";
  return error;
}

function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

module.exports = { installLogBrewProcessErrorCapture };
