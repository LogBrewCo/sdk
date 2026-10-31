const { callableOrUndefined, captureSettings, settledFlush } = require("./capture-support.cjs");
const { LogBrewClient } = require("./client.cjs");
const { traceFromProvider } = require("./log-context.cjs");
const { NULL_VALUE } = require("./null-value.cjs");
const { logAttributesFromPinoRecord, timestampFromPinoRecord } = require("./pino-record.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { isObjectValue, isTruthy } = require("./validation.cjs");

/**
 * @import { CaptureClient } from "./capture-support.cjs"
 * @typedef {{
 *   write: (chunk: unknown) => boolean,
 *   flush: () => Promise<unknown>,
 *   end: () => Promise<unknown>
 * }} PinoDestination
 */

const NO_PENDING_EVENTS = 0;
const LINE_BREAK_PATTERN = /\r?\n/u;

class PinoDestinationState {
  /**
   * @param {Readonly<Record<string, unknown>>} config
   * @param {CaptureClient} client
   */
  constructor(config, client) {
    this.client = client;
    this.settings = captureSettings(config, "flushOnWrite", "pino");
    this.traceProvider = callableOrUndefined(config["traceProvider"]);
    this.captured = 0;
    /** @type {Promise<unknown>} */
    this.pendingFlush = Promise.resolve(NULL_VALUE);
  }

  /**
   * @param {string} line
   * @returns {void}
   */
  writeLine(line) {
    const { settings } = this;
    try {
      /** @type {unknown} */
      const record = JSON.parse(line);
      this.captured += 1;
      this.client.log(
        `${String(settings.eventIdPrefix)}_${this.captured}`,
        timestampFromPinoRecord(record, settings.timestamp),
        logAttributesFromPinoRecord(record, {
          includeErrorStack: settings.includeErrorStack,
          logger: settings.logger,
          metadata: settings.metadata,
          trace: traceFromProvider(this.traceProvider, settings.onError)
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
}

/**
 * @param {unknown} config
 * @returns {PinoDestination}
 */
function createLogBrewPinoDestination(config) {
  if (!isObjectValue(config)) {
    throw new SdkError("validation_error", "Pino destination config must be an object");
  }
  const { client } = config;
  if (!(client instanceof LogBrewClient)) {
    throw new SdkError("validation_error", "Pino destination client must be a LogBrewClient");
  }
  const state = new PinoDestinationState(config, client);
  return {
    write(chunk) {
      for (const line of String(chunk).split(LINE_BREAK_PATTERN)) {
        if (line.trim() !== "") {
          state.writeLine(line);
        }
      }
      return true;
    },

    async flush() {
      state.flushPending();
      return state.pendingFlush;
    },

    async end() {
      return this.flush();
    }
  };
}

module.exports = { createLogBrewPinoDestination };
