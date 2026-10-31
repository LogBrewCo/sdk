const { createTraceparent, parseTraceparent, SdkError } = require("@logbrew/sdk");
const { defaultRandomValues, randomHex } = require("./index-random.cjs");
const { compactMetadata, textOf } = require("./index-values.cjs");

/**
 * @import { Metadata } from "@logbrew/sdk"
 * @import { LooseRecord, TraceContext } from "./index-values.cjs"
 * @typedef {{
 *   readonly randomValues?: unknown,
 *   readonly spanId?: string | undefined,
 *   readonly traceFlags?: string | undefined,
 *   readonly traceId?: string | undefined
 * }} TraceparentConfig
 * @typedef {TraceparentConfig & {
 *   readonly parentSpanId?: string | undefined,
 *   readonly traceparent?: string | null | undefined
 * }} TraceContextConfig
 * @typedef {{
 *   readonly traceId?: unknown,
 *   readonly spanId?: unknown,
 *   readonly parentSpanId?: string | undefined,
 *   readonly traceFlags?: string | undefined,
 *   readonly sampled?: unknown
 * }} TraceObjectInput
 * @typedef {{
 *   readonly parentSpanId: unknown,
 *   readonly sampled: unknown,
 *   readonly spanId: unknown,
 *   readonly traceFlags: unknown,
 *   readonly traceId: unknown
 * }} TraceContextFields
 * @typedef {{
 *   readonly durationMs?: unknown,
 *   readonly metadata?: LooseRecord | undefined,
 *   readonly name?: unknown,
 *   readonly spanId?: unknown,
 *   readonly status?: unknown,
 *   readonly trace?: unknown
 * }} SpanAttributesInput
 * @typedef {{ readonly id: number, readonly trace: TraceContext }} TraceScope
 */

const SPAN_ID_BYTES = 8;
const TRACE_ID_BYTES = 16;
const HEX_RADIX = 16;
const SAMPLED_DIVISOR = 2;
const NOT_SAMPLED = 0;
const NO_SCOPES = 0;
const STEP = 1;
const NOT_FOUND = -1;
const LAST = -1;
/** @type {TraceScope[]} */
const activeTraceScopes = [];
let nextTraceScopeId = 0;

/**
 * @param {TraceContextFields} fields
 * @returns {TraceContext}
 */
function freezeTraceContext({ parentSpanId, sampled, spanId, traceFlags, traceId }) {
  const normalized = {
    traceId: textOf(traceId).toLowerCase(),

    spanId: textOf(spanId).toLowerCase(),

    parentSpanId: parentSpanId === undefined ? undefined : textOf(parentSpanId).toLowerCase(),
    traceFlags: textOf(traceFlags).toLowerCase(),

    sampled: Boolean(sampled)
  };
  return Object.freeze(normalized);
}

/**
 * @param {string} traceFlags
 * @returns {boolean}
 */
function sampledFromTraceFlags(traceFlags) {
  const flags = Number.parseInt(traceFlags, HEX_RADIX);
  return Number.isFinite(flags) && flags % SAMPLED_DIVISOR !== NOT_SAMPLED;
}

/**
 * @param {TraceparentConfig} [config]
 * @returns {string}
 */
function createReactNativeTraceparent({ randomValues = defaultRandomValues, spanId, traceFlags = "01", traceId } = {}) {
  return createTraceparent({
    spanId: spanId ?? randomHex(SPAN_ID_BYTES, randomValues),
    traceFlags,
    traceId: traceId ?? randomHex(TRACE_ID_BYTES, randomValues)
  });
}

/**
 * @param {string} traceparent
 * @param {string | undefined} spanId
 * @param {unknown} randomValues
 * @returns {TraceContext | undefined}
 */
function traceContextFromTraceparent(traceparent, spanId, randomValues) {
  try {
    const parsed = parseTraceparent(traceparent);
    const localSpanId = spanId ?? randomHex(SPAN_ID_BYTES, randomValues);
    createTraceparent({ spanId: localSpanId, traceFlags: parsed.traceFlags, traceId: parsed.traceId });
    return freezeTraceContext({
      parentSpanId: parsed.parentSpanId,
      sampled: parsed.sampled,
      spanId: localSpanId,
      traceFlags: parsed.traceFlags,
      traceId: parsed.traceId
    });
  } catch {
    return undefined;
  }
}

/**
 * @param {TraceContextConfig} [config]
 * @returns {TraceContext}
 */
function createReactNativeTraceContext({
  parentSpanId, randomValues = defaultRandomValues, spanId, traceFlags = "01", traceId, traceparent
} = {}) {
  if (traceparent !== undefined && traceparent !== null && textOf(traceparent).trim() !== "") {
    const propagated = traceContextFromTraceparent(traceparent, spanId, randomValues);
    if (propagated) {
      return propagated;
    }
  }
  const localTraceId = traceId ?? randomHex(TRACE_ID_BYTES, randomValues);
  const localSpanId = spanId ?? randomHex(SPAN_ID_BYTES, randomValues);
  createTraceparent({ spanId: localSpanId, traceFlags, traceId: localTraceId });
  if (parentSpanId !== undefined) {
    createTraceparent({ spanId: parentSpanId, traceFlags, traceId: localTraceId });
  }
  return freezeTraceContext({
    parentSpanId,
    sampled: sampledFromTraceFlags(traceFlags),
    spanId: localSpanId,
    traceFlags,
    traceId: localTraceId
  });
}

/**
 * @param {unknown} value
 * @returns {value is TraceObjectInput}
 */
function isTraceObject(value) {
  return typeof value === "object";
}

/**
 * @param {TraceObjectInput} trace
 * @returns {TraceContext}
 */
function resolveTraceObject(trace) {
  const { parentSpanId, sampled, spanId, traceFlags = "01", traceId } = trace;
  if (typeof traceId !== "string" || typeof spanId !== "string") {
    throw new SdkError("validation_error", "trace context requires traceId and spanId");
  }
  createTraceparent({ spanId, traceFlags, traceId });
  if (parentSpanId !== undefined) {
    createTraceparent({ spanId: parentSpanId, traceFlags, traceId });
  }
  return freezeTraceContext({
    parentSpanId,
    sampled: sampled ?? sampledFromTraceFlags(traceFlags),
    spanId,
    traceFlags,
    traceId
  });
}

/**
 * @param {unknown} trace
 * @returns {TraceContext | undefined}
 */
function resolveTraceContext(trace) {
  if (trace === undefined || trace === null) {
    return undefined;
  }
  if (typeof trace === "string") {
    return createReactNativeTraceContext({ traceparent: trace });
  }
  if (!isTraceObject(trace)) {
    throw new SdkError("validation_error", "trace must be a trace context or traceparent string");
  }
  return resolveTraceObject(trace);
}

/**
 * @returns {TraceContext | undefined}
 */
function getActiveLogBrewTrace() {
  return activeTraceScopes.length === NO_SCOPES ? undefined : activeTraceScopes.at(LAST)?.trace;
}

/**
 * @param {number} scopeId
 * @returns {void}
 */
function removeActiveTraceScope(scopeId) {
  const index = activeTraceScopes.findIndex(scope => scope.id === scopeId);
  if (index !== NOT_FOUND) {
    activeTraceScopes.splice(index, STEP);
  }
}

/**
 * @param {unknown} value
 * @returns {value is (...args: readonly unknown[]) => unknown}
 */
function isCallable(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} trace
 * @param {unknown} scopedFunction
 * @returns {unknown}
 */
function withLogBrewTrace(trace, scopedFunction) {
  if (!isCallable(scopedFunction)) {
    throw new SdkError("configuration_error", "withLogBrewTrace requires a callback");
  }
  const context = resolveTraceContext(trace) ?? createReactNativeTraceContext();
  nextTraceScopeId += STEP;
  const scope = {
    id: nextTraceScopeId,
    trace: context
  };
  activeTraceScopes.push(scope);
  try {
    return scopedFunction(context);
  } finally {
    removeActiveTraceScope(scope.id);
  }
}

/**
 * @param {unknown} trace
 * @param {unknown} scopedFunction
 * @returns {(...args: readonly unknown[]) => unknown}
 */
function bindLogBrewTrace(trace, scopedFunction) {
  if (!isCallable(scopedFunction)) {
    throw new SdkError("configuration_error", "bindLogBrewTrace requires a callback");
  }
  const context = resolveTraceContext(trace) ?? createReactNativeTraceContext();
  const target = scopedFunction;
  /**
   * @param {readonly unknown[]} args
   * @returns {unknown}
   */
  function logBrewTracedCallback(...args) {
    return withLogBrewTrace(context, () => target(...args));
  }
  return logBrewTracedCallback;
}

/**
 * @param {unknown} [trace]
 * @returns {Metadata}
 */
function getReactNativeTraceMetadata(trace = getActiveLogBrewTrace()) {
  const context = resolveTraceContext(trace);
  if (!context) {
    return {};
  }
  return compactMetadata({
    parentSpanId: context.parentSpanId,
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    traceId: context.traceId,
    traceSampled: context.sampled
  });
}

/**
 * @param {SpanAttributesInput} [input]
 * @returns {Record<string, unknown>}
 */
function createReactNativeSpanAttributes({
  durationMs,
  metadata = {},
  name,
  spanId,
  status = "ok",
  trace = getActiveLogBrewTrace()
} = {}) {
  const context = resolveTraceContext(trace) ?? createReactNativeTraceContext();
  return {
    name,
    traceId: context.traceId,

    spanId: spanId ?? context.spanId,
    status,

    durationMs,
    metadata: compactMetadata({
      ...metadata,
      ...getReactNativeTraceMetadata(context)
    })
  };
}

/**
 * @param {unknown} [trace]
 * @returns {{ traceparent: string }}
 */
function createReactNativeTraceHeaders(trace = getActiveLogBrewTrace()) {
  const context = resolveTraceContext(trace) ?? createReactNativeTraceContext();
  return {
    traceparent: createTraceparent({
      traceFlags: context.traceFlags,
      traceId: context.traceId,

      spanId: context.spanId
    })
  };
}

module.exports = {
  bindLogBrewTrace,
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  createReactNativeTraceHeaders,
  createReactNativeTraceparent,
  getActiveLogBrewTrace,
  getReactNativeTraceMetadata,
  resolveTraceContext,
  withLogBrewTrace
};
