const { SdkError } = require("@logbrew/sdk");
const {
  getActiveLogBrewTrace,
  getReactNativeTraceMetadata
} = require("./index.cjs");

const DEFAULT_SCOPE_SOURCE = "react-native.native_bridge";
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
  bridgeSync(nativeBridge)(payload);
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
  try {
    const result = resolvedCallback(payload);
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).finally(() => clearLogBrewNativeBridgeScope(nativeBridge));
    }
    clearLogBrewNativeBridgeScope(nativeBridge);
    return result;
  } catch (error) {
    clearLogBrewNativeBridgeScope(nativeBridge);
    throw error;
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

function bridgeClear(nativeBridge) {
  if (nativeBridge && typeof nativeBridge.clearLogBrewScope === "function") {
    return nativeBridge.clearLogBrewScope.bind(nativeBridge);
  }
  if (nativeBridge && typeof nativeBridge.clearLogBrewTraceContext === "function") {
    return nativeBridge.clearLogBrewTraceContext.bind(nativeBridge);
  }
  if (typeof nativeBridge === "function") {
    return () => nativeBridge(undefined);
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
  withLogBrewNativeBridgeScope
};

module.exports = { ...defaultExport, default: defaultExport };
