import { SdkError, createTraceparent, parseTraceparent } from "@logbrew/sdk";
import { isFunction, isList, readField, slugify, stringOrUndefined } from "./values.js";

/**
 * @import { Metadata, TraceparentContext } from "@logbrew/sdk"
 * @import { BrowserTraceContext, BrowserTraceContextConfig, BrowserTraceContextSource, BrowserTraceparentConfig } from "./index.js"
 * @typedef {(length: number) => ArrayLike<number>} RandomValues
 * @typedef {{ readonly traceContext?: BrowserTraceContext | undefined }} TraceContextHolder
 * @typedef {{ readonly traceContext?: BrowserTraceContextSource | undefined }} TraceContextOptions
 */

const AUTOMATIC_EVENT_ID_SUFFIX_BYTES = 16;
const MAX_AUTOMATIC_EVENT_ID_LENGTH = 200;
const EVENT_ID_SEPARATORS = 2;
const SPAN_ID_BYTES = 8;
const TRACE_ID_BYTES = 16;
const MIN_BYTE = 0;
const MAX_BYTE = 255;
const HEX_RADIX = 16;
const HEX_DIGITS = 2;
const FIRST_INDEX = 0;
const SAMPLED_FLAGS = "01";
const UNSAMPLED_FLAGS = "00";

/**
 * @param {number} length
 * @returns {ArrayLike<number>}
 */
function defaultRandomValues(length) {
  const { crypto } = globalThis;
  if (!isFunction(readField(crypto, "getRandomValues"))) {
    throw new SdkError("configuration_error", "browser identifiers require crypto.getRandomValues or an explicit randomValues/idFactory");
  }
  return crypto.getRandomValues(new Uint8Array(length));
}


/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isByte(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_BYTE && value <= MAX_BYTE;
}


/**
 * @param {number} length
 * @param {RandomValues} randomValues
 * @returns {string}
 */
function randomHex(length, randomValues) {
  if (!isFunction(randomValues)) {
    throw new SdkError("configuration_error", "randomValues must be a function");
  }
  const bytes = Array.from(randomValues(length), (value) => value);
  if (bytes.length !== length || !bytes.every((value) => isByte(value))) {
    throw new SdkError("configuration_error", "randomValues must return byte values for the requested length");
  }
  return bytes.map((value) => value.toString(HEX_RADIX).padStart(HEX_DIGITS, "0")).join("");
}


/**
 * @param {string} prefix
 * @param {unknown} semanticValue
 * @returns {string}
 */
function createAutomaticBrowserEventId(prefix, semanticValue) {
  const suffix = randomHex(AUTOMATIC_EVENT_ID_SUFFIX_BYTES, defaultRandomValues);
  const maxSemanticLength = MAX_AUTOMATIC_EVENT_ID_LENGTH - prefix.length - suffix.length - EVENT_ID_SEPARATORS;
  const semantic = slugify(semanticValue).slice(FIRST_INDEX, maxSemanticLength) || "event";
  return `${prefix}_${semantic}_${suffix}`;
}


/**
 * @param {Readonly<BrowserTraceparentConfig>} [config]
 * @returns {string}
 */
function createBrowserTraceparent({
  randomValues = defaultRandomValues,
  spanId,
  traceFlags = SAMPLED_FLAGS,
  traceId
} = {}) {
  return createTraceparent({
    spanId: spanId ?? randomHex(SPAN_ID_BYTES, randomValues),
    traceFlags,
    traceId: traceId ?? randomHex(TRACE_ID_BYTES, randomValues)
  });
}


/**
 * @param {Readonly<TraceparentContext>} parsed
 * @returns {BrowserTraceContext}
 */
function browserTraceContextFromParsed(parsed) {
  return {
    sampled: parsed.sampled,
    spanId: parsed.parentSpanId,
    traceFlags: parsed.traceFlags,
    traceId: parsed.traceId
  };
}


/**
 * @param {object} traceContext
 * @returns {string}
 */
function traceFlagsFromFields(traceContext) {
  const traceFlags = readField(traceContext, "traceFlags");
  if (typeof traceFlags === "string") {
    return traceFlags;
  }
  return readField(traceContext, "sampled") === false ? UNSAMPLED_FLAGS : SAMPLED_FLAGS;
}


/**
 * @param {object} traceContext
 * @returns {string}
 */
function traceparentFromFields(traceContext) {
  const traceId = stringOrUndefined(readField(traceContext, "traceId"));
  const spanId = stringOrUndefined(readField(traceContext, "spanId") ?? readField(traceContext, "parentSpanId"));
  if (traceId === undefined || spanId === undefined) {
    throw new SdkError("configuration_error", "traceContext requires traceId and spanId");
  }
  return createTraceparent({ spanId, traceFlags: traceFlagsFromFields(traceContext), traceId });
}


/**
 * @param {unknown} traceContext
 * @returns {BrowserTraceContext}
 */
function normalizeBrowserTraceContext(traceContext) {
  if (typeof traceContext === "string") {
    return browserTraceContextFromParsed(parseTraceparent(traceContext));
  }
  if (traceContext === null || typeof traceContext !== "object" || isList(traceContext)) {
    throw new SdkError("configuration_error", "traceContext must be a traceparent string or trace context object");
  }
  const traceparent = readField(traceContext, "traceparent");
  if (typeof traceparent === "string") {
    return browserTraceContextFromParsed(parseTraceparent(traceparent));
  }
  return browserTraceContextFromParsed(parseTraceparent(traceparentFromFields(traceContext)));
}


/**
 * @param {Readonly<BrowserTraceContextConfig>} [config]
 * @returns {BrowserTraceContext}
 */
function createBrowserTraceContext({
  randomValues = defaultRandomValues,
  sampled,
  spanId,
  traceFlags,
  traceId
} = {}) {
  return normalizeBrowserTraceContext(createBrowserTraceparent({
    randomValues,
    spanId,
    traceFlags: traceFlags ?? (sampled === false ? UNSAMPLED_FLAGS : SAMPLED_FLAGS),
    traceId
  }));
}


/**
 * @param {unknown} traceContext
 * @returns {BrowserTraceContext | undefined}
 */
function optionalBrowserTraceContext(traceContext) {
  if (traceContext === undefined || traceContext === false) {
    return undefined;
  }
  return normalizeBrowserTraceContext(traceContext);
}


/**
 * @param {BrowserTraceContextSource} traceContext
 * @returns {() => BrowserTraceContext | undefined}
 */
function traceContextProvider(traceContext) {
  if (typeof traceContext === "function") {
    return () => optionalBrowserTraceContext(traceContext());
  }
  const fetchTraceContext = optionalBrowserTraceContext(traceContext);
  return () => fetchTraceContext;
}


/**
 * @param {TraceContextHolder} context
 * @param {TraceContextOptions} options
 * @returns {BrowserTraceContext | undefined}
 */
function resolveTraceContext(context, options) {
  if (options.traceContext !== undefined) {
    return typeof options.traceContext === "function"
      ? optionalBrowserTraceContext(options.traceContext())
      : optionalBrowserTraceContext(options.traceContext);
  }
  return context.traceContext;
}


/**
 * @param {Readonly<Record<string, unknown>>} metadata
 * @returns {Metadata}
 */
function compactMetadata(metadata) {
  /** @type {Metadata} */
  const compacted = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      compacted[key] = value;
    }
  }
  return compacted;
}


/**
 * @param {BrowserTraceContext | undefined} traceContext
 * @param {Readonly<{ traceId?: string | undefined }>} [options]
 * @returns {Metadata}
 */
function browserTraceMetadata(traceContext, { traceId } = {}) {
  if (traceContext === undefined && traceId === undefined) {
    return {};
  }
  return compactMetadata({
    spanId: traceContext?.spanId,
    traceId: traceId ?? traceContext?.traceId,
    traceSampled: traceContext?.sampled
  });
}

export {
  browserTraceMetadata,
  createAutomaticBrowserEventId,
  createBrowserTraceContext,
  createBrowserTraceparent,
  defaultRandomValues,
  optionalBrowserTraceContext,
  resolveTraceContext,
  traceContextProvider
};
