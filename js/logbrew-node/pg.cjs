"use strict";

const { SdkError } = require("@logbrew/sdk");
const { normalizeSpanId, normalizeTraceId } = require("./trace-context.cjs");

const INSTRUMENTED_PG_QUERY = Symbol.for("@logbrew/node.instrumentedPgQuery");
const DEFAULT_SYSTEM = "postgresql";

function instrumentLogBrewPgClient(pgClient, options = {}) {
  if (!pgClient || typeof pgClient.query !== "function") {
    throw new SdkError("configuration_error", "instrumentLogBrewPgClient requires a pg client or pool with query");
  }
  const originalQuery = pgClient.query;
  if (originalQuery?.[INSTRUMENTED_PG_QUERY] === true) {
    throw new SdkError(
      "configuration_error",
      "instrumentLogBrewPgClient requires an uninstrumented pg client; uninstall the existing LogBrew instrumentation first"
    );
  }

  let installed = true;
  /* eslint-disable no-invalid-this */
  function logBrewInstrumentedPgQuery(...args) {
    if (!installed) {
      return originalQuery.apply(this, args);
    }
    return tracePgQuery(this, originalQuery, args, options);
  }
  /* eslint-enable no-invalid-this */

  Object.defineProperty(logBrewInstrumentedPgQuery, INSTRUMENTED_PG_QUERY, {
    value: true
  });
  pgClient.query = logBrewInstrumentedPgQuery;

  return {
    isInstalled() {
      return installed && pgClient.query === logBrewInstrumentedPgQuery;
    },
    uninstall() {
      installed = false;
      if (pgClient.query === logBrewInstrumentedPgQuery) {
        pgClient.query = originalQuery;
      }
    }
  };
}

function tracePgQuery(receiver, originalQuery, args, options) {
  if (!options.client) {
    throw new SdkError("configuration_error", "instrumentLogBrewPgClient requires client");
  }

  const query = pgQueryInfo(args);
  const operationKind = normalizePgOperationKind(options.operationKind ?? query.operationKind);
  const operationName = normalizePgOperationName(options.operationName ?? query.name);
  const trace = createPgTraceContext(options.trace ?? options.activeTraceProvider?.(), options);
  const startedAt = nowMs(options);
  const callbackPatch = patchPgCallback(args, trace, options, {
    operationKind,
    operationName,
    startedAt
  });

  try {
    const result = runWithTrace(options, trace, () => originalQuery.apply(receiver, callbackPatch.args));
    if (isPromiseLike(result)) {
      return result.then((value) => {
        void capturePgQuerySpan(options, {
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          operationKind,
          operationName,
          result: value,
          trace
        });
        return value;
      }).catch((error) => {
        void capturePgQuerySpan(options, {
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          error,
          operationKind,
          operationName,
          trace
        });
        throw error;
      });
    }
    return result;
  } catch (error) {
    void capturePgQuerySpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      error,
      operationKind,
      operationName,
      trace
    });
    throw error;
  }
}

function patchPgCallback(args, trace, options, span) {
  const nextArgs = [...args];
  const lastIndex = nextArgs.length - 1;
  if (typeof nextArgs[lastIndex] === "function") {
    const callback = nextArgs[lastIndex];
    nextArgs[lastIndex] = function logBrewPgCallback(error, result, ...rest) {
      void capturePgQuerySpan(options, {
        durationMs: Math.max(0, Math.round(nowMs(options) - span.startedAt)),
        error,
        operationKind: span.operationKind,
        operationName: span.operationName,
        result,
        trace
      });
      return runWithTrace(options, trace, () => callback.call(this, error, result, ...rest));
    };
    return { args: nextArgs };
  }

  if (nextArgs[0] && typeof nextArgs[0] === "object" && typeof nextArgs[0].callback === "function") {
    const queryConfig = { ...nextArgs[0] };
    const callback = queryConfig.callback;
    queryConfig.callback = function logBrewPgConfigCallback(error, result, ...rest) {
      void capturePgQuerySpan(options, {
        durationMs: Math.max(0, Math.round(nowMs(options) - span.startedAt)),
        error,
        operationKind: span.operationKind,
        operationName: span.operationName,
        result,
        trace
      });
      return runWithTrace(options, trace, () => callback.call(this, error, result, ...rest));
    };
    nextArgs[0] = queryConfig;
  }
  return { args: nextArgs };
}

async function capturePgQuerySpan(options, {
  durationMs,
  error,
  operationKind,
  operationName,
  result,
  trace
}) {
  const id = options.id ?? defaultPgSpanId({ error, operationKind, operationName });
  const rowCount = Number(result?.rowCount);
  const metadata = {
    ...safePgMetadata(options.metadata),
    framework: "node:pg",
    "db.system.name": DEFAULT_SYSTEM,
    "db.operation.name": operationKind,
    dbSystem: DEFAULT_SYSTEM,
    dbOperation: operationName,
    dbOperationKind: operationKind,
    sampled: trace.sampled,
    ...(typeof options.databaseName === "string" && options.databaseName.trim() !== "" ? {
      "db.namespace": options.databaseName.trim(),
      dbName: options.databaseName.trim()
    } : {}),
    ...(Number.isFinite(rowCount) ? { rowCount: Math.max(0, Math.trunc(rowCount)) } : {}),
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
        // pg ownership stays with the app; telemetry callbacks must not replace query outcomes.
      }
    }
  }
}

function pgQueryInfo(args) {
  const first = args[0];
  if (typeof first === "string") {
    return {
      name: "pg.query",
      operationKind: parsePgOperationKind(first)
    };
  }
  if (first && typeof first === "object" && typeof first.text === "string") {
    return {
      name: safePgQueryName(first.name) ?? "pg.query",
      operationKind: parsePgOperationKind(first.text)
    };
  }
  return {
    name: "pg.query",
    operationKind: "query"
  };
}

function parsePgOperationKind(text) {
  if (typeof text !== "string") {
    return "query";
  }
  const firstWord = text.trim().split(/\s+/, 1)[0]?.replace(/;+$/g, "");
  return firstWord ? firstWord.toUpperCase().replace(/[^A-Z0-9_.:-]+/g, "_") : "query";
}

function safePgQueryName(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || trimmed.includes("@") || !/^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizePgOperationName(value) {
  return safePgQueryName(value) ?? "pg.query";
}

function normalizePgOperationKind(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return "query";
  }
  const normalized = value.trim().replace(/[^a-z0-9_.:-]+/gi, "_").replace(/^_+|_+$/g, "");
  return normalized.toUpperCase() === normalized ? normalized : normalized.toLowerCase();
}

function createPgTraceContext(trace, {
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory
} = {}) {
  const spanId = normalizeSpanId(spanIdFactory());
  if (!spanId) {
    throw new SdkError("configuration_error", "instrumentLogBrewPgClient requires spanIdFactory to return a valid span id");
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
    throw new SdkError("configuration_error", "instrumentLogBrewPgClient requires traceIdFactory to return a valid trace id");
  }
  return {
    traceId,
    spanId,
    sampled: true
  };
}

function safePgMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(primitiveMetadata(metadata)).filter(([key]) => isSafePgMetadataKey(key))
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

function isSafePgMetadataKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ![
    "authorization",
    "connection",
    "connectionstring",
    "cookie",
    "dbquery",
    "dbquerytext",
    "dbstatement",
    "headers",
    "host",
    "params",
    "parameters",
    ["pass", "word"].join(""),
    "query",
    "rawquery",
    ["se", "cret"].join(""),
    "sql",
    "sqltext",
    "statement",
    ["to", "ken"].join(""),
    "url",
    "user",
    "username"
  ].includes(normalized);
}

function defaultPgSpanId({ error, operationKind, operationName }) {
  if (error !== undefined && error !== null && operationName === "pg.query") {
    return "evt_node_pg_query_error";
  }
  return `evt_node_pg_${slugify(`${operationKind}_${operationName}`)}`;
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
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

module.exports = {
  instrumentLogBrewPgClient
};
