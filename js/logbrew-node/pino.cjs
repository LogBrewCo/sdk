"use strict";

const diagnosticsChannel = require("node:diagnostics_channel");
const {
  LogBrewClient,
  SdkError,
  logAttributesFromPinoRecord
} = require("@logbrew/sdk");
const { createAutomaticEventId } = require("./automatic-event-id.cjs");
const { attempt, isWeakKey, readMember, readOptionalMember } = require("./internal.cjs");
const { normalizedPinoRecord, pinoLevelNumber, settle } = require("./pino-record.cjs");

/**
 * @import { PinoLogRecord, TransportResponse } from "@logbrew/sdk"
 * @import {
 *   LogBrewPinoInstrumentationConfig,
 *   LogBrewPinoInstrumentationHandle,
 *   LogBrewTraceContext
 * } from "./index.cjs"
 */

/**
 * @typedef {{ capturing: boolean, installed: boolean }} PinoState
 */

const PINO_AS_JSON_END_CHANNEL = diagnosticsChannel.channel("tracing:pino_asJson:end");
const DEFAULT_EVENT_ID_PREFIX = "evt_node_pino";
const LOGBREW_PINO_INSTRUMENTATION = Symbol.for("@logbrew/node.pinoInstrumentation");
const MAX_TEXT_OPTION_LENGTH = 128;
const NO_PENDING_EVENTS = 0;
const NON_WORD_RUN = /[^a-z0-9]+/gu;
const EDGE_UNDERSCORES = /^_+|_+$/gu;
/** @type {(value: unknown) => string} */
const text = String;

/**
 * @param {string} message
 * @returns {never}
 */
function configurationError(message) {
  throw new SdkError("configuration_error", message);
}

/**
 * @param {object} config
 * @param {string} name
 * @returns {void}
 */
function checkOptionalFunction(config, name) {
  /** @type {unknown} */
  const value = Reflect.get(config, name);
  if (value !== undefined && typeof value !== "function") {
    configurationError(`Pino instrumentation ${name} must be a function`);
  }
}

/**
 * @param {object} config
 * @param {string} name
 * @returns {void}
 */
function checkOptionalText(config, name) {
  /** @type {unknown} */
  const value = Reflect.get(config, name);
  if (value !== undefined && (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT_OPTION_LENGTH)) {
    configurationError(`Pino instrumentation ${name} must be 1 to 128 characters`);
  }
}

/**
 * @param {object} config
 * @returns {void}
 */
function checkOptions(config) {
  for (const name of ["shouldCapture", "traceProvider", "timestamp", "onError"]) {
    checkOptionalFunction(config, name);
  }
  /** @type {unknown} */
  const includeErrorStack = Reflect.get(config, "includeErrorStack");
  if (includeErrorStack !== undefined && typeof includeErrorStack !== "boolean") {
    configurationError("Pino instrumentation includeErrorStack must be a boolean");
  }
  checkOptionalText(config, "eventIdPrefix");
  checkOptionalText(config, "logger");
  /** @type {unknown} */
  const metadata = Reflect.get(config, "metadata");
  if (metadata !== undefined && (metadata === null || Array.isArray(metadata) || typeof metadata !== "object")) {
    configurationError("Pino instrumentation metadata must be an object");
  }
}

/**
 * @param {unknown} config
 * @returns {asserts config is LogBrewPinoInstrumentationConfig}
 */
function validateConfig(config) {
  if (config === null || Array.isArray(config) || typeof config !== "object") {
    configurationError("installLogBrewPinoInstrumentation requires a config object");
  }
  if (typeof diagnosticsChannel.tracingChannel !== "function") {
    configurationError("automatic Pino instrumentation requires Node.js 18.19 or newer");
  }
  if (!(Reflect.get(config, "client") instanceof LogBrewClient)) {
    configurationError("Pino instrumentation client must be a LogBrewClient");
  }
  checkOptions(config);
  const installed = Boolean(readOptionalMember(Reflect.get(globalThis, LOGBREW_PINO_INSTRUMENTATION), "installed"));
  if (installed) {
    configurationError("Pino instrumentation is already installed in this process");
  }
}

/**
 * @param {unknown} error
 * @param {unknown} onError
 * @returns {void}
 */
function reportError(onError, error) {
  if (typeof onError !== "function") {
    return;
  }
  attempt(() => {
    /** @type {unknown} */
    const result = Reflect.apply(onError, undefined, [error]);
    if (isWeakKey(result) && typeof readMember(result, "then") === "function") {
      void settle(result);
    }
  });
}

/**
 * @param {LogBrewPinoInstrumentationConfig} config
 * @returns {LogBrewTraceContext | null | undefined}
 */
function traceFromProvider(config) {
  const provider = config.traceProvider;
  if (!provider) {
    return undefined;
  }
  try {
    return provider();
  } catch (error) {
    reportError(config.onError, error);
    return undefined;
  }
}

/**
 * @param {Readonly<PinoLogRecord>} record
 * @param {LogBrewPinoInstrumentationConfig} config
 * @returns {string}
 */
function timestampFromPinoRecord(record, config) {
  const value = record.time ?? record.timestamp;
  if ((typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.trim() !== "")) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
  }
  const fallback = config.timestamp;
  return typeof fallback === "function" ? fallback() : new Date().toISOString();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function eventIdLevel(value) {
  return text(value ?? "info").toLowerCase().replaceAll(NON_WORD_RUN, "_").replaceAll(EDGE_UNDERSCORES, "") || "info";
}

/**
 * @param {LogBrewPinoInstrumentationConfig} config
 * @param {unknown} data
 * @returns {void}
 */
function captureRecord(config, data) {
  const levelNumber = pinoLevelNumber(data);
  const record = normalizedPinoRecord(data, levelNumber);
  if (config.shouldCapture?.(record, { instance: readOptionalMember(data, "instance"), level: levelNumber }) === false) {
    return;
  }
  const trace = traceFromProvider(config);
  const attributes = logAttributesFromPinoRecord(record, {
    includeErrorStack: config.includeErrorStack === true,
    logger: config.logger ?? "pino",
    ...(config.metadata === undefined ? {} : { metadata: config.metadata }),
    ...(trace === undefined ? {} : { trace })
  });
  config.client.log(
    createAutomaticEventId(config.eventIdPrefix ?? DEFAULT_EVENT_ID_PREFIX, eventIdLevel(attributes.metadata?.["pinoLevel"])),
    timestampFromPinoRecord(record, config),
    attributes
  );
}

/**
 * @param {LogBrewPinoInstrumentationConfig} config
 * @returns {Promise<TransportResponse | null>}
 */
async function flushPino(config) {
  try {
    if (config.client.pendingEvents() === NO_PENDING_EVENTS) {
      return null;
    }
    return await config.client.flush(config.transport);
  } catch (error) {
    reportError(config.onError, error);
    return null;
  }
}

/**
 * @param {unknown} config
 * @returns {LogBrewPinoInstrumentationHandle}
 */
function installLogBrewPinoInstrumentation(config) {
  validateConfig(config);
  /** @type {LogBrewPinoInstrumentationConfig} */
  const options = config;
  /** @type {PinoState} */
  const state = { capturing: false, installed: true };
  /**
   * @param {unknown} data
   * @returns {void}
   */
  function onPinoEnd(data) {
    if (!state.installed || state.capturing) {
      return;
    }
    state.capturing = true;
    try {
      captureRecord(options, data);
    } catch (error) {
      reportError(options.onError, error);
    } finally {
      state.capturing = false;
    }
  }
  PINO_AS_JSON_END_CHANNEL.subscribe(onPinoEnd);
  Object.defineProperty(globalThis, LOGBREW_PINO_INSTRUMENTATION, { configurable: true, value: state });
  return {
    flush: async () => flushPino(options),
    uninstall: () => {
      if (!state.installed) {
        return;
      }
      state.installed = false;
      PINO_AS_JSON_END_CHANNEL.unsubscribe(onPinoEnd);
      if (Reflect.get(globalThis, LOGBREW_PINO_INSTRUMENTATION) === state) {
        Reflect.deleteProperty(globalThis, LOGBREW_PINO_INSTRUMENTATION);
      }
    }
  };
}

module.exports = { installLogBrewPinoInstrumentation };
