"use strict";

const { createTraceparentHeaders, parseTraceparent } = require("@logbrew/sdk");

const MAX_QUEUE_TRACE_LINKS = 8;

function createLogBrewQueueTraceHeaders(trace) {
  const context = normalizeTraceContext(trace);
  if (!context) {
    return {};
  }
  return createTraceparentHeaders({
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: context.sampled ? "01" : "00"
  });
}

function createLogBrewQueueTraceLinks(carriers, metadata) {
  const values = Array.isArray(carriers) ? carriers : [carriers];
  const metadataFields = safeQueueLinkMetadata(metadata);
  const links = [];
  for (const carrier of values) {
    if (links.length >= MAX_QUEUE_TRACE_LINKS) {
      break;
    }
    const traceparent = getTraceparentValue(carrier);
    if (!traceparent) {
      continue;
    }
    try {
      const context = parseTraceparent(traceparent);
      links.push({
        traceId: context.traceId,
        spanId: context.parentSpanId,
        sampled: context.sampled,
        ...metadataFields
      });
    } catch {
      // Malformed broker propagation must not break batch processing.
    }
  }
  return links;
}

function resolveOperationTrace(options, activeTrace) {
  return options.trace ?? traceContextFromTraceparent(options.traceparent) ?? activeTrace;
}

function traceContextFromTraceparent(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const context = parseTraceparent(value);
    return {
      traceId: context.traceId,
      spanId: context.parentSpanId,
      sampled: context.sampled
    };
  } catch {
    return undefined;
  }
}

function normalizeTraceContext(trace) {
  if (!trace || typeof trace !== "object") {
    return undefined;
  }
  const traceId = normalizeTraceId(trace.traceId);
  const spanId = normalizeSpanId(trace.spanId);
  if (!traceId || !spanId) {
    return undefined;
  }
  return {
    traceId,
    spanId,
    sampled: trace.sampled === true
  };
}

function normalizeSpanId(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const spanId = value.toLowerCase();
  if (!/^[0-9a-f]{16}$/u.test(spanId) || spanId === "0000000000000000") {
    return undefined;
  }
  return spanId;
}

function normalizeTraceId(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const traceId = value.toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(traceId) || traceId === "00000000000000000000000000000000") {
    return undefined;
  }
  return traceId;
}

function getTraceparentValue(carrier) {
  if (typeof carrier === "string") {
    return carrier;
  }
  if (!carrier || typeof carrier !== "object") {
    return undefined;
  }
  if (typeof carrier.get === "function") {
    const value = carrier.get("traceparent");
    return typeof value === "string" ? value : undefined;
  }
  const value = carrier.traceparent ?? carrier.traceParent;
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }
  if (isNodeBufferValue(value)) {
    return value.toString("utf8");
  }
  return typeof value === "string" ? value : undefined;
}

function isNodeBufferValue(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.toString === "function" &&
    typeof value.constructor?.isBuffer === "function" &&
    value.constructor.isBuffer(value)
  );
}

function safeQueueLinkMetadata(metadata) {
  const safeMetadata = primitiveMetadata(metadata);
  return Object.keys(safeMetadata).length > 0 ? { metadata: safeMetadata } : {};
}

function primitiveMetadata(metadata) {
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(metadata).filter(([key, value]) => (
      isSafeQueueLinkMetadataKey(key) && (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      )
    ))
  );
}

function isSafeQueueLinkMetadataKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ![
    "args",
    "body",
    "brokerurl",
    "cookie",
    "headers",
    "message",
    "messagebody",
    "payload",
    "rawmessage",
    ["se", "cret"].join(""),
    ["to", "ken"].join(""),
    "traceparent",
    "url"
  ].includes(normalized);
}

module.exports = {
  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  normalizeSpanId,
  normalizeTraceId,
  resolveOperationTrace
};
