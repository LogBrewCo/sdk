const { Writable } = require("node:stream");

const { LogBrewClient, SdkError } = require("./core.cjs");
const { buildLogContextHelpers } = require("./log-context.cjs");

const WINSTON_RESERVED_FIELDS = new Set([
  "level",
  "message",
  "timestamp",
  "time",
  "err",
  "error",
  "stack"
]);
const {
  compactMetadata,
  isMetadataValue,
  traceFromProvider,
  traceMetadataFromLogContext
} = buildLogContextHelpers({ SdkError });

function createLogBrewWinstonTransport(config) {
  if (!config || typeof config !== "object") {
    throw new SdkError("validation_error", "Winston transport config must be an object");
  }

  const client = config.client;
  if (!(client instanceof LogBrewClient)) {
    throw new SdkError("validation_error", "Winston transport client must be a LogBrewClient");
  }

  const transport = config.transport;
  const flushOnWrite = config.flushOnWrite === true;
  const includeErrorStack = config.includeErrorStack === true;
  const logger = config.logger ?? "winston";
  const metadata = compactMetadata(config.metadata);
  const timestamp = typeof config.timestamp === "function"
    ? config.timestamp
    : () => new Date().toISOString();
  const eventIdPrefix = config.eventIdPrefix ?? "winston";
  const onError = typeof config.onError === "function" ? config.onError : () => {};
  const traceProvider = typeof config.traceProvider === "function" ? config.traceProvider : null;
  const state = {
    captured: 0,
    pendingFlush: Promise.resolve(null)
  };

  const winstonTransport = new Writable({
    objectMode: true,
    write(info, _encoding, callback) {
      try {
        captureWinstonInfo({
          client,
          eventIdPrefix,
          flushOnWrite,
          includeErrorStack,
          info,
          logger,
          metadata,
          onError,
          state,
          timestamp,
          traceProvider,
          transport
        });
      } catch (error) {
        onError(error);
      } finally {
        callback();
      }
    }
  });

  winstonTransport.log = function log(info, callback) {
    this.write(info);
    if (typeof callback === "function") {
      callback();
    }
  };
  winstonTransport.flush = async () => {
    if (transport && client.pendingEvents() > 0) {
      state.pendingFlush = Promise.resolve(client.flush(transport)).catch((error) => {
        onError(error);
        return null;
      });
    }
    return state.pendingFlush;
  };
  if (typeof config.level === "string" && config.level.trim() !== "") {
    winstonTransport.level = config.level;
  }
  if (config.name !== undefined) {
    winstonTransport.name = String(config.name);
  }
  if (config.silent === true) {
    winstonTransport.silent = true;
  }
  if (config.handleExceptions === true) {
    winstonTransport.handleExceptions = true;
  }
  if (config.handleRejections === true) {
    winstonTransport.handleRejections = true;
  }

  return winstonTransport;
}

function captureWinstonInfo(config) {
  if (config.info?.silent === true) {
    return;
  }
  config.state.captured += 1;
  config.client.log(
    `${config.eventIdPrefix}_${config.state.captured}`,
    timestampFromWinstonInfo(config.info, config.timestamp),
    logAttributesFromWinstonInfo(config.info, {
      includeErrorStack: config.includeErrorStack,
      logger: config.logger,
      metadata: config.metadata,
      trace: traceFromProvider(config.traceProvider, config.onError)
    })
  );
  if (config.flushOnWrite && config.transport) {
    config.state.pendingFlush = Promise.resolve(config.client.flush(config.transport)).catch((error) => {
      config.onError(error);
      return null;
    });
  }
}

function logAttributesFromWinstonInfo(info, options = {}) {
  if (!info || Array.isArray(info) || typeof info !== "object") {
    throw new SdkError("validation_error", "Winston info must be an object");
  }

  const level = logbrewLevelFromWinstonLevel(info.level);
  const metadata = {
    ...compactMetadata(options.metadata),
    winstonLevel: winstonLevelLabel(info.level),
    ...winstonContextMetadata(info),
    ...traceMetadataFromLogContext(options.trace)
  };
  addWinstonErrorMetadata(metadata, info, options.includeErrorStack === true);

  return {
    message: winstonMessage(info),
    level,
    ...(options.logger ? { logger: options.logger } : {}),
    metadata
  };
}

function timestampFromWinstonInfo(info, fallbackTimestamp) {
  const value = info?.timestamp ?? info?.time;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }
  return fallbackTimestamp();
}

function logbrewLevelFromWinstonLevel(level) {
  switch (String(level).toLowerCase()) {
    case "debug":
    case "silly":
      return "info";
    case "warn":
    case "warning":
      return "warning";
    case "error":
      return "error";
    case "crit":
    case "critical":
    case "fatal":
      return "critical";
    case "http":
    case "verbose":
    case "info":
    default:
      return "info";
  }
}

function winstonLevelLabel(level) {
  return typeof level === "string" && level.trim() !== "" ? level : "info";
}

function winstonMessage(info) {
  if (typeof info.message === "string" && info.message.trim() !== "") {
    return info.message;
  }
  const error = info.err ?? info.error;
  if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim() !== "") {
    return error.message;
  }
  return "winston event";
}

function winstonContextMetadata(info) {
  const metadata = {};
  for (const [key, value] of Object.entries(info)) {
    if (!WINSTON_RESERVED_FIELDS.has(key) && isMetadataValue(value)) {
      metadata[`context.${key}`] = value;
    }
  }
  return metadata;
}

function addWinstonErrorMetadata(metadata, info, includeErrorStack) {
  const error = info.err ?? info.error;
  addWinstonNestedErrorMetadata(metadata, error, includeErrorStack);
  if (typeof info.stack === "string" && info.stack.trim() !== "") {
    const firstLine = info.stack.split(/\r?\n/u)[0] ?? "";
    const match = /^([A-Za-z][A-Za-z0-9_.]*(?:Error|Exception)?):\s*(.*)$/u.exec(firstLine);
    if (match && metadata.errorName === undefined) {
      metadata.errorName = match[1];
    }
    if (match && match[2] && metadata.errorMessage === undefined) {
      metadata.errorMessage = match[2];
    }
    if (includeErrorStack) {
      metadata.errorStack = info.stack;
    }
  }
}

function addWinstonNestedErrorMetadata(metadata, error, includeErrorStack) {
  if (!error) {
    return;
  }
  if (error instanceof Error) {
    metadata.errorName = error.name || "Error";
    if (error.message) {
      metadata.errorMessage = error.message;
    }
    if (includeErrorStack && error.stack) {
      metadata.errorStack = error.stack;
    }
    return;
  }
  if (typeof error === "object") {
    const name = error.type ?? error.name;
    const message = error.message;
    const stack = error.stack;
    if (typeof name === "string" && name.trim() !== "") {
      metadata.errorName = name;
    }
    if (typeof message === "string" && message.trim() !== "") {
      metadata.errorMessage = message;
    }
    if (includeErrorStack && typeof stack === "string" && stack.trim() !== "") {
      metadata.errorStack = stack;
    }
    return;
  }
  if (typeof error === "string" && error.trim() !== "") {
    metadata.errorMessage = error;
  }
}

module.exports = {
  createLogBrewWinstonTransport,
  logAttributesFromWinstonInfo
};
