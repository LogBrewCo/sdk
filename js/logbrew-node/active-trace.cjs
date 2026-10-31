"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { SdkError, createTraceparentHeaders, parseTraceparent } = require("@logbrew/sdk");
const { readOptionalMember } = require("./internal.cjs");
const { normalizeSpanId, normalizeTraceId } = require("./trace-context.cjs");

/**
 * @import { TraceparentContext } from "@logbrew/sdk"
 * @import { LogBrewTraceContext } from "./index.cjs"
 */

/**
 * @typedef {"anonymous" | "user"} UserKind
 * @typedef {Readonly<{ id: string, kind: UserKind }>} TraceSubject
 * @typedef {Readonly<{ kind?: unknown, trace?: unknown }>} UserOptions
 * @typedef {Readonly<{ spanIdFactory?: unknown, traceIdFactory?: unknown }>} TraceIdFactories
 * @typedef {Readonly<{
 *   parentSpanId: string | undefined,
 *   sampled: boolean,
 *   spanId: string,
 *   traceId: string
 * }>} TraceMetadata
 * @typedef {Readonly<{ schemaVersion: number, subject?: TraceSubject, trace: TraceMetadata }>} TraceTelemetryContext
 */

const SPAN_ID_BYTES = 8;
const TRACE_ID_BYTES = 16;
const BYTE_RANGE = 256;
const HEX_RADIX = 16;
const HEX_BYTE_LENGTH = 2;
const LAST_CHARACTER = -1;
const FIRST_CHARACTER = 0;
const EMPTY = 0;
const MAX_USER_ID_LENGTH = 200;
const LAST_C0_CONTROL = 31;
const FIRST_C1_CONTROL = 127;
const LAST_C1_CONTROL = 159;
const SCHEMA_VERSION = 1;
const NON_ZERO_PATTERN = /[^0]/u;
/** @type {AsyncLocalStorage<LogBrewTraceContext | undefined>} */
const activeTraceContext = new AsyncLocalStorage();
/** @type {WeakMap<object, TraceSubject>} */
const traceSubjects = new WeakMap();

/**
 * @returns {LogBrewTraceContext | undefined}
 */
function getActiveLogBrewTrace() {
  return activeTraceContext.getStore();
}

/**
 * @template Result
 * @param {LogBrewTraceContext | undefined} trace
 * @param {() => Result} operation
 * @returns {Result}
 */
function runWithLogBrewTrace(trace, operation) {
  return activeTraceContext.run(trace, operation);
}

/**
 * @param {LogBrewTraceContext | undefined} trace
 * @returns {void}
 */
function enterWithLogBrewTrace(trace) {
  activeTraceContext.enterWith(trace);
}

/**
 * @param {string} character
 * @returns {boolean}
 */
function isControlCharacter(character) {
  const code = character.codePointAt(FIRST_CHARACTER) ?? EMPTY;
  return code <= LAST_C0_CONTROL || (code >= FIRST_C1_CONTROL && code <= LAST_C1_CONTROL);
}

/**
 * @param {unknown} id
 * @param {UserOptions} [options]
 * @returns {boolean}
 */
function setLogBrewUser(id, { kind = "user", trace = getActiveLogBrewTrace() } = {}) {
  const normalized = typeof id === "string" ? id.trim() : "";
  const { length } = [...normalized];
  if (length === EMPTY || length > MAX_USER_ID_LENGTH || [...normalized].some((character) => isControlCharacter(character))) {
    throw new SdkError("configuration_error", `LogBrew user id must be 1-${String(MAX_USER_ID_LENGTH)} characters without control characters`);
  }
  if (kind !== "user" && kind !== "anonymous") {
    throw new SdkError("configuration_error", "LogBrew user kind must be user or anonymous");
  }
  if (typeof trace !== "object" || trace === null) {
    return false;
  }
  traceSubjects.set(trace, { id: normalized, kind });
  return true;
}

/**
 * @param {LogBrewTraceContext} trace
 * @returns {TraceMetadata}
 */
function traceMetadata(trace) {
  return {
    parentSpanId: trace.parentSpanId,
    sampled: trace.sampled,
    spanId: trace.spanId,
    traceId: trace.traceId
  };
}

/**
 * @returns {TraceTelemetryContext | undefined}
 */
function activeTraceTelemetryContext() {
  const trace = getActiveLogBrewTrace();
  if (!trace) {
    return undefined;
  }
  const subject = traceSubjects.get(trace);
  return { schemaVersion: SCHEMA_VERSION, trace: traceMetadata(trace), ...(subject === undefined ? {} : { subject }) };
}

/**
 * @param {number} byteLength
 * @returns {Uint8Array}
 */
function randomBytes(byteLength) {
  const bytes = new Uint8Array(byteLength);
  const webCrypto = readOptionalMember(globalThis, "crypto");
  const getRandomValues = readOptionalMember(webCrypto, "getRandomValues");
  if (typeof getRandomValues === "function") {
    Reflect.apply(getRandomValues, webCrypto, [bytes]);
    return bytes;
  }
  for (const index of bytes.keys()) {
    bytes[index] = Math.floor(Math.random() * BYTE_RANGE);
  }
  return bytes;
}

/**
 * @param {number} byteLength
 * @returns {string}
 */
function randomHex(byteLength) {
  const bytes = randomBytes(byteLength);
  const hex = Array.from(bytes, (byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_LENGTH, "0")).join("");
  return NON_ZERO_PATTERN.test(hex) ? hex : `${hex.slice(FIRST_CHARACTER, LAST_CHARACTER)}1`;
}

/**
 * @returns {string}
 */
function defaultSpanIdFactory() {
  return randomHex(SPAN_ID_BYTES);
}

/**
 * @returns {string}
 */
function defaultTraceIdFactory() {
  return randomHex(TRACE_ID_BYTES);
}

/**
 * @param {unknown} factory
 * @param {string} name
 * @returns {unknown}
 */
function callFactory(factory, name) {
  if (typeof factory !== "function") {
    throw new TypeError(`${name} is not a function`);
  }
  /** @type {unknown} */
  const value = Reflect.apply(factory, undefined, []);
  return value;
}

/**
 * @param {unknown} factory
 * @param {() => string} fallback
 * @param {(value: unknown) => string | undefined} normalize
 * @returns {string}
 */
function generatedId(factory, fallback, normalize) {
  try {
    return normalize(callFactory(factory, "factory")) ?? fallback();
  } catch {
    return fallback();
  }
}

/**
 * @param {unknown} traceparent
 * @returns {TraceparentContext | undefined}
 */
function parseOptionalTraceparent(traceparent) {
  if (typeof traceparent !== "string") {
    return undefined;
  }
  try {
    return parseTraceparent(traceparent);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} traceparent
 * @param {TraceIdFactories} [options]
 * @returns {LogBrewTraceContext}
 */
function createLogBrewTraceContext(traceparent, {
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory
} = {}) {
  const spanId = generatedId(spanIdFactory, defaultSpanIdFactory, normalizeSpanId);
  const context = parseOptionalTraceparent(traceparent);
  if (context) {
    return {
      traceId: context.traceId,

      spanId,

      parentSpanId: context.parentSpanId,

      sampled: context.sampled
    };
  }
  return {
    traceId: generatedId(traceIdFactory, defaultTraceIdFactory, normalizeTraceId),

    spanId,

    sampled: true
  };
}

/**
 * @param {string} source
 * @param {LogBrewTraceContext | undefined} trace
 * @param {TraceIdFactories} [options]
 * @returns {LogBrewTraceContext}
 */
function createChildTraceContext(source, trace, {
  spanIdFactory = defaultSpanIdFactory,
  traceIdFactory = defaultTraceIdFactory
} = {}) {
  const spanId = normalizeSpanId(callFactory(spanIdFactory, "spanIdFactory"));
  if (spanId === undefined) {
    throw new SdkError("configuration_error", `${source} requires spanIdFactory to return a valid span id`);
  }
  if (trace) {
    return {
      traceId: trace.traceId,

      spanId,

      parentSpanId: trace.spanId,

      sampled: trace.sampled
    };
  }
  const traceId = normalizeTraceId(callFactory(traceIdFactory, "traceIdFactory"));
  if (traceId === undefined) {
    throw new SdkError("configuration_error", `${source} requires traceIdFactory to return a valid trace id`);
  }
  return {
    traceId,

    spanId,

    sampled: true
  };
}

/**
 * @param {LogBrewTraceContext} trace
 * @returns {string}
 */
function traceparentFor(trace) {
  return createTraceparentHeaders({
    traceId: trace.traceId,

    spanId: trace.spanId,

    traceFlags: trace.sampled ? "01" : "00"
  }).traceparent;
}

module.exports = {
  activeTraceTelemetryContext,
  createChildTraceContext,
  createLogBrewTraceContext,
  defaultSpanIdFactory,
  defaultTraceIdFactory,
  enterWithLogBrewTrace,
  getActiveLogBrewTrace,
  runWithLogBrewTrace,
  setLogBrewUser,
  traceMetadata,
  traceparentFor
};
