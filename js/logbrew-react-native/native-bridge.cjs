const { SdkError } = require("@logbrew/sdk");
const {
  getActiveLogBrewTrace,
  getReactNativeTraceMetadata
} = require("./index.cjs");

const DEFAULT_SCOPE_SOURCE = "react-native.native_bridge";
const ASYNC_BRIDGE_QUEUES = new WeakMap();
const MAX_PENDING_ASYNC_SCOPES = 128;
const MAX_ASYNC_SCOPE_METADATA_ENTRIES = 64;
const MAX_ASYNC_SCOPE_JSON_LENGTH = 8192;
const RESERVED_TRACE_METADATA_KEYS = new Set([
  "parentSpanId",
  "spanId",
  "traceFlags",
  "traceId",
  "traceSampled",
  "traceparent"
]);

function createLogBrewNativeBridgeScope({
  logger,
  metadata = {},
  screen,
  sessionId,
  source = DEFAULT_SCOPE_SOURCE,
  trace = getActiveLogBrewTrace()
} = {}) {
  const traceMetadata = getReactNativeTraceMetadata(trace);
  return {
    trace: Object.keys(traceMetadata).length === 0 ? undefined : {
      parentSpanId: traceMetadata.parentSpanId,
      spanId: traceMetadata.spanId,
      traceFlags: traceMetadata.traceFlags,
      traceId: traceMetadata.traceId,
      traceSampled: traceMetadata.traceSampled
    },
    metadata: compactMetadata({
      ...metadata,
      logger,
      screen,
      sessionId,
      source
    })
  };
}

function syncLogBrewNativeBridgeScope(nativeBridge, options = {}) {
  const payload = createLogBrewNativeBridgeScope(options);
  const sync = bridgeSync(nativeBridge);
  try {
    sync(payload);
  } catch (error) {
    clearPreservingFailure(nativeBridge);
    throw error;
  }
  return payload;
}

function clearLogBrewNativeBridgeScope(nativeBridge) {
  bridgeClear(nativeBridge)();
}

function withLogBrewNativeBridgeScope(nativeBridge, options, callback) {
  const resolvedOptions = typeof options === "function" ? {} : options ?? {};
  const resolvedCallback = typeof options === "function" ? options : callback;
  if (typeof resolvedCallback !== "function") {
    throw new SdkError("configuration_error", "withLogBrewNativeBridgeScope requires a callback");
  }

  const payload = syncLogBrewNativeBridgeScope(nativeBridge, resolvedOptions);
  let result;
  try {
    result = resolvedCallback(payload);
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).then(
        (value) => {
          clearLogBrewNativeBridgeScope(nativeBridge);
          return value;
        },
        (error) => {
          clearPreservingFailure(nativeBridge);
          throw error;
        }
      );
    }
  } catch (error) {
    clearPreservingFailure(nativeBridge);
    throw error;
  }
  clearLogBrewNativeBridgeScope(nativeBridge);
  return result;
}

async function withLogBrewNativeBridgeScopeAsync(nativeBridge, options, callback) {
  const resolvedOptions = typeof options === "function" ? {} : options ?? {};
  const resolvedCallback = typeof options === "function" ? options : callback;
  if (typeof resolvedCallback !== "function") {
    throw new SdkError("configuration_error", "withLogBrewNativeBridgeScopeAsync requires a callback");
  }
  if (nativeBridge === null || (typeof nativeBridge !== "object" && typeof nativeBridge !== "function")) {
    throw new SdkError("configuration_error", "async native bridge scope requires an adapter object or function");
  }
  const queue = ASYNC_BRIDGE_QUEUES.get(nativeBridge) ?? { pending: 0, tail: Promise.resolve() };
  if (queue.pending >= MAX_PENDING_ASYNC_SCOPES) {
    throw new SdkError("native_scope_queue_full", "async native bridge scope queue is full");
  }
  queue.pending += 1;
  ASYNC_BRIDGE_QUEUES.set(nativeBridge, queue);
  let sync;
  let clear;
  let payload;
  try {
    sync = bridgeSync(nativeBridge);
    clear = bridgeClear(nativeBridge, true);
    payload = createLogBrewNativeBridgeScope(resolvedOptions);
    if (Object.keys(payload.metadata).length > MAX_ASYNC_SCOPE_METADATA_ENTRIES
      || JSON.stringify(payload).length > MAX_ASYNC_SCOPE_JSON_LENGTH) {
      throw new SdkError("native_scope_too_large", "async native bridge scope exceeds its payload limit");
    }
  } catch (error) {
    releaseAsyncScopeReservation(nativeBridge, queue);
    throw error;
  }
  return runQueuedNativeBridgeScope(nativeBridge, queue, sync, clear, payload, resolvedCallback);
}

async function runQueuedNativeBridgeScope(nativeBridge, queue, sync, clear, payload, callback) {
  const previous = queue.tail;
  let release;
  const completion = new Promise((resolve) => { release = resolve; });
  const turn = previous.then(() => completion);
  queue.tail = turn;
  await previous;
  try {
    await clear();
    let result;
    try {
      await sync(payload);
      result = await callback(payload);
    } catch (error) {
      try {
        await clear();
      } catch {
        // Preserve the setter or callback failure after attempting scope clear.
      }
      throw error;
    }
    await clear();
    return result;
  } finally {
    release();
    releaseAsyncScopeReservation(nativeBridge, queue);
  }
}

function releaseAsyncScopeReservation(nativeBridge, queue) {
  queue.pending -= 1;
  if (queue.pending === 0) {
    ASYNC_BRIDGE_QUEUES.delete(nativeBridge);
  }
}

function clearPreservingFailure(nativeBridge) {
  try {
    clearLogBrewNativeBridgeScope(nativeBridge);
  } catch {
    // Keep the original failure when clearing the scope also fails.
  }
}

function bridgeSync(nativeBridge) {
  if (typeof nativeBridge === "function") {
    return nativeBridge;
  }
  if (nativeBridge && typeof nativeBridge.setLogBrewScope === "function") {
    return nativeBridge.setLogBrewScope.bind(nativeBridge);
  }
  if (nativeBridge && typeof nativeBridge.syncLogBrewScope === "function") {
    return nativeBridge.syncLogBrewScope.bind(nativeBridge);
  }
  throw new SdkError(
    "configuration_error",
    "LogBrew native bridge scope sync requires a function, setLogBrewScope, or syncLogBrewScope"
  );
}

function bridgeClear(nativeBridge, required = false) {
  if (nativeBridge && typeof nativeBridge.clearLogBrewScope === "function") {
    return nativeBridge.clearLogBrewScope.bind(nativeBridge);
  }
  if (nativeBridge && typeof nativeBridge.clearLogBrewTraceContext === "function") {
    return nativeBridge.clearLogBrewTraceContext.bind(nativeBridge);
  }
  if (typeof nativeBridge === "function") {
    return () => nativeBridge(undefined);
  }
  if (required) {
    throw new SdkError(
      "configuration_error",
      "async LogBrew native bridge scope requires clearLogBrewScope or clearLogBrewTraceContext"
    );
  }
  return () => {};
}

function compactMetadata(metadata) {
  const compacted = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) {
      continue;
    }
    if (RESERVED_TRACE_METADATA_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      compacted[key] = value;
    }
  }
  return compacted;
}

const defaultExport = {
  clearLogBrewNativeBridgeScope,
  createLogBrewNativeBridgeScope,
  syncLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScopeAsync
};

module.exports = { ...defaultExport, default: defaultExport };
