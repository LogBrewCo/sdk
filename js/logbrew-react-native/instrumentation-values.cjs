"use strict";

/**
 * @import { LogBrewClient, Metadata, MetadataValue, SpanAttributes } from "@logbrew/sdk"
 * @import {
 *   ReactNativeSpanEvent,
 *   ReactNativeTraceContext,
 *   TracePropagationTarget
 * } from "./index.cjs"
 */

/**
 * @typedef {(...args: readonly unknown[]) => unknown} Callable
 * @typedef {{ readonly [key: string]: MetadataValue | undefined }} LooseMetadata
 * @typedef {{ readonly [key: string]: unknown }} UnknownRecord
 * @typedef {{
 *   readonly OS?: string | undefined,
 *   readonly Version?: string | number | undefined,
 *   readonly isPad?: boolean | undefined,
 *   readonly constants?: { readonly isTesting?: boolean | undefined, readonly [key: string]: unknown } | undefined
 * }} PlatformInput
 * @typedef {{
 *   readonly currentState?: string | null | undefined,
 *   readonly addEventListener?: ((type: "change", listener: (state: string) => void) => unknown) | undefined
 * }} AppStateInput
 * @typedef {Readonly<ReactNativeTraceContext> | string} TraceInput
 * @typedef {(length: number) => ArrayLike<number>} RandomValues
 * @typedef {{
 *   readonly appState?: AppStateInput | undefined,
 *   readonly durationMs?: number | undefined,
 *   readonly metadata?: LooseMetadata | undefined,
 *   readonly method?: string | undefined,
 *   readonly platform?: PlatformInput | undefined,
 *   readonly responseSizeBytes?: number | undefined,
 *   readonly routeTemplate?: unknown,
 *   readonly screen?: string | undefined,
 *   readonly sessionId?: string | undefined,
 *   readonly status?: SpanAttributes["status"] | undefined,
 *   readonly statusCode?: number | undefined,
 *   readonly timestamp?: string | undefined,
 *   readonly trace?: TraceInput | undefined
 * }} ResourceSpanInput
 * @typedef {{
 *   readonly durationMs?: number | undefined,
 *   readonly metadata?: LooseMetadata | undefined,
 *   readonly name?: string | undefined,
 *   readonly status?: SpanAttributes["status"] | undefined,
 *   readonly trace?: TraceInput | undefined
 * }} SpanAttributesInput
 * @typedef {{
 *   readonly parentSpanId?: string | undefined,
 *   readonly randomValues?: RandomValues | undefined,
 *   readonly traceFlags?: string | undefined,
 *   readonly traceparent?: string | undefined
 * }} TraceContextInput
 * @typedef {{
 *   readonly fetchImpl?: unknown,
 *   readonly trace?: TraceInput | undefined,
 *   readonly tracePropagationTargets?: readonly TracePropagationTarget[] | undefined
 * }} TraceparentFetchInput
 * @typedef {{
 *   readonly appState?: AppStateInput | undefined,
 *   readonly captureInitialRoute?: boolean | undefined,
 *   readonly includeRouteKey?: boolean | undefined,
 *   readonly metadata?: Readonly<Metadata> | undefined,
 *   readonly now?: (() => string) | undefined,
 *   readonly nowMs?: (() => number) | undefined,
 *   readonly onError?: ((error: unknown) => void) | undefined,
 *   readonly platform?: PlatformInput | undefined,
 *   readonly trace?: TraceInput | undefined
 * }} NavigationListenerInput
 * @typedef {{
 *   captureReactNativeResourceSpan(client: LogBrewClient, input?: ResourceSpanInput): ReactNativeSpanEvent,
 *   createReactNativeSpanAttributes(input?: SpanAttributesInput): SpanAttributes,
 *   createReactNativeTraceContext(config?: TraceContextInput): ReactNativeTraceContext,
 *   createReactNativeTraceHeaders(trace?: TraceInput): { traceparent: string },
 *   createReactNavigationSpanListener(client: LogBrewClient, container: unknown, options?: NavigationListenerInput): () => void,
 *   createTraceparentFetch(config?: TraceparentFetchInput): (input: unknown, init?: unknown) => unknown,
 *   getActiveLogBrewTrace(): ReactNativeTraceContext | undefined,
 *   getReactNativeContext(options?: { readonly appState?: AppStateInput | undefined, readonly platform?: PlatformInput | undefined }): Metadata,
 *   getReactNativeTraceMetadata(trace?: TraceInput | null): Metadata,
 *   shouldPropagateTraceparent(url: unknown, tracePropagationTargets?: readonly TracePropagationTarget[]): boolean
 * }} IndexRuntime
 * @typedef {{
 *   createSafeReactNativeMetadata(metadata: Readonly<Metadata> | undefined, metadataFactory: unknown, context: unknown): Readonly<Metadata> | undefined,
 *   safeReactNativeMetadataFactoryResult(candidate: unknown): Metadata
 * }} MetadataRuntime
 * @typedef {{ readonly origin: string, readonly pathname: string, toString(): string }} ParsedUrl
 * @typedef {new (input: unknown, base: string) => ParsedUrl} UrlConstructor
 */

/** @type {IndexRuntime} */
const indexRuntime = require("./index.cjs");
/** @type {MetadataRuntime} */
const metadataRuntime = require("./metadata.cjs");

const ONE_BYTE_LIMIT = 0x80;
const TWO_BYTE_LIMIT = 0x8_00;
const THREE_BYTE_LIMIT = 0x1_00_00;
const ONE_BYTE = 1;
const TWO_BYTES = 2;
const THREE_BYTES = 3;
const FOUR_BYTES = 4;
const NO_BYTES = 0;
const MIN_DURATION_MS = 0;
const QUERY_OR_HASH = /[?#]/u;
const PATH_PART = 1;
const URL_BASE = "https://logbrew.local";

/**
 * @param {unknown} value
 * @returns {value is UnknownRecord}
 */
function isObjectLike(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is Record<PropertyKey, unknown>}
 */
function isWritableRecord(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is Callable}
 */
function isCallable(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @param {PropertyKey} key
 * @returns {unknown}
 */
function readField(value, key) {
  return isObjectLike(value) ? Reflect.get(value, key) : undefined;
}

/**
 * @param {string} character
 * @returns {number}
 */
function characterBytes(character) {
  const codePoint = character.codePointAt(NO_BYTES) ?? NO_BYTES;
  if (codePoint < ONE_BYTE_LIMIT) {
    return ONE_BYTE;
  }
  if (codePoint < TWO_BYTE_LIMIT) {
    return TWO_BYTES;
  }
  return codePoint < THREE_BYTE_LIMIT ? THREE_BYTES : FOUR_BYTES;
}

/**
 * @param {string} value
 * @returns {number}
 */
function utf8ByteLength(value) {
  let bytes = NO_BYTES;
  for (const character of value) {
    bytes += characterBytes(character);
  }
  return bytes;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorName(error) {
  const name = readField(error, "name");
  return typeof name === "string" && name.trim() !== "" ? name : "Error";
}

/**
 * @param {number} startedAtMs
 * @param {() => number} nowMs
 * @returns {number | undefined}
 */
function elapsedMs(startedAtMs, nowMs) {
  const durationMs = nowMs() - startedAtMs;
  return Number.isFinite(durationMs) ? Math.max(MIN_DURATION_MS, durationMs) : undefined;
}

/**
 * @param {unknown} value
 * @returns {value is { toString(): string }}
 */
function isStringObject(value) {
  return isObjectLike(value) && Object.prototype.isPrototypeOf.call(String.prototype, value);
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringValue(value) {
  if (typeof value === "string") {
    return value;
  }
  return isStringObject(value) ? value.toString() : undefined;
}

/**
 * @param {unknown} value
 * @returns {value is UrlConstructor}
 */
function isUrlConstructor(value) {
  return typeof value === "function";
}

/**
 * @returns {UrlConstructor | undefined}
 */
function urlConstructor() {
  const constructor = readField(globalThis, "URL");
  return isUrlConstructor(constructor) ? constructor : undefined;
}

/**
 * @param {unknown} value
 * @returns {ParsedUrl | undefined}
 */
function parseUrl(value) {
  const URLConstructor = urlConstructor();
  if (URLConstructor === undefined) {
    return undefined;
  }
  try {
    return new URLConstructor(value, URL_BASE);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripQueryAndHash(value) {
  return value.split(QUERY_OR_HASH, PATH_PART).join("");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  return typeof value === "string" ? value : String(value);
}

/**
 * @param {{ readonly url: unknown }} context
 * @returns {string}
 */
function defaultRouteTemplateFactory({ url }) {
  const parsedUrl = parseUrl(url);
  return parsedUrl === undefined ? stripQueryAndHash(toText(url)) : parsedUrl.pathname;
}

module.exports = {
  defaultRouteTemplateFactory,
  elapsedMs,
  errorName,
  indexRuntime,
  isCallable,
  isObjectLike,
  isStringObject,
  isWritableRecord,
  metadataRuntime,
  parseUrl,
  readField,
  stringValue,
  stripQueryAndHash,
  toText,
  urlConstructor,
  utf8ByteLength
};
