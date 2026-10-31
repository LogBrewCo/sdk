const { SdkError } = require("@logbrew/sdk");
const { NULL_VALUE } = require("./null-value.cjs");

/**
 * @import { Metadata, MetadataValue } from "@logbrew/sdk"
 * @typedef {Readonly<Record<string, unknown>>} LooseRecord
 * @typedef {{
 *   readonly OS?: unknown,
 *   readonly Version?: unknown,
 *   readonly isPad?: unknown,
 *   readonly constants?: { readonly isTesting?: unknown } | null | undefined
 * }} PlatformLike
 * @typedef {{
 *   readonly currentState?: unknown,
 *   readonly addEventListener?: unknown
 * }} AppStateLike
 * @typedef {{
 *   readonly traceId: string,
 *   readonly spanId: string,
 *   readonly parentSpanId: string | undefined,
 *   readonly traceFlags: string,
 *   readonly sampled: boolean
 * }} TraceContext
 * @typedef {{
 *   readonly traceId?: unknown,
 *   readonly spanId?: unknown,
 *   readonly parentSpanId?: unknown,
 *   readonly traceFlags?: unknown,
 *   readonly sampled?: unknown
 * }} TraceObjectInput
 * @typedef {TraceObjectInput | string | null | undefined} TraceInput
 * @typedef {{
 *   readonly platform?: PlatformLike | null | undefined,
 *   readonly appState?: AppStateLike | null | undefined,
 *   readonly metadata?: LooseRecord | undefined
 * }} ContextOptions
 * @typedef {(id: string, timestamp: string, attributes: LooseRecord) => unknown} ClientEventMethod
 * @typedef {{
 *   readonly action: ClientEventMethod,
 *   readonly span: ClientEventMethod,
 *   readonly issue: ClientEventMethod,
 *   readonly log: ClientEventMethod,
 *   readonly release: ClientEventMethod,
 *   readonly environment: ClientEventMethod,
 *   readonly flush: () => Promise<unknown>,
 *   readonly shutdown: () => Promise<unknown>,
 *   readonly deliveryHealth: () => unknown,
 *   readonly droppedEvents: () => unknown,
 *   readonly pendingBytes: () => unknown,
 *   readonly previewJson: () => unknown,
 *   readonly pendingEvents: () => unknown,
 *   readonly addBreadcrumb?: unknown
 * }} ClientLike
 * @typedef {(() => void) | { readonly remove?: unknown } | null | undefined} SubscriptionLike
 */

const FIRST = 0;
const LIMIT_ONE = 1;
const MIN_FAILURE_STATUS = 400;

/**
 * @param {unknown} value
 * @returns {value is null | undefined}
 */
function isNullish(value) {
  return value === undefined || value === null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  return typeof value === "string" ? value : String(value);
}

/**
 * @param {unknown} value
 * @returns {value is MetadataValue}
 */
function isMetadataValue(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null;
}

/**
 * @param {unknown} value
 * @param {PropertyKey} key
 * @returns {unknown}
 */
function readField(value, key) {
  return (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} client
 * @returns {void}
 */
function requireClient(client) {
  const present = Boolean(client);
  if (!present) {
    throw new SdkError("configuration_error", "LogBrew React Native helpers require a client");
  }
}

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {void}
 */
function requireNonEmpty(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SdkError("validation_error", `${label} must be non-empty`);
  }
}

/**
 * @param {unknown} value
 * @returns {MetadataValue}
 */
function normalizeMetadataValue(value) {
  if (value === undefined) {
    return NULL_VALUE;
  }
  return isMetadataValue(value) ? value : textOf(value);
}

/**
 * @param {LooseRecord} metadata
 * @returns {Metadata}
 */
function compactMetadata(metadata) {
  /** @type {Metadata} */
  const compacted = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isMetadataValue(value)) {
      compacted[key] = value;
    }
  }
  return compacted;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stripQueryAndHash(value) {
  return isNullish(value) ? undefined : textOf(value).split(/[?#]/u, LIMIT_ONE)[FIRST];
}

/**
 * @param {unknown} statusCode
 * @returns {"failure" | "success"}
 */
function statusFromStatusCode(statusCode) {
  if (typeof statusCode === "number" && Number.isFinite(statusCode) && statusCode >= MIN_FAILURE_STATUS) {
    return "failure";
  }
  return "success";
}

/**
 * @param {unknown} statusCode
 * @returns {"error" | "ok"}
 */
function spanStatusFromStatusCode(statusCode) {
  if (typeof statusCode === "number" && Number.isFinite(statusCode) && statusCode >= MIN_FAILURE_STATUS) {
    return "error";
  }
  return "ok";
}

/**
 * @param {ContextOptions} [options]
 * @returns {Record<string, unknown>}
 */
function getReactNativeContext({ platform, appState, metadata = {} } = {}) {
  return {
    platform: platform?.OS ?? "unknown",
    platformVersion: normalizeMetadataValue(platform?.Version),

    appState: normalizeMetadataValue(appState?.currentState),
    isPad: normalizeMetadataValue(platform?.isPad),
    isTesting: normalizeMetadataValue(platform?.constants?.isTesting),
    ...metadata
  };
}

/**
 * @param {unknown} value
 * @returns {value is () => unknown}
 */
function isRemover(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is { readonly remove: () => unknown }}
 */
function hasRemove(value) {
  return typeof readField(value, "remove") === "function";
}

/**
 * @param {unknown} subscription
 * @returns {() => unknown}
 */
function subscriptionRemover(subscription) {
  if (isRemover(subscription)) {
    return subscription;
  }
  if (hasRemove(subscription)) {
    return () => subscription.remove();
  }
  return () => undefined;
}

module.exports = {
  compactMetadata,
  getReactNativeContext,
  isMetadataValue,
  isNullish,
  normalizeMetadataValue,
  readField,
  requireClient,
  requireNonEmpty,
  spanStatusFromStatusCode,
  statusFromStatusCode,
  stripQueryAndHash,
  subscriptionRemover,
  textOf
};
