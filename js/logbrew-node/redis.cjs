"use strict";

const { SdkError } = require("@logbrew/sdk");
const { normalizeSpanId, normalizeTraceId } = require("./trace-context.cjs");

const INSTRUMENTED_REDIS_SEND_COMMAND = Symbol.for("@logbrew/node.instrumentedRedisSendCommand");
const INSTRUMENTED_REDIS_CONNECT = Symbol.for("@logbrew/node.instrumentedRedisConnect");
const DEFAULT_SYSTEM = "redis";

function instrumentLogBrewRedisClient(redisClient, options = {}) {
  if (!redisClient || typeof redisClient.sendCommand !== "function") {
    throw new SdkError("configuration_error", "instrumentLogBrewRedisClient requires a redis client with sendCommand");
  }

  const originalSendCommand = redisClient.sendCommand;
  const originalConnect = typeof redisClient.connect === "function" ? redisClient.connect : undefined;
  if (
    originalSendCommand?.[INSTRUMENTED_REDIS_SEND_COMMAND] === true ||
    originalConnect?.[INSTRUMENTED_REDIS_CONNECT] === true
  ) {
    throw new SdkError(
      "configuration_error",
      "instrumentLogBrewRedisClient requires an uninstrumented redis client; uninstall the existing LogBrew instrumentation first"
    );
  }

  let installed = true;
  /* eslint-disable no-invalid-this */
  function logBrewInstrumentedRedisSendCommand(...args) {
    if (!installed) {
      return originalSendCommand.apply(this, args);
    }
    return traceRedisCommand(this, originalSendCommand, args, options);
  }

  function logBrewInstrumentedRedisConnect(...args) {
    if (!installed || !originalConnect) {
      return originalConnect?.apply(this, args);
    }
    return traceRedisConnect(this, originalConnect, args, options);
  }
  /* eslint-enable no-invalid-this */

  Object.defineProperty(logBrewInstrumentedRedisSendCommand, INSTRUMENTED_REDIS_SEND_COMMAND, {
    value: true
  });
  redisClient.sendCommand = logBrewInstrumentedRedisSendCommand;

  if (originalConnect) {
    Object.defineProperty(logBrewInstrumentedRedisConnect, INSTRUMENTED_REDIS_CONNECT, {
      value: true
    });
    redisClient.connect = logBrewInstrumentedRedisConnect;
  }

  return {
    isInstalled() {
      return installed && redisClient.sendCommand === logBrewInstrumentedRedisSendCommand;
    },
    uninstall() {
      installed = false;
      if (redisClient.sendCommand === logBrewInstrumentedRedisSendCommand) {
        redisClient.sendCommand = originalSendCommand;
      }
      if (originalConnect && redisClient.connect === logBrewInstrumentedRedisConnect) {
        redisClient.connect = originalConnect;
      }
    }
  };
}

function traceRedisCommand(receiver, originalSendCommand, args, options) {
  if (!options.client) {
    throw new SdkError("configuration_error", "instrumentLogBrewRedisClient requires client");
  }

  const command = redisCommandInfo(args);
  const operationKind = normalizeRedisOperationKind(options.operationKind ?? command.operationKind);
  const operationName = normalizeRedisOperationName(options.operationName ?? "redis.command");
  const trace = createRedisTraceContext(options.trace ?? options.activeTraceProvider?.(), options);
  const startedAt = nowMs(options);

  try {
    const result = runWithTrace(options, trace, () => originalSendCommand.apply(receiver, args));
    if (isPromiseLike(result)) {
      return result.then((value) => {
        void captureRedisSpan(options, {
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          operationKind,
          operationName,
          result: value,
          trace
        });
        return value;
      }).catch((error) => {
        void captureRedisSpan(options, {
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          error,
          operationKind,
          operationName,
          trace
        });
        throw error;
      });
    }
    void captureRedisSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      operationKind,
      operationName,
      result,
      trace
    });
    return result;
  } catch (error) {
    void captureRedisSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      error,
      operationKind,
      operationName,
      trace
    });
    throw error;
  }
}

function traceRedisConnect(receiver, originalConnect, args, options) {
  if (!options.client) {
    throw new SdkError("configuration_error", "instrumentLogBrewRedisClient requires client");
  }

  const operationKind = "CONNECT";
  const operationName = "redis.connect";
  const trace = createRedisTraceContext(options.trace ?? options.activeTraceProvider?.(), options);
  const startedAt = nowMs(options);

  try {
    const result = runWithTrace(options, trace, () => originalConnect.apply(receiver, args));
    if (isPromiseLike(result)) {
      return result.then((value) => {
        void captureRedisSpan(options, {
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          operationKind,
          operationName,
          result: value,
          trace
        });
        return value;
      }).catch((error) => {
        void captureRedisSpan(options, {
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          error,
          operationKind,
          operationName,
          trace
        });
        throw error;
      });
    }
    void captureRedisSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      operationKind,
      operationName,
      result,
      trace
    });
    return result;
  } catch (error) {
    void captureRedisSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      error,
      operationKind,
      operationName,
      trace
    });
    throw error;
  }
}

async function captureRedisSpan(options, {
  durationMs,
  error,
  operationKind,
  operationName,
  result,
  trace
}) {
  const id = options.id ?? defaultRedisSpanId({ error, operationKind, operationName });
  const metadata = {
    ...safeRedisMetadata(options.metadata),
    framework: "node:redis",
    "db.system.name": DEFAULT_SYSTEM,
    "db.operation.name": operationKind,
    dbSystem: DEFAULT_SYSTEM,
    dbOperation: operationName,
    dbOperationKind: operationKind,
    sampled: trace.sampled,
    ...(typeof options.cacheName === "string" && options.cacheName.trim() !== "" ? {
      "db.namespace": options.cacheName.trim(),
      dbName: options.cacheName.trim()
    } : {}),
    ...cacheResultMetadata(operationKind, result),
    ...(error !== undefined && error !== null ? { errorType: errorType(error) } : {})
  };

  try {
    options.client.span(id, typeof options.now === "function" ? options.now() : new Date().toISOString(), {
      name: `${DEFAULT_SYSTEM} ${operationKind} ${operationName}`,
      traceId: trace.traceId,
      spanId: trace.spanId,
      ...(trace.parentSpanId !== undefined ? { parentSpanId: trace.parentSpanId } : {}),
      status: error !== undefined && error !== null ? "error" : "ok",
      durationMs,
      ...(error !== undefined && error !== null ? { events: exceptionSpanEvents(error) } : {}),
      metadata
    });
  } catch (captureError) {
    if (typeof options.onCaptureError === "function") {
      try {
        await options.onCaptureError(captureError, { client: options.client, error, trace });
      } catch {
        // Redis ownership stays with the app; telemetry callbacks must not replace command outcomes.
      }
    }
  }
}

function redisCommandInfo(args) {
  const first = args[0];
  if (Array.isArray(first)) {
    return { operationKind: redisCommandName(first[0]) };
  }
  if (first && typeof first === "object" && typeof first.name === "string") {
    return { operationKind: redisCommandName(first.name) };
  }
  if (typeof first === "string") {
    return { operationKind: redisCommandName(first) };
  }
  return { operationKind: "COMMAND" };
}

function redisCommandName(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return "COMMAND";
  }
  const normalized = String(value).trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized || normalized.length > 64) {
    return "COMMAND";
  }
  return normalized.toUpperCase();
}

function normalizeRedisOperationName(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return "redis.command";
  }
  const normalized = value.trim().replace(/[^a-z0-9_.:-]+/gi, "_").replace(/^_+|_+$/g, "");
  if (!normalized || normalized.length > 80 || normalized.includes("@")) {
    return "redis.command";
  }
  return normalized;
}

function normalizeRedisOperationKind(value) {
  return redisCommandName(value);
}

function cacheResultMetadata(operationKind, result) {
  if (!isRedisReadOperation(operationKind) || result === undefined) {
    return {};
  }
  return {
    cacheHit: result !== null && result !== undefined
  };
}

function isRedisReadOperation(operationKind) {
  return ["GET", "GETEX", "GETDEL", "GETSET", "MGET", "HGET", "HMGET", "HGETALL", "EXISTS"].includes(operationKind);
}

function createRedisTraceContext(trace, {
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory
} = {}) {
  const spanId = normalizeSpanId(spanIdFactory());
  if (!spanId) {
    throw new SdkError("configuration_error", "instrumentLogBrewRedisClient requires spanIdFactory to return a valid span id");
  }
  if (trace) {
    return {
      traceId: trace.traceId,
      spanId,
      parentSpanId: trace.spanId,
      sampled: trace.sampled
    };
  }

  const traceId = normalizeTraceId(traceIdFactory());
  if (!traceId) {
    throw new SdkError("configuration_error", "instrumentLogBrewRedisClient requires traceIdFactory to return a valid trace id");
  }
  return {
    traceId,
    spanId,
    sampled: true
  };
}

function safeRedisMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(primitiveMetadata(metadata)).filter(([key]) => isSafeRedisMetadataKey(key))
  );
}

function primitiveMetadata(metadata) {
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ))
  );
}

function isSafeRedisMetadataKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ![
    "args",
    "argument",
    "arguments",
    "authorization",
    "command",
    "connection",
    "connectionstring",
    "cookie",
    "dbquery",
    "dbquerytext",
    "dbstatement",
    "endpoint",
    "headers",
    "host",
    "key",
    "params",
    "parameters",
    ["pass", "word"].join(""),
    "query",
    "rawcommand",
    "rawquery",
    ["se", "cret"].join(""),
    "statement",
    ["to", "ken"].join(""),
    "url",
    "user",
    "username",
    "value"
  ].includes(normalized);
}

function defaultRedisSpanId({ error, operationKind, operationName }) {
  if (operationName === "redis.connect") {
    return error !== undefined && error !== null ? "evt_node_redis_connect_error" : "evt_node_redis_connect";
  }
  if (error !== undefined && error !== null) {
    return `evt_node_redis_${slugify(operationKind)}_error`;
  }
  return `evt_node_redis_${slugify(`${operationKind}_${operationName}`)}`;
}

function exceptionSpanEvents(error) {
  return [{ name: "exception", metadata: { exceptionEscaped: true, exceptionType: errorType(error) } }];
}

function runWithTrace(options, trace, callback) {
  if (typeof options.runWithTrace === "function") {
    return options.runWithTrace(trace, callback);
  }
  return callback();
}

function nowMs(options) {
  return typeof options.nowMs === "function" ? options.nowMs() : performance.now();
}

function defaultSpanIdFactory() {
  return randomHex(8);
}

function defaultTraceIdFactory() {
  return randomHex(16);
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex === "0000000000000000" ? "0000000000000001" : hex;
}

function errorType(error) {
  return error instanceof Error && error.name ? error.name : "Error";
}

function isPromiseLike(value) {
  return value !== null && typeof value === "object" && typeof value.then === "function";
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

module.exports = {
  instrumentLogBrewRedisClient
};
