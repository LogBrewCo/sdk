"use strict";

const diagnosticsChannel = require("node:diagnostics_channel");
const {
  LogBrewClient,
  SdkError,
  logAttributesFromPinoRecord
} = require("@logbrew/sdk");
const { createAutomaticEventId } = require("./automatic-event-id.cjs");

const PINO_AS_JSON_END_CHANNEL = diagnosticsChannel.channel("tracing:pino_asJson:end");
const DEFAULT_EVENT_ID_PREFIX = "evt_node_pino";
const LOGBREW_PINO_INSTRUMENTATION = Symbol.for("@logbrew/node.pinoInstrumentation");

function installLogBrewPinoInstrumentation(config) {
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new SdkError("configuration_error", "installLogBrewPinoInstrumentation requires a config object");
  }
  if (typeof diagnosticsChannel.tracingChannel !== "function") {
    throw new SdkError(
      "configuration_error",
      "automatic Pino instrumentation requires Node.js 18.19 or newer"
    );
  }
  if (!(config.client instanceof LogBrewClient)) {
    throw new SdkError("configuration_error", "Pino instrumentation client must be a LogBrewClient");
  }
  if (config.shouldCapture !== undefined && typeof config.shouldCapture !== "function") {
    throw new SdkError("configuration_error", "Pino instrumentation shouldCapture must be a function");
  }
  if (config.traceProvider !== undefined && typeof config.traceProvider !== "function") {
    throw new SdkError("configuration_error", "Pino instrumentation traceProvider must be a function");
  }
  if (config.timestamp !== undefined && typeof config.timestamp !== "function") {
    throw new SdkError("configuration_error", "Pino instrumentation timestamp must be a function");
  }
  if (config.onError !== undefined && typeof config.onError !== "function") {
    throw new SdkError("configuration_error", "Pino instrumentation onError must be a function");
  }
  if (config.includeErrorStack !== undefined && typeof config.includeErrorStack !== "boolean") {
    throw new SdkError("configuration_error", "Pino instrumentation includeErrorStack must be a boolean");
  }
  if (
    config.eventIdPrefix !== undefined
    && (typeof config.eventIdPrefix !== "string" || config.eventIdPrefix.trim() === "" || config.eventIdPrefix.length > 128)
  ) {
    throw new SdkError("configuration_error", "Pino instrumentation eventIdPrefix must be 1 to 128 characters");
  }
  if (
    config.logger !== undefined
    && (typeof config.logger !== "string" || config.logger.trim() === "" || config.logger.length > 128)
  ) {
    throw new SdkError("configuration_error", "Pino instrumentation logger must be 1 to 128 characters");
  }
  if (config.metadata !== undefined && (!config.metadata || Array.isArray(config.metadata) || typeof config.metadata !== "object")) {
    throw new SdkError("configuration_error", "Pino instrumentation metadata must be an object");
  }
  if (globalThis[LOGBREW_PINO_INSTRUMENTATION]?.installed) {
    throw new SdkError("configuration_error", "Pino instrumentation is already installed in this process");
  }

  const state = {
    capturing: false,
    installed: true
  };
  const onPinoEnd = (data) => {
    if (!state.installed || state.capturing) {
      return;
    }
    state.capturing = true;
    try {
      const levelNumber = pinoLevelNumber(data);
      const record = normalizedPinoRecord(data, levelNumber);
      if (config.shouldCapture?.(record, { instance: data?.instance, level: levelNumber }) === false) {
        return;
      }
      const trace = traceFromProvider(config.traceProvider, config.onError);
      const attributes = logAttributesFromPinoRecord(record, {
        includeErrorStack: config.includeErrorStack === true,
        logger: config.logger ?? "pino",
        metadata: config.metadata,
        trace
      });
      config.client.log(
        createAutomaticEventId(
          config.eventIdPrefix ?? DEFAULT_EVENT_ID_PREFIX,
          eventIdLevel(attributes.metadata?.pinoLevel)
        ),
        timestampFromPinoRecord(record, config.timestamp),
        attributes
      );
    } catch (error) {
      reportError(config.onError, error);
    } finally {
      state.capturing = false;
    }
  };

  PINO_AS_JSON_END_CHANNEL.subscribe(onPinoEnd);
  Object.defineProperty(globalThis, LOGBREW_PINO_INSTRUMENTATION, {
    configurable: true,
    value: state
  });

  return {
    async flush() {
      try {
        if (config.client.pendingEvents() === 0) {
          return null;
        }
        return await config.client.flush(config.transport);
      } catch (error) {
        reportError(config.onError, error);
        return null;
      }
    },
    uninstall() {
      if (!state.installed) {
        return;
      }
      state.installed = false;
      PINO_AS_JSON_END_CHANNEL.unsubscribe(onPinoEnd);
      if (globalThis[LOGBREW_PINO_INSTRUMENTATION] === state) {
        delete globalThis[LOGBREW_PINO_INSTRUMENTATION];
      }
    }
  };
}

function normalizedPinoRecord(data, levelNumber) {
  if (typeof data?.result !== "string") {
    throw new SdkError("validation_error", "Pino diagnostics result must be a JSON string");
  }
  const parsed = JSON.parse(data.result);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new SdkError("validation_error", "Pino diagnostics result must contain a JSON object");
  }

  const record = { ...parsed };
  const messageKey = getPinoKey(data.instance, "pino.messageKey", "msg");
  const errorKey = getPinoKey(data.instance, "pino.errorKey", "err");
  if (messageKey !== "msg") {
    if (record.msg === undefined) {
      record.msg = record[messageKey];
    }
    delete record[messageKey];
  }
  if (errorKey !== "err") {
    if (record.err === undefined) {
      record.err = record[errorKey];
    }
    delete record[errorKey];
  }
  if (record.level === undefined && levelNumber !== undefined) {
    record.level = levelNumber;
  }
  return record;
}

function getPinoKey(logger, symbolName, fallback) {
  if (!logger || typeof logger !== "object" && typeof logger !== "function") {
    return fallback;
  }
  try {
    const expected = `Symbol(${symbolName})`;
    const visited = new Set();
    let owner = logger;
    for (let depth = 0; owner && depth < 8 && !visited.has(owner); depth += 1) {
      visited.add(owner);
      for (const symbol of Object.getOwnPropertySymbols(owner)) {
        if (symbol.toString() === expected && typeof logger[symbol] === "string") {
          return logger[symbol];
        }
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function pinoLevelNumber(data) {
  const value = data?.arguments?.[2];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function traceFromProvider(provider, onError) {
  if (!provider) {
    return undefined;
  }
  try {
    return provider();
  } catch (error) {
    reportError(onError, error);
    return undefined;
  }
}

function timestampFromPinoRecord(record, fallback) {
  const value = record.time ?? record.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
  }
  return typeof fallback === "function" ? fallback() : new Date().toISOString();
}

function eventIdLevel(value) {
  return String(value ?? "info")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "") || "info";
}

function reportError(onError, error) {
  if (typeof onError !== "function") {
    return;
  }
  try {
    const result = onError(error);
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Capture diagnostics must never interrupt application logging.
  }
}

module.exports = { installLogBrewPinoInstrumentation };
