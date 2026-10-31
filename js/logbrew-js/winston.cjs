const { Writable } = require("node:stream");

const { callableOrUndefined, captureSettings, settledFlush } = require("./capture-support.cjs");
const { LogBrewClient } = require("./client.cjs");
const { traceFromProvider } = require("./log-context.cjs");
const { NULL_VALUE } = require("./null-value.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { isObjectValue, isRecord, isTruthy, optionalProperty } = require("./validation.cjs");
const { logAttributesFromWinstonInfo, timestampFromWinstonInfo, winstonMessage } = require("./winston-info.cjs");

/**
 * @import { IssueBreadcrumbLevel } from "./index.cjs"
 * @import { CaptureClient } from "./capture-support.cjs"
 * @typedef {CaptureClient & Readonly<{
 *   breadcrumbProvider: unknown,
 *   addBreadcrumb: (breadcrumb: unknown) => unknown
 * }>} WinstonClient
 * @typedef {{ type: "debug", category: string, level: IssueBreadcrumbLevel, message: string }} WinstonBreadcrumb
 */

const BREADCRUMB_RECORDER = Symbol.for("@logbrew/sdk.breadcrumbRecorder");
const MAX_BREADCRUMB_MESSAGE_LENGTH = 512;
const FIRST_CHARACTER = 0;
const NO_PENDING_EVENTS = 0;
/** @type {ReadonlyMap<string, IssueBreadcrumbLevel>} */
const BREADCRUMB_LEVELS = new Map([
  ["error", "error"],
  ["crit", "error"],
  ["critical", "error"],
  ["fatal", "error"],
  ["alert", "error"],
  ["emerg", "error"],
  ["warn", "warning"],
  ["warning", "warning"],
  ["verbose", "debug"],
  ["debug", "debug"],
  ["silly", "debug"]
]);

/**
 * @param {unknown} level
 * @returns {IssueBreadcrumbLevel}
 */
function winstonBreadcrumbLevel(level) {
  return BREADCRUMB_LEVELS.get(String(level).toLowerCase()) ?? "info";
}

class WinstonCapture {
  /**
   * @param {Readonly<Record<string, unknown>>} config
   * @param {WinstonClient} client
   */
  constructor(config, client) {
    this.client = client;
    this.breadcrumbs = config["breadcrumbs"] !== false;
    this.settings = captureSettings(config, "flushOnWrite", "winston");
    this.traceProvider = callableOrUndefined(config["traceProvider"]);
    this.captured = 0;
    /** @type {Promise<unknown>} */
    this.pendingFlush = Promise.resolve(NULL_VALUE);
  }

  /**
   * @param {unknown} info
   * @returns {void}
   */
  write(info) {
    try {
      if (this.breadcrumbs) {
        this.recordBreadcrumb(info);
      }
      this.capture(info);
    } catch (error) {
      this.settings.onError(error);
    }
  }

  /**
   * @param {unknown} info
   * @returns {boolean}
   */
  recordBreadcrumb(info) {
    if (!isRecord(info) || info["silent"] === true) {
      return false;
    }
    /** @type {WinstonBreadcrumb} */
    const breadcrumb = {
      type: "debug",

      category: "log.winston",
      level: winstonBreadcrumbLevel(info["level"]),
      message: [...winstonMessage(info)].slice(FIRST_CHARACTER, MAX_BREADCRUMB_MESSAGE_LENGTH).join("")
    };
    /** @type {unknown} */
    const recorder = isTruthy(this.client.breadcrumbProvider) ? Reflect.get(globalThis, BREADCRUMB_RECORDER) : undefined;
    try {
      if (typeof recorder === "function") {
        Reflect.apply(recorder, undefined, [breadcrumb]);
      } else {
        this.client.addBreadcrumb(breadcrumb);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {unknown} info
   * @returns {void}
   */
  capture(info) {
    if (optionalProperty(info, "silent") === true) {
      return;
    }
    const { settings } = this;
    this.captured += 1;
    this.client.log(
      [settings.eventIdPrefix, this.captured].join("_"),
      timestampFromWinstonInfo(info, settings.timestamp),
      logAttributesFromWinstonInfo(info, {
        includeErrorStack: settings.includeErrorStack,
        logger: settings.logger,
        metadata: settings.metadata,
        trace: traceFromProvider(this.traceProvider, settings.onError)
      })
    );
    if (settings.flushOnEvent && isTruthy(settings.transport)) {
      this.pendingFlush = settledFlush(this.client.flush(settings.transport), settings.onError);
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
   * @returns {() => Promise<unknown>}
   */
  flushHandler() {
    return async () => {
      this.flushPending();
      return this.pendingFlush;
    };
  }
}

/**
 * @this {Readonly<{ write: (chunk: unknown) => boolean }>}
 * @param {unknown} info
 * @param {unknown} callback
 * @returns {void}
 */
function log(info, callback) {
  this.write(info);
  if (typeof callback === "function") {
    Reflect.apply(callback, undefined, []);
  }
}

/**
 * @param {Readonly<Record<string, unknown>>} config
 * @returns {Readonly<Record<string, unknown>>}
 */
function winstonTransportOptions(config) {
  const { level, name } = config;
  const nameText = String(name);
  return {
    ...(typeof level === "string" && level.trim() !== "" ? { level } : {}),
    ...(name === undefined ? {} : { name: nameText }),
    ...(config["silent"] === true ? { silent: true } : {}),
    ...(config["handleExceptions"] === true ? { handleExceptions: true } : {}),
    ...(config["handleRejections"] === true ? { handleRejections: true } : {})
  };
}

/**
 * @param {unknown} config
 * @returns {Writable}
 */
function createLogBrewWinstonTransport(config) {
  if (!isObjectValue(config)) {
    throw new SdkError("validation_error", "Winston transport config must be an object");
  }
  const { client } = config;
  if (!(client instanceof LogBrewClient)) {
    throw new SdkError("validation_error", "Winston transport client must be a LogBrewClient");
  }
  const capture = new WinstonCapture(config, client);
  const winstonTransport = new Writable({
    objectMode: true,
    /**
     * @param {unknown} info
     * @param {unknown} _encoding
     * @param {() => void} callback
     * @returns {void}
     */
    write(info, _encoding, callback) {
      try {
        capture.write(info);
      } finally {
        Reflect.apply(callback, undefined, []);
      }
    }
  });
  return Object.assign(
    winstonTransport,
    {
      log,

      flush: capture.flushHandler()
    },
    winstonTransportOptions(config)
  );
}

module.exports = { createLogBrewWinstonTransport, logAttributesFromWinstonInfo };
