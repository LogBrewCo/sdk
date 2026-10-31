"use strict";

const { SdkError } = require("@logbrew/sdk");
const { indexRuntime, isCallable, readField } = require("./instrumentation-values.cjs");

/**
 * @import { Metadata, MetadataValue } from "@logbrew/sdk"
 * @import { TraceInput } from "./instrumentation-values.cjs"
 */

/**
 * @typedef {{
 *   readonly logger?: string | undefined,
 *   readonly metadata?: { readonly [key: string]: unknown } | undefined,
 *   readonly screen?: string | undefined,
 *   readonly sessionId?: string | undefined,
 *   readonly source?: string | undefined,
 *   readonly trace?: TraceInput | null | undefined
 * }} NativeBridgeScopeInput
 * @typedef {{ readonly [key: string]: MetadataValue | undefined }} NativeBridgeTrace
 * @typedef {{ readonly trace: NativeBridgeTrace | undefined, readonly metadata: Readonly<Metadata> }} NativeBridgeScope
 * @typedef {(scope?: NativeBridgeScope) => unknown} NativeBridgeCall
 */

const DEFAULT_SCOPE_SOURCE = "react-native.native_bridge";
const NO_ENTRIES = 0;
const RESERVED_TRACE_METADATA_KEYS = new Set([
  "parentSpanId",
  "spanId",
  "traceFlags",
  "traceId",
  "traceSampled",
  "traceparent"
]);

/**
 * @param {unknown} value
 * @returns {value is MetadataValue}
 */
function isMetadataValue(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null;
}

/**
 * @param {{ readonly [key: string]: unknown }} metadata
 * @returns {Metadata}
 */
function compactScopeMetadata(metadata) {
  /** @type {Metadata} */
  const compacted = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && !RESERVED_TRACE_METADATA_KEYS.has(key) && isMetadataValue(value)) {
      compacted[key] = value;
    }
  }
  return compacted;
}

/**
 * @param {NativeBridgeScopeInput} [input]
 * @returns {NativeBridgeScope}
 */
function createLogBrewNativeBridgeScope({
  logger,
  metadata = {},
  screen,
  sessionId,
  source = DEFAULT_SCOPE_SOURCE,
  trace = indexRuntime.getActiveLogBrewTrace()
} = {}) {
  const traceMetadata = indexRuntime.getReactNativeTraceMetadata(trace);
  return {
    trace: Object.keys(traceMetadata).length === NO_ENTRIES ? undefined : {
      parentSpanId: traceMetadata["parentSpanId"],
      spanId: traceMetadata["spanId"],
      traceFlags: traceMetadata["traceFlags"],
      traceId: traceMetadata["traceId"],
      traceSampled: traceMetadata["traceSampled"]
    },

    metadata: compactScopeMetadata({
      ...metadata,
      logger,
      screen,
      sessionId,
      source
    })
  };
}

/**
 * @param {unknown} nativeBridge
 * @returns {NativeBridgeCall}
 */
function bridgeSetter(nativeBridge) {
  if (isCallable(nativeBridge)) {
    return nativeBridge;
  }
  const setScope = readField(nativeBridge, "setLogBrewScope");
  if (isCallable(setScope)) {
    return setScope.bind(nativeBridge);
  }
  const syncScope = readField(nativeBridge, "syncLogBrewScope");
  if (isCallable(syncScope)) {
    return syncScope.bind(nativeBridge);
  }
  throw new SdkError(
    "configuration_error",
    "LogBrew native bridge scope sync requires a function, setLogBrewScope, or syncLogBrewScope"
  );
}

/**
 * @param {unknown} nativeBridge
 * @param {boolean} required
 * @returns {() => unknown}
 */
function fallbackClear(nativeBridge, required) {
  if (isCallable(nativeBridge)) {
    return () => nativeBridge(undefined);
  }
  if (required) {
    throw new SdkError(
      "configuration_error",
      "async LogBrew native bridge scope requires clearLogBrewScope or clearLogBrewTraceContext"
    );
  }
  return () => undefined;
}

/**
 * @param {unknown} nativeBridge
 * @param {boolean} [required]
 * @returns {() => unknown}
 */
function bridgeClear(nativeBridge, required = false) {
  const clearScope = readField(nativeBridge, "clearLogBrewScope");
  if (isCallable(clearScope)) {
    return clearScope.bind(nativeBridge);
  }
  const clearTraceContext = readField(nativeBridge, "clearLogBrewTraceContext");
  if (isCallable(clearTraceContext)) {
    return clearTraceContext.bind(nativeBridge);
  }
  return fallbackClear(nativeBridge, required);
}

module.exports = { bridgeClear, bridgeSetter, createLogBrewNativeBridgeScope };
