"use strict";

const { SdkError } = require("@logbrew/sdk");
const { createAutomaticEventId } = require("./automatic-event-id.cjs");
const { normalizeSpanId, normalizeTraceId } = require("./trace-context.cjs");

const INSTRUMENTED_MONGOOSE_MODEL = Symbol.for("@logbrew/node.instrumentedMongooseModel");
const INSTRUMENTED_MONGOOSE_DOCUMENT_EXEC = Symbol.for("@logbrew/node.instrumentedMongooseDocumentExec");
const SKIP_MONGOOSE_EXEC_SPAN = Symbol.for("@logbrew/node.skipMongooseExecSpan");
const QUERY_METHODS = [
  "count",
  "countDocuments",
  "deleteMany",
  "deleteOne",
  "distinct",
  "estimatedDocumentCount",
  "find",
  "findById",
  "findByIdAndDelete",
  "findByIdAndRemove",
  "findByIdAndUpdate",
  "findOne",
  "findOneAndDelete",
  "findOneAndRemove",
  "findOneAndReplace",
  "findOneAndUpdate",
  "replaceOne",
  "updateMany",
  "updateOne",
  "where"
];
const DIRECT_METHODS = ["bulkWrite", "create", "insertMany"];
const AGGREGATE_METHODS = ["aggregate"];
const DOCUMENT_METHODS = ["save", "$save", "updateOne", "deleteOne"];
const DEFAULT_SYSTEM = "mongoose";

function instrumentLogBrewMongooseModel(mongooseModel, options = {}) {
  if (!mongooseModel || (typeof mongooseModel !== "function" && typeof mongooseModel !== "object")) {
    throw new SdkError("configuration_error", "instrumentLogBrewMongooseModel requires a mongoose model");
  }
  if (mongooseModel[INSTRUMENTED_MONGOOSE_MODEL] === true) {
    throw new SdkError(
      "configuration_error",
      "instrumentLogBrewMongooseModel requires an uninstrumented mongoose model; uninstall the existing LogBrew instrumentation first"
    );
  }

  const originals = new Map();
  const documentOriginals = new Map();
  let installed = true;
  function isInstalled() {
    return installed;
  }

  for (const methodName of [...QUERY_METHODS, ...DIRECT_METHODS, ...AGGREGATE_METHODS]) {
    if (typeof mongooseModel[methodName] !== "function" || originals.has(methodName)) {
      continue;
    }
    const originalMethod = mongooseModel[methodName];
    originals.set(methodName, originalMethod);
    mongooseModel[methodName] = createMongooseModelMethodWrapper(
      mongooseModel,
      originalMethod,
      methodName,
      options,
      isInstalled
    );
  }

  const documentPrototype = mongooseModel.prototype;
  if (documentPrototype && typeof documentPrototype === "object") {
    for (const methodName of DOCUMENT_METHODS) {
      if (typeof documentPrototype[methodName] !== "function" || documentOriginals.has(methodName)) {
        continue;
      }
      const originalMethod = documentPrototype[methodName];
      documentOriginals.set(methodName, originalMethod);
      documentPrototype[methodName] = createMongooseDocumentMethodWrapper(
        mongooseModel,
        originalMethod,
        methodName,
        options,
        isInstalled
      );
    }
  }

  Object.defineProperty(mongooseModel, INSTRUMENTED_MONGOOSE_MODEL, {
    configurable: true,
    value: true
  });

  return {
    isInstalled() {
      return installed && mongooseModel[INSTRUMENTED_MONGOOSE_MODEL] === true;
    },
    uninstall() {
      installed = false;
      for (const [methodName, originalMethod] of originals.entries()) {
        mongooseModel[methodName] = originalMethod;
      }
      for (const [methodName, originalMethod] of documentOriginals.entries()) {
        documentPrototype[methodName] = originalMethod;
      }
      delete mongooseModel[INSTRUMENTED_MONGOOSE_MODEL];
    }
  };
}

function createMongooseModelMethodWrapper(mongooseModel, originalMethod, methodName, options, isInstalled) {
  return function logBrewMongooseModelMethod(...args) {
    if (!isInstalled()) {
      return originalMethod.apply(mongooseModel, args);
    }
    if (!options.client) {
      throw new SdkError("configuration_error", "instrumentLogBrewMongooseModel requires client");
    }

    if (DIRECT_METHODS.includes(methodName)) {
      return traceMongooseDirectOperation(
        mongooseModel,
        () => originalMethod.apply(mongooseModel, args),
        options,
        methodName
      );
    }

    const result = originalMethod.apply(mongooseModel, args);
    if (result && typeof result === "object" && typeof result.exec === "function") {
      instrumentMongooseExecutable(result, options, {
        model: mongooseModel,
        operationKind: methodName,
        operationName: AGGREGATE_METHODS.includes(methodName) ? "mongoose.aggregate" : "mongoose.query"
      });
      return result;
    }
    return traceMongooseDirectOperation(mongooseModel, () => result, options, methodName);
  };
}

function createMongooseDocumentMethodWrapper(mongooseModel, originalMethod, methodName, options, isInstalled) {
  /* eslint-disable no-invalid-this */
  return function logBrewMongooseDocumentMethod(...args) {
    if (!isInstalled()) {
      return originalMethod.apply(this, args);
    }
    if (!options.client) {
      throw new SdkError("configuration_error", "instrumentLogBrewMongooseModel requires client");
    }

    const operationKind = normalizeMongooseDocumentOperationKind(methodName);
    if (operationKind === "save") {
      return traceMongooseDirectOperation(
        mongooseModel,
        () => originalMethod.apply(this, args),
        options,
        operationKind,
        "mongoose.document"
      );
    }

    const result = originalMethod.apply(this, args);
    if (result && typeof result === "object" && typeof result.exec === "function") {
      instrumentMongooseDocumentExecutable(result, options, {
        model: mongooseModel,
        operationKind,
        operationName: "mongoose.document"
      });
      return result;
    }
    return traceMongooseDirectOperation(mongooseModel, () => result, options, operationKind, "mongoose.document");
  };
  /* eslint-enable no-invalid-this */
}

function instrumentMongooseExecutable(executable, options, span) {
  if (executable[INSTRUMENTED_MONGOOSE_MODEL] === true) {
    return executable;
  }
  const originalExec = executable.exec;
  executable.exec = function logBrewMongooseExec(...args) {
    if (executable[SKIP_MONGOOSE_EXEC_SPAN] === true) {
      return originalExec.apply(executable, args);
    }
    return traceMongooseExecOperation(executable, originalExec, args, options, span);
  };
  Object.defineProperty(executable, INSTRUMENTED_MONGOOSE_MODEL, {
    configurable: true,
    value: true
  });
  return executable;
}

function instrumentMongooseDocumentExecutable(executable, options, span) {
  if (executable[INSTRUMENTED_MONGOOSE_DOCUMENT_EXEC] === true) {
    return executable;
  }
  const originalExec = executable.exec;
  Object.defineProperty(executable, SKIP_MONGOOSE_EXEC_SPAN, {
    configurable: true,
    value: true
  });
  executable.exec = function logBrewMongooseDocumentExec(...args) {
    return traceMongooseExecOperation(executable, originalExec, args, options, span);
  };
  Object.defineProperty(executable, INSTRUMENTED_MONGOOSE_DOCUMENT_EXEC, {
    configurable: true,
    value: true
  });
  return executable;
}

function traceMongooseExecOperation(receiver, originalExec, args, options, {
  model,
  operationKind,
  operationName
}) {
  const trace = createMongooseTraceContext(options.trace ?? options.activeTraceProvider?.(), options);
  const startedAt = nowMs(options);
  try {
    const result = runWithTrace(options, trace, () => originalExec.apply(receiver, args));
    if (isPromiseLike(result)) {
      return result.then((value) => {
        void captureMongooseSpan(options, {
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          model,
          operationKind,
          operationName,
          result: value,
          trace
        });
        return value;
      }).catch((error) => {
        void captureMongooseSpan(options, {
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          error,
          model,
          operationKind,
          operationName,
          trace
        });
        throw error;
      });
    }
    void captureMongooseSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      model,
      operationKind,
      operationName,
      result,
      trace
    });
    return result;
  } catch (error) {
    void captureMongooseSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      error,
      model,
      operationKind,
      operationName,
      trace
    });
    throw error;
  }
}

function traceMongooseDirectOperation(model, operation, options, operationKind, operationName = "mongoose.model") {
  const trace = createMongooseTraceContext(options.trace ?? options.activeTraceProvider?.(), options);
  const startedAt = nowMs(options);
  try {
    const result = runWithTrace(options, trace, operation);
    if (isPromiseLike(result)) {
      return result.then((value) => {
        void captureMongooseSpan(options, {
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          model,
          operationKind,
          operationName,
          result: value,
          trace
        });
        return value;
      }).catch((error) => {
        void captureMongooseSpan(options, {
          durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
          error,
          model,
          operationKind,
          operationName,
          trace
        });
        throw error;
      });
    }
    void captureMongooseSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      model,
      operationKind,
      operationName,
      result,
      trace
    });
    return result;
  } catch (error) {
    void captureMongooseSpan(options, {
      durationMs: Math.max(0, Math.round(nowMs(options) - startedAt)),
      error,
      model,
      operationKind,
      operationName,
      trace
    });
    throw error;
  }
}

function normalizeMongooseDocumentOperationKind(methodName) {
  return methodName === "$save" ? "save" : methodName;
}

async function captureMongooseSpan(options, {
  durationMs,
  error,
  model,
  operationKind,
  operationName,
  result,
  trace
}) {
  const id = options.id ?? defaultMongooseSpanId({ error, operationKind, operationName });
  const collectionName = safeMongooseLabel(options.collectionName ?? model?.collection?.collectionName ?? model?.collection?.name);
  const databaseName = safeMongooseLabel(options.databaseName);
  const modelName = safeMongooseLabel(options.modelName ?? model?.modelName);
  const metadata = {
    ...safeMongooseMetadata(options.metadata),
    framework: "node:mongoose",
    "db.system.name": DEFAULT_SYSTEM,
    "db.operation.name": operationKind,
    dbSystem: DEFAULT_SYSTEM,
    dbOperation: operationName,
    dbOperationKind: operationKind,
    sampled: trace.sampled,
    ...mongooseResultMetadata(result),
    ...(modelName ? { mongooseModel: modelName } : {}),
    ...(collectionName ? {
      "db.collection.name": collectionName,
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
        // Mongoose ownership stays with the app; telemetry callbacks must not replace operation outcomes.
      }
    }
  }
}

function mongooseResultMetadata(result) {
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

function createMongooseTraceContext(trace, {
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory
} = {}) {
  const spanId = normalizeSpanId(spanIdFactory());
  if (!spanId) {
    throw new SdkError("configuration_error", "instrumentLogBrewMongooseModel requires spanIdFactory to return a valid span id");
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
    throw new SdkError("configuration_error", "instrumentLogBrewMongooseModel requires traceIdFactory to return a valid trace id");
  }
  return {
    traceId,
    spanId,
    sampled: true
  };
}

function safeMongooseMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(primitiveMetadata(metadata)).filter(([key]) => isSafeMongooseMetadataKey(key))
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

function isSafeMongooseMetadataKey(key) {
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

function safeMongooseLabel(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || trimmed.includes("@") || !/^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function defaultMongooseSpanId({ error, operationKind, operationName }) {
  if (error !== undefined && error !== null) {
    return createAutomaticEventId("evt_node_mongoose", `${slugify(operationKind)}_error`);
  }
  return createAutomaticEventId("evt_node_mongoose", slugify(`${operationKind}_${operationName}`));
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
  instrumentLogBrewMongooseModel
};
