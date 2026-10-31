const { compactMetadata, isMetadataValue } = require("./log-context.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { isList, isRecord, requireNonEmpty } = require("./validation.cjs");

/**
 * @import { Metadata } from "./index.cjs"
 * @typedef {Readonly<ReadonlySet<string>>} KeySet
 * @typedef {Readonly<{
 *   attributeKeys?: unknown,
 *   captureUnsampled?: unknown,
 *   eventAttributeKeys?: unknown,
 *   includeSpanEvents?: unknown,
 *   includeSpanLinks?: unknown,
 *   linkAttributeKeys?: unknown,
 *   metadata?: unknown,
 *   resourceAttributeKeys?: unknown
 * }>} ReadableSpanOptions
 * @typedef {Readonly<{
 *   attributeKeys: KeySet,
 *   captureUnsampled: boolean,
 *   eventAttributeKeys: KeySet,
 *   includeSpanEvents: boolean,
 *   includeSpanLinks: boolean,
 *   linkAttributeKeys: KeySet,
 *   metadata: Readonly<Metadata>,
 *   resourceAttributeKeys: KeySet
 * }>} ResolvedSpanOptions
 */

const SPAN_ATTRIBUTE_KEYS = [
  "db.operation.name",
  "db.system",
  "faas.trigger",
  "graphql.operation.name",
  "graphql.operation.type",
  "http.method",
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "http.status_code",
  "messaging.operation.name",
  "messaging.system",
  "rpc.method",
  "rpc.service",
  "rpc.system"
];
const RESOURCE_ATTRIBUTE_KEYS = [
  "deployment.environment",
  "deployment.environment.name",
  "service.name",
  "service.version",
  "telemetry.sdk.language",
  "telemetry.sdk.name",
  "telemetry.sdk.version"
];
/** @type {KeySet} */
const DEFAULT_SPAN_ATTRIBUTE_KEYS = new Set(SPAN_ATTRIBUTE_KEYS);
/** @type {KeySet} */
const DEFAULT_RESOURCE_ATTRIBUTE_KEYS = new Set(RESOURCE_ATTRIBUTE_KEYS);
/** @type {KeySet} */
const DEFAULT_EVENT_ATTRIBUTE_KEYS = new Set(["exception.escaped", "exception.type"]);
/** @type {KeySet} */
const DEFAULT_LINK_ATTRIBUTE_KEYS = new Set();
/** @type {KeySet} */
const TRACE_SUMMARY_METADATA_KEYS = new Set([...RESOURCE_ATTRIBUTE_KEYS, ...SPAN_ATTRIBUTE_KEYS]);
/** @type {KeySet} */
const SENSITIVE_OTEL_ATTRIBUTE_KEYS = new Set([
  "code.stacktrace",
  "db.statement",
  "exception.message",
  "exception.stacktrace",
  "http.request.body",
  "http.response.body",
  "http.url",
  "url.full"
]);
const SENSITIVE_OTEL_ATTRIBUTE_PREFIXES = ["http.request.header.", "http.response.header."];
const SENSITIVE_OTEL_ATTRIBUTE_PATTERN = /(?:^|[._-])(?:authorization|body|cookie|credential|fragment|header|headers|payload|password|passwd|private[-_]?key|query|secret|stack|stacktrace|token)(?:[._-]|$)/iu;

/**
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveOpenTelemetryAttributeKey(key) {
  if (SENSITIVE_OTEL_ATTRIBUTE_KEYS.has(key)) {
    return true;
  }
  if (SENSITIVE_OTEL_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return true;
  }
  return SENSITIVE_OTEL_ATTRIBUTE_PATTERN.test(key);
}

/**
 * @param {string} label
 * @param {unknown} extraKey
 * @returns {string}
 */
function allowedExtraKey(label, extraKey) {
  const key = requireNonEmpty(label, extraKey);
  if (isSensitiveOpenTelemetryAttributeKey(key)) {
    throw new SdkError("validation_error", `${label} cannot include sensitive key: ${key}`);
  }
  return key;
}

/**
 * @param {KeySet} defaultKeys
 * @param {unknown} extraKeys
 * @param {string} label
 * @returns {KeySet}
 */
function openTelemetryAttributeKeySet(defaultKeys, extraKeys, label) {
  const allowedKeys = new Set(defaultKeys);
  if (extraKeys === undefined) {
    return allowedKeys;
  }
  if (!isList(extraKeys)) {
    throw new SdkError("validation_error", `${label} must be an array`);
  }
  for (const extraKey of extraKeys) {
    allowedKeys.add(allowedExtraKey(label, extraKey));
  }
  return allowedKeys;
}

/**
 * @param {ReadableSpanOptions} [options]
 * @returns {ResolvedSpanOptions}
 */
function resolveOpenTelemetryReadableSpanOptions(options = {}) {
  return {
    attributeKeys: openTelemetryAttributeKeySet(
      DEFAULT_SPAN_ATTRIBUTE_KEYS,
      options.attributeKeys,
      "OpenTelemetry attributeKeys"
    ),
    captureUnsampled: options.captureUnsampled === true,
    eventAttributeKeys: openTelemetryAttributeKeySet(
      DEFAULT_EVENT_ATTRIBUTE_KEYS,
      options.eventAttributeKeys,
      "OpenTelemetry eventAttributeKeys"
    ),
    includeSpanEvents: options.includeSpanEvents !== false,
    includeSpanLinks: options.includeSpanLinks !== false,
    linkAttributeKeys: openTelemetryAttributeKeySet(
      DEFAULT_LINK_ATTRIBUTE_KEYS,
      options.linkAttributeKeys,
      "OpenTelemetry linkAttributeKeys"
    ),
    metadata: compactMetadata(options.metadata),
    resourceAttributeKeys: openTelemetryAttributeKeySet(
      DEFAULT_RESOURCE_ATTRIBUTE_KEYS,
      options.resourceAttributeKeys,
      "OpenTelemetry resourceAttributeKeys"
    )
  };
}

/**
 * @param {unknown} attributes
 * @param {KeySet} allowedKeys
 * @returns {Metadata}
 */
function openTelemetrySelectedMetadata(attributes, allowedKeys) {
  /** @type {Metadata} */
  const metadata = {};
  if (!isRecord(attributes)) {
    return metadata;
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (allowedKeys.has(key) && !isSensitiveOpenTelemetryAttributeKey(key) && isMetadataValue(value)) {
      metadata[key] = value;
    }
  }
  return metadata;
}

module.exports = {
  TRACE_SUMMARY_METADATA_KEYS,
  openTelemetrySelectedMetadata,
  resolveOpenTelemetryReadableSpanOptions
};
