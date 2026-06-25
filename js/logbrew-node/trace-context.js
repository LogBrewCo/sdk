import { createTraceparentHeaders, parseTraceparent } from "@logbrew/sdk";

export function createLogBrewQueueTraceHeaders(trace) {
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

export function resolveOperationTrace(options, activeTrace) {
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

export function normalizeSpanId(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const spanId = value.toLowerCase();
  if (!/^[0-9a-f]{16}$/u.test(spanId) || spanId === "0000000000000000") {
    return undefined;
  }
  return spanId;
}

export function normalizeTraceId(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const traceId = value.toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(traceId) || traceId === "00000000000000000000000000000000") {
    return undefined;
  }
  return traceId;
}
