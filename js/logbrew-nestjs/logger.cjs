"use strict";

const { slugify, traceMetadata } = require("./internal.cjs");
const { createNodeFetchTransport, getActiveLogBrewTrace } = require("@logbrew/node");

const NO_EVENTS = 0;
const SEQUENCE_STEP = 1;

/**
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import { LogBrewClient, Metadata, Transport, TransportResponse } from "@logbrew/sdk"
 * @import {
 *   LogBrewNestBaseLogger,
 *   LogBrewNestLogger,
 *   LogBrewNestLoggerLevel,
 *   LogBrewNestLoggerOptions
 * } from "./index.cjs"
 */

/**
 * @typedef {{
 *   readonly context: string | undefined,
 *   readonly logger: string,
 *   readonly message: unknown,
 *   readonly trace: Readonly<LogBrewTraceContext> | undefined
 * }} LoggerMetadataInput
 * @typedef {{
 *   readonly context: string | undefined,
 *   readonly level: LogBrewNestLoggerLevel,
 *   readonly message: unknown
 * }} LoggerEntry
 * @typedef {{
 *   readonly nextSequence: () => number,
 *   readonly pending: () => Promise<TransportResponse | null>,
 *   readonly track: (deliver: () => Promise<TransportResponse>) => Promise<TransportResponse | null>
 * }} LoggerState
 * @typedef {{
 *   readonly client: LogBrewClient,
 *   readonly idFactory: NonNullable<LogBrewNestLoggerOptions["idFactory"]>,
 *   readonly logger: string,
 *   readonly now: () => string,
 *   readonly options: LogBrewNestLoggerOptions,
 *   readonly state: LoggerState,
 *   readonly transport: Transport
 * }} LoggerRuntime
 */

/**
 * @param {LogBrewNestLoggerLevel} level
 * @param {unknown} _message
 * @param {string | undefined} context
 * @param {number} sequence
 * @returns {string}
 */
function defaultLoggerEventId(level, _message, context, sequence) {
  return `evt_nestjs_logger_${level}_${slugify(context === undefined || context === "" ? "app" : context)}_${String(sequence)}`;
}

/**
 * @param {LogBrewNestLoggerLevel} level
 * @returns {LogBrewNestLoggerLevel}
 */
function normalizeLoggerLevel(level) {
  if (level === "warning" || level === "error" || level === "critical") {
    return level;
  }
  return "info";
}

/**
 * @param {unknown} message
 * @returns {string}
 */
function messageText(message) {
  if (message instanceof Error) {
    return message.message;
  }
  if (typeof message === "string") {
    return message;
  }
  if (
    typeof message === "number" ||
    typeof message === "boolean" ||
    typeof message === "bigint" ||
    message === undefined ||
    message === null
  ) {
    return String(message);
  }
  return Object.prototype.toString.call(message);
}

/**
 * @param {LoggerMetadataInput} input
 * @returns {Metadata}
 */
function loggerMetadata(input) {
  const { context, logger, message, trace } = input;
  return {
    framework: "nestjs",
    logger,
    ...(context === undefined || context === "" ? {} : { context }),
    ...(message instanceof Error ? { errorType: message.name || "Error" } : {}),
    ...traceMetadata(trace)
  };
}

/**
 * @param {Readonly<LogBrewNestBaseLogger> | undefined} baseLogger
 * @param {keyof LogBrewNestBaseLogger} method
 * @param {readonly unknown[]} args
 * @returns {void}
 */
function forwardLoggerCall(baseLogger, method, args) {
  const target = baseLogger?.[method];
  if (typeof target === "function") {
    Reflect.apply(target, baseLogger, args);
  }
}

/**
 * @param {LogBrewNestLoggerOptions} options
 * @param {unknown} error
 * @returns {Promise<boolean>}
 */
async function notifyCaptureError(options, error) {
  if (typeof options.onCaptureError !== "function") {
    return false;
  }
  try {
    await options.onCaptureError(error);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {LogBrewNestLoggerOptions} options
 * @param {() => Promise<TransportResponse>} deliver
 * @returns {Promise<TransportResponse | null>}
 */
async function settleDelivery(options, deliver) {
  try {
    return await deliver();
  } catch (error) {
    await notifyCaptureError(options, error);
    return null;
  }
}

/**
 * @param {LogBrewNestLoggerOptions} options
 * @returns {LoggerState}
 */
function createLoggerState(options) {
  let captured = NO_EVENTS;
  /** @type {Promise<TransportResponse | null>} */
  let pendingFlush = Promise.resolve(null);
  return {
    nextSequence: () => {
      captured += SEQUENCE_STEP;
      return captured;
    },
    pending: async () => pendingFlush,
    track: async (deliver) => {
      pendingFlush = settleDelivery(options, deliver);
      return pendingFlush;
    }
  };
}

/**
 * @param {LoggerRuntime} runtime
 * @param {LogBrewNestLoggerLevel} level
 * @param {LoggerEntry & { readonly sequence: number }} entry
 * @param {Readonly<Metadata>} metadata
 * @returns {void}
 */
function recordEntry(runtime, level, entry, metadata) {
  const { client, logger, options } = runtime;
  const { context, message, sequence } = entry;
  const timestamp = runtime.now();
  const id = runtime.idFactory(level, message, context, sequence);
  if ((level === "error" || level === "critical") && options.captureErrorsAsIssues !== false) {
    client.issue(id, timestamp, {
      title: `${context === undefined || context === "" ? logger : context} ${level === "critical" ? "critical" : "error"}`,

      level,
      message: messageText(message),
      metadata
    });
  } else {
    client.log(id, timestamp, {
      message: messageText(message),

      level,
      logger,
      metadata
    });
  }
}

/**
 * @param {LoggerRuntime} runtime
 * @param {LoggerEntry} entry
 * @returns {void}
 */
function capture(runtime, entry) {
  try {
    const sequence = runtime.state.nextSequence();
    const level = normalizeLoggerLevel(entry.level);
    const { context, message } = entry;
    const metadata = loggerMetadata({ context, logger: runtime.logger, message, trace: getActiveLogBrewTrace() });
    recordEntry(runtime, level, { ...entry, sequence }, metadata);
    if (runtime.options.flushOnCapture === true) {
      void runtime.state.track(async () => runtime.client.flush(runtime.transport));
    }
  } catch (error) {
    void notifyCaptureError(runtime.options, error);
  }
}

/**
 * @param {LoggerRuntime} runtime
 * @returns {Pick<LogBrewNestLogger, "flush" | "shutdown">}
 */
function createDeliveryMethods(runtime) {
  const { client, state, transport } = runtime;
  return {
    flush: async () => {
      if (client.pendingEvents() > NO_EVENTS) {
        return state.track(async () => client.flush(transport));
      }
      return state.pending();
    },
    shutdown: async () => state.track(async () => client.shutdown(transport))
  };
}

/**
 * @param {LogBrewNestLoggerOptions} options
 * @param {LogBrewClient} client
 * @returns {LogBrewNestLogger}
 */
function createNestLogger(options, client) {
  const transport = options.transport ?? createNodeFetchTransport(options);
  const { baseLogger } = options;
  /** @type {LoggerRuntime} */
  const runtime = {
    client,
    idFactory: typeof options.idFactory === "function" ? options.idFactory : defaultLoggerEventId,
    logger: options.logger ?? "nestjs",
    now: typeof options.now === "function" ? options.now : () => new Date().toISOString(),
    options,
    state: createLoggerState(options),
    transport
  };
  return {
    client,
    transport,
    ...createDeliveryMethods(runtime),
    debug: (message, context) => {
      forwardLoggerCall(baseLogger, "debug", [message, context]);
      capture(runtime, { context, level: "info", message });
    },
    error: (message, stack, context) => {
      forwardLoggerCall(baseLogger, "error", [message, stack, context]);
      capture(runtime, { context, level: "error", message });
    },
    fatal: (message, stack, context) => {
      forwardLoggerCall(baseLogger, "fatal", [message, stack, context]);
      capture(runtime, { context, level: "critical", message });
    },
    log: (message, context) => {
      forwardLoggerCall(baseLogger, "log", [message, context]);
      capture(runtime, { context, level: "info", message });
    },
    setLogLevels: (levels) => {
      forwardLoggerCall(baseLogger, "setLogLevels", [levels]);
    },
    verbose: (message, context) => {
      forwardLoggerCall(baseLogger, "verbose", [message, context]);
      capture(runtime, { context, level: "info", message });
    },
    warn: (message, context) => {
      forwardLoggerCall(baseLogger, "warn", [message, context]);
      capture(runtime, { context, level: "warning", message });
    }
  };
}

module.exports = { createNestLogger };
