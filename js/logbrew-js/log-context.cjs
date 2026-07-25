const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

function buildLogContextHelpers({ SdkError }) {
  function compactMetadata(metadata) {
    if (metadata === undefined) {
      return {};
    }
    if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
      throw new SdkError("validation_error", "metadata must be an object");
    }
    const safeMetadata = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (isMetadataValue(value)) {
        safeMetadata[key] = value;
      }
    }
    return safeMetadata;
  }

  function traceFromProvider(provider, onError) {
    if (!provider) {
      return undefined;
    }
    try {
      return provider();
    } catch (error) {
      onError(error);
      return undefined;
    }
  }

  return {
    compactMetadata,
    isMetadataValue,
    normalizeLogTraceContext,
    traceFromProvider,
    traceMetadataFromLogContext
  };
}

function isMetadataValue(value) {
  return (
    value === null
    || typeof value === "string"
    || typeof value === "number" && Number.isFinite(value)
    || typeof value === "boolean"
  );
}

function traceMetadataFromLogContext(trace) {
  const normalized = normalizeLogTraceContext(trace);
  if (!normalized) {
    return {};
  }
  return {
    traceId: normalized.traceId,
    spanId: normalized.spanId,
    ...(normalized.parentSpanId !== undefined ? { parentSpanId: normalized.parentSpanId } : {}),
    ...(normalized.sampled !== undefined ? { sampled: normalized.sampled } : {})
  };
}

function normalizeLogTraceContext(trace) {
  if (!trace || Array.isArray(trace) || typeof trace !== "object") {
    return undefined;
  }
  const traceId = normalizeHexId(trace.traceId, 32, ZERO_TRACE_ID);
  const spanId = normalizeHexId(trace.spanId, 16, ZERO_SPAN_ID);
  if (!traceId || !spanId) {
    return undefined;
  }
  const parentSpanId = normalizeHexId(trace.parentSpanId, 16, ZERO_SPAN_ID);
  return {
    traceId,
    spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    ...(typeof trace.sampled === "boolean" ? { sampled: trace.sampled } : {})
  };
}

function normalizeHexId(value, length, zeroValue) {
  if (typeof value !== "string") {
    return undefined;
  }
  const pattern = length === 32
    ? /^[0-9a-fA-F]{32}$/u
    : /^[0-9a-fA-F]{16}$/u;
  if (!pattern.test(value) || value.toLowerCase() === zeroValue) {
    return undefined;
  }
  return value.toLowerCase();
}

module.exports = { buildLogContextHelpers };
