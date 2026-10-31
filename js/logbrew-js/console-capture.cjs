const { captureSettings, settledFlush } = require("./capture-support.cjs");
const { LogBrewClient } = require("./client.cjs");
const { CONSOLE_METHODS, logAttributesFromConsoleArgs } = require("./console-arguments.cjs");
const { NULL_VALUE } = require("./null-value.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { isObjectValue, isTruthy } = require("./validation.cjs");

/**
 * @import { ConsoleMethodName } from "./index.cjs"
 * @import { CaptureClient } from "./capture-support.cjs"
 * @typedef {(this: unknown, ...args: readonly unknown[]) => void} ConsoleMethod
 */

const NO_PENDING_EVENTS = 0;
/** @type {readonly ConsoleMethodName[]} */
const DEFAULT_CONSOLE_LEVELS = ["debug", "info", "log", "warn", "error"];

/**
 * @param {unknown} method
 * @returns {ConsoleMethodName}
 */
function requireConsoleMethod(method) {
  const level = [...CONSOLE_METHODS].find((name) => name === method);
  if (level === undefined) {
    throw new SdkError("validation_error", `console method must be one of: ${[...CONSOLE_METHODS].join(", ")}`);
  }
  return level;
}

/**
 * @param {unknown} levels
 * @returns {ConsoleMethodName[]}
 */
function normalizeConsoleLevels(levels) {
  const requestedLevels = levels === undefined ? DEFAULT_CONSOLE_LEVELS : levels;
  if (!Array.isArray(requestedLevels)) {
    throw new SdkError("validation_error", "console capture levels must be an array");
  }
  /** @type {ConsoleMethodName[]} */
  const normalized = [];
  /** @type {readonly unknown[]} */
  const methods = requestedLevels;
  for (const method of methods) {
    const level = requireConsoleMethod(method);
    if (!normalized.includes(level)) {
      normalized.push(level);
    }
  }
  return normalized;
}

/**
 * @param {unknown} original
 * @param {(args: readonly unknown[]) => void} record
 * @returns {ConsoleMethod}
 */
function consoleMethod(original, record) {
  /** @type {ConsoleMethod} */
  function logBrewConsoleMethod(...args) {
    if (typeof original === "function") {
      Reflect.apply(original, this, args);
    }
    record(args);
  }
  return logBrewConsoleMethod;
}

class ConsoleCapture {
  /**
   * @param {Readonly<Record<string, unknown>>} config
   * @param {CaptureClient} client
   * @param {object} targetConsole
   */
  constructor(config, client, targetConsole) {
    this.client = client;
    this.targetConsole = targetConsole;
    this.settings = captureSettings(config, "flushOnCapture", "console");
    this.levels = normalizeConsoleLevels(config["levels"]);
    /** @type {Map<ConsoleMethodName, unknown>} */
    this.originals = new Map();
    this.installed = true;
    this.captured = 0;
    /** @type {Promise<unknown>} */
    this.pendingFlush = Promise.resolve(NULL_VALUE);
  }

  /**
   * @returns {void}
   */
  install() {
    for (const method of this.levels) {
      /** @type {unknown} */
      const original = Reflect.get(this.targetConsole, method);
      if (typeof original === "function") {
        this.originals.set(method, original);
        Reflect.set(this.targetConsole, method, consoleMethod(original, (args) => {
          this.record(method, args);
        }));
      }
    }
  }

  /**
   * @param {ConsoleMethodName} method
   * @param {readonly unknown[]} args
   * @returns {void}
   */
  record(method, args) {
    if (!this.installed) {
      return;
    }
    const { settings } = this;
    try {
      this.captured += 1;
      this.client.log(
        `${String(settings.eventIdPrefix)}_${this.captured}`,
        settings.timestamp(),
        logAttributesFromConsoleArgs(method, args, {
          includeErrorStack: settings.includeErrorStack,
          logger: settings.logger,
          metadata: settings.metadata
        })
      );
      if (settings.flushOnEvent && isTruthy(settings.transport)) {
        this.pendingFlush = settledFlush(this.client.flush(settings.transport), settings.onError);
      }
    } catch (error) {
      settings.onError(error);
    }
  }

  /**
   * @returns {void}
   */
  flushPending() {
    const { settings } = this;
    if (isTruthy(settings.transport) && this.client.pendingEvents() > NO_PENDING_EVENTS) {
      this.pendingFlush = settledFlush(this.client.flush(settings.transport), settings.onError);
    }
  }

  /**
   * @returns {void}
   */
  uninstall() {
    if (!this.installed) {
      return;
    }
    this.installed = false;
    for (const [method, original] of this.originals.entries()) {
      Reflect.set(this.targetConsole, method, original);
    }
    this.originals.clear();
  }
}

/**
 * @param {Readonly<Record<string, unknown>>} config
 * @returns {object}
 */
function targetConsoleFrom(config) {
  const targetConsole = config["console"] ?? globalThis.console;
  if (!isObjectValue(targetConsole)) {
    throw new SdkError("validation_error", "console capture target must be an object");
  }
  return targetConsole;
}

/**
 * @param {unknown} config
 * @returns {{ flush: () => Promise<unknown>, uninstall: () => void }}
 */
function installLogBrewConsoleCapture(config) {
  if (!isObjectValue(config)) {
    throw new SdkError("validation_error", "console capture config must be an object");
  }
  const { client } = config;
  if (!(client instanceof LogBrewClient)) {
    throw new SdkError("validation_error", "console capture client must be a LogBrewClient");
  }
  const capture = new ConsoleCapture(config, client, targetConsoleFrom(config));
  capture.install();
  return {
    flush: async () => {
      capture.flushPending();
      return capture.pendingFlush;
    },
    uninstall: () => {
      capture.uninstall();
    }
  };
}

module.exports = { installLogBrewConsoleCapture };
