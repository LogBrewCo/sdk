"use strict";

const { SdkError } = require("@logbrew/sdk");
const { normalizeSpanId, normalizeTraceId } = require("./trace-context.cjs");

const INSTRUMENTED_MONGO_COLLECTION = Symbol.for("@logbrew/node.instrumentedMongoCollection");
const INSTRUMENTED_MONGO_CURSOR = Symbol.for("@logbrew/node.instrumentedMongoCursor");
const COLLECTION_METHODS = [
  "aggregate",
  "bulkWrite",
  "count",
  "countDocuments",
  "deleteMany",
  "deleteOne",
  "distinct",
  "estimatedDocumentCount",
  "find",
  "findOne",
  "findOneAndDelete",
  "findOneAndReplace",
  "findOneAndUpdate",
  "insertMany",
  "insertOne",
  "replaceOne",
  "updateMany",
  "updateOne"
];
const CURSOR_METHODS = ["forEach", "hasNext", "next", "toArray", "tryNext"];
const DEFAULT_SYSTEM = "mongodb";

function instrumentLogBrewMongoCollection(mongoCollection, options = {}) {
  if (!mongoCollection || typeof mongoCollection !== "object") {
    throw new SdkError("configuration_error", "instrumentLogBrewMongoCollection requires a mongo collection object");
  }
  if (mongoCollection[INSTRUMENTED_MONGO_COLLECTION] === true) {
    throw new SdkError(
      "configuration_error",
      "instrumentLogBrewMongoCollection requires an uninstrumented mongo collection; uninstall the existing LogBrew instrumentation first"
    );
  }

  const originals = new Map();
  let installed = true;
  function isInstalled() {
    return installed;
  }

  for (const methodName of COLLECTION_METHODS) {
    if (typeof mongoCollection[methodName] !== "function") {
      continue;
    }
    const originalMethod = mongoCollection[methodName];
    originals.set(methodName, originalMethod);
    mongoCollection[methodName] = createMongoCollectionMethodWrapper(
      mongoCollection,
      originalMethod,
      methodName,
      options,
      isInstalled
    );
  }

  Object.defineProperty(mongoCollection, INSTRUMENTED_MONGO_COLLECTION, {
    configurable: true,
    value: true
  });

  return {
    isInstalled() {
      return installed && mongoCollection[INSTRUMENTED_MONGO_COLLECTION] === true;
    },
    uninstall() {
      installed = false;
      for (const [methodName, originalMethod] of originals.entries()) {
        mongoCollection[methodName] = originalMethod;
      }
      delete mongoCollection[INSTRUMENTED_MONGO_COLLECTION];
    }
  };
}

function createMongoCollectionMethodWrapper(mongoCollection, originalMethod, methodName, options, isInstalled) {
  return (...args) => {
    if (!isInstalled()) {
      return originalMethod.apply(mongoCollection, args);
    }
    if (methodName === "find" || methodName === "aggregate") {
      return traceMongoCursorFactory(mongoCollection, originalMethod, args, options, methodName);
    }
    return traceMongoCollectionOperation(mongoCollection, originalMethod, args, options, methodName);
  };
}

function traceMongoCollectionOperation(receiver, originalMethod, args, options, operationKind) {
  if (!options.client) {
    throw new SdkError("configuration_error", "instrumentLogBrewMongoCollection requires client");
  }

  const trace = createMongoTraceContext(options.trace ?? options.activeTraceProvider?.(), options);
  const startedAt = nowMs(options);

  try {
    const result = runWithTrace(options, trace, () => originalMethod.apply(receiver, args));
    if (isPromiseLike(result)) {
      return result.then((value) => {
        void captureMongoSpan(options, {
          collection: receiver,
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          operationKind,
          operationName: "mongodb.collection",
          result: value,
          trace
        });
        return value;
      }).catch((error) => {
        void captureMongoSpan(options, {
          collection: receiver,
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          error,
          operationKind,
          operationName: "mongodb.collection",
          trace
        });
        throw error;
      });
    }
    void captureMongoSpan(options, {
      collection: receiver,
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      operationKind,
      operationName: "mongodb.collection",
      result,
      trace
    });
    return result;
  } catch (error) {
    void captureMongoSpan(options, {
      collection: receiver,
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      error,
      operationKind,
      operationName: "mongodb.collection",
      trace
    });
    throw error;
  }
}

function traceMongoCursorFactory(receiver, originalMethod, args, options, operationKind) {
  if (!options.client) {
    throw new SdkError("configuration_error", "instrumentLogBrewMongoCollection requires client");
  }

  const parentTrace = options.trace ?? options.activeTraceProvider?.();
  try {
    const cursor = originalMethod.apply(receiver, args);
    if (cursor && typeof cursor === "object") {
      instrumentMongoCursor(cursor, options, {
        collection: receiver,
        operationKind,
        parentTrace
      });
    }
    return cursor;
  } catch (error) {
    const trace = createMongoTraceContext(options.trace ?? options.activeTraceProvider?.(), options);
    void captureMongoSpan(options, {
      collection: receiver,
      durationMs: 0,
      error,
      operationKind,
      operationName: "mongodb.collection",
      trace
    });
    throw error;
  }
}

function instrumentMongoCursor(cursor, options, { collection, operationKind, parentTrace }) {
  if (cursor[INSTRUMENTED_MONGO_CURSOR] === true) {
    return cursor;
  }

  for (const methodName of CURSOR_METHODS) {
    if (typeof cursor[methodName] !== "function") {
      continue;
    }
    const originalMethod = cursor[methodName];
    cursor[methodName] = createMongoCursorMethodWrapper(cursor, originalMethod, options, {
      collection,
      cursorMethod: methodName,
      operationKind,
      parentTrace
    });
  }

  Object.defineProperty(cursor, INSTRUMENTED_MONGO_CURSOR, {
    configurable: true,
    value: true
  });
  return cursor;
}

function createMongoCursorMethodWrapper(cursor, originalMethod, options, span) {
  return (...args) => traceMongoCursorOperation(cursor, originalMethod, args, options, span);
}

function traceMongoCursorOperation(receiver, originalMethod, args, options, {
  collection,
  cursorMethod,
  operationKind,
  parentTrace
}) {
  const trace = createMongoTraceContext(parentTrace ?? options.trace ?? options.activeTraceProvider?.(), options);
  const startedAt = nowMs(options);

  try {
    const result = runWithTrace(options, trace, () => originalMethod.apply(receiver, args));
    if (isPromiseLike(result)) {
      return result.then((value) => {
        void captureMongoSpan(options, {
          collection,
          cursorMethod,
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          operationKind,
          operationName: "mongodb.cursor",
          result: value,
          trace
        });
        return value;
      }).catch((error) => {
        void captureMongoSpan(options, {
          collection,
          cursorMethod,
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          error,
          operationKind,
          operationName: "mongodb.cursor",
          trace
        });
        throw error;
      });
    }
    void captureMongoSpan(options, {
      collection,
      cursorMethod,
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      operationKind,
      operationName: "mongodb.cursor",
      result,
      trace
    });
    return result;
  } catch (error) {
    void captureMongoSpan(options, {
      collection,
      cursorMethod,
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      error,
      operationKind,
      operationName: "mongodb.cursor",
      trace
    });
    throw error;
  }
}

async function captureMongoSpan(options, {
  collection,
  cursorMethod,
  durationMs,
  error,
  operationKind,
  operationName,
  result,
  trace
}) {
  const id = options.id ?? defaultMongoSpanId({ cursorMethod, error, operationKind, operationName });
  const collectionName = safeMongoLabel(options.collectionName ?? collection?.collectionName);
  const databaseName = safeMongoLabel(options.databaseName);
  const metadata = {
    ...safeMongoMetadata(options.metadata),
    framework: "node:mongodb",
    "db.system.name": DEFAULT_SYSTEM,
    "db.operation.name": operationKind,
    dbSystem: DEFAULT_SYSTEM,
    dbOperation: operationName,
    dbOperationKind: operationKind,
    sampled: trace.sampled,
    ...mongoResultMetadata(result),
    ...(collectionName ? {
      "db.collection.name": collectionName,
      "db.mongodb.collection": collectionName,
      dbCollection: collectionName
    } : {}),
    ...(databaseName ? {
      "db.namespace": databaseName,
      dbName: databaseName
    } : {}),
    ...(error !== undefined && error !== null ? { errorType: errorType(error) } : {})
  };

  try {
    options.client.span(id, typeof options.now === "function" ? options.now() : new Date().toISOString(), {
      name: `${DEFAULT_SYSTEM} ${operationKind} ${operationName}${cursorMethod ? `.${cursorMethod}` : ""}`,
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
        // MongoDB ownership stays with the app; telemetry callbacks must not replace operation outcomes.
      }
    }
  }
}

function mongoResultMetadata(result) {
  if (Array.isArray(result)) {
    return { resultCount: safeNonNegativeInteger(result.length) };
  }
  if (!result || typeof result !== "object") {
    return {};
  }
  for (const key of ["deletedCount", "insertedCount", "matchedCount", "modifiedCount", "upsertedCount"]) {
    const count = safeNonNegativeInteger(result[key]);
    if (count !== undefined) {
      return { resultCount: count };
    }
  }
  return {};
}

function safeNonNegativeInteger(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : undefined;
}

function createMongoTraceContext(trace, {
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory
} = {}) {
  const spanId = normalizeSpanId(spanIdFactory());
  if (!spanId) {
    throw new SdkError("configuration_error", "instrumentLogBrewMongoCollection requires spanIdFactory to return a valid span id");
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
    throw new SdkError("configuration_error", "instrumentLogBrewMongoCollection requires traceIdFactory to return a valid trace id");
  }
  return {
    traceId,
    spanId,
    sampled: true
  };
}

function safeMongoMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(primitiveMetadata(metadata)).filter(([key]) => isSafeMongoMetadataKey(key))
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

function isSafeMongoMetadataKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ![
    "args",
    "argument",
    "arguments",
    "authorization",
    "connection",
    "connectionstring",
    "cookie",
    "dbquery",
    "dbquerytext",
    "dbstatement",
    "document",
    "documents",
    "endpoint",
    "filter",
    "headers",
    "host",
    "key",
    "pipeline",
    "params",
    "parameters",
    ["pass", "word"].join(""),
    "query",
    "rawcommand",
    "rawquery",
    ["se", "cret"].join(""),
    "statement",
    ["to", "ken"].join(""),
    "update",
    "url",
    "user",
    "username",
    "value"
  ].includes(normalized);
}

function safeMongoLabel(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || trimmed.includes("@") || !/^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function defaultMongoSpanId({ cursorMethod, error, operationKind, operationName }) {
  if (error !== undefined && error !== null) {
    return `evt_node_mongodb_${slugify(operationKind)}_error`;
  }
  if (operationName === "mongodb.cursor") {
    return `evt_node_mongodb_${slugify(`${operationKind}_${cursorMethod ?? "cursor"}_${operationName}`)}`;
  }
  return `evt_node_mongodb_${slugify(`${operationKind}_${operationName}`)}`;
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
  instrumentLogBrewMongoCollection
};
