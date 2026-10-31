const { SdkError } = require("./sdk-error.cjs");
const {
  ZERO_SPAN_ID,
  ZERO_TRACE_ID,
  isRecord,
  requireSpanId,
  requireTraceFlags,
  requireTraceId
} = require("./validation.cjs");

/**
 * @import { BaggageEntry, TraceparentContext, TracestateEntry } from "./index.cjs"
 * @typedef {{ traceparent: string, tracestate?: string, baggage?: string }} TraceContextHeaders
 * @typedef {{ readonly key: string, readonly value: string, readonly properties?: readonly string[] }} ReadonlyBaggageEntry
 */

const MAX_TRACESTATE_ENTRIES = 32;
const MAX_TRACESTATE_LENGTH = 512;
const MAX_TRACESTATE_VALUE_LENGTH = 256;
const MAX_BAGGAGE_ENTRIES = 64;
const MAX_BAGGAGE_LENGTH = 8192;
const DEFAULT_TRACE_FLAGS = "01";
const HEX_RADIX = 16;
const SAMPLED_FLAG_DIVISOR = 2;
const SAMPLED_FLAG_REMAINDER = 1;
const KEY_START = 0;
const SEPARATOR_WIDTH = 1;
const NO_PROPERTIES = 0;
const TRACEPARENT_PATTERN =
  /^(?<version>[0-9a-fA-F]{2})-(?<traceId>[0-9a-fA-F]{32})-(?<parentSpanId>[0-9a-fA-F]{16})-(?<traceFlags>[0-9a-fA-F]{2})$/u;
const TRACESTATE_SIMPLE_KEY_PATTERN = /^[a-z0-9][a-z0-9_\-*/]{0,255}$/u;
const TRACESTATE_TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9_\-*/]{0,240}@[a-z][a-z0-9_\-*/]{0,13}$/u;
const TRACESTATE_VALUE_PATTERN = /^[ -+--<>-~]*[!-+--<>-~]$/u;
const BAGGAGE_KEY_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const BAGGAGE_PROPERTY_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:=[!#$%&'*+\-.^_`|~0-9A-Za-z]*)?$/u;

/**
 * @param {unknown} traceparent
 * @returns {Readonly<Record<string, string>>}
 */
function traceparentParts(traceparent) {
  if (typeof traceparent !== "string" || traceparent.trim() === "") {
    throw new SdkError("validation_error", "traceparent must be non-empty");
  }
  const parts = TRACEPARENT_PATTERN.exec(traceparent.trim())?.groups;
  if (parts === undefined) {
    throw new SdkError("validation_error", "traceparent must use W3C version-traceId-parentSpanId-traceFlags format");
  }
  return parts;
}

/**
 * @param {string} version
 * @param {string} traceId
 * @param {string} parentSpanId
 * @returns {void}
 */
function rejectInvalidTraceparent(version, traceId, parentSpanId) {
  if (version === "ff") {
    throw new SdkError("validation_error", "traceparent version ff is not allowed");
  }
  if (traceId === ZERO_TRACE_ID) {
    throw new SdkError("validation_error", "traceparent traceId must not be all zeros");
  }
  if (parentSpanId === ZERO_SPAN_ID) {
    throw new SdkError("validation_error", "traceparent parentSpanId must not be all zeros");
  }
}

/**
 * @param {unknown} traceparent
 * @returns {TraceparentContext}
 */
function parseTraceparent(traceparent) {
  const parts = traceparentParts(traceparent);
  const version = String(parts["version"]).toLowerCase();
  const traceId = String(parts["traceId"]).toLowerCase();
  const parentSpanId = String(parts["parentSpanId"]).toLowerCase();
  const traceFlags = String(parts["traceFlags"]).toLowerCase();
  rejectInvalidTraceparent(version, traceId, parentSpanId);
  const sampled = Number.parseInt(traceFlags, HEX_RADIX) % SAMPLED_FLAG_DIVISOR === SAMPLED_FLAG_REMAINDER;
  return {
    version,

    traceId,

    parentSpanId,
    traceFlags,

    sampled
  };
}

/**
 * @param {Readonly<{ traceId?: unknown, spanId?: unknown, traceFlags?: unknown }>} input
 * @returns {string}
 */
function createTraceparent({ traceId, spanId, traceFlags = DEFAULT_TRACE_FLAGS }) {
  const validTraceId = requireTraceId(traceId);
  const validSpanId = requireSpanId("spanId", spanId);
  const validTraceFlags = requireTraceFlags(traceFlags);
  return `00-${validTraceId.toLowerCase()}-${validSpanId.toLowerCase()}-${validTraceFlags.toLowerCase()}`;
}

/**
 * @param {Readonly<{ traceId?: unknown, spanId?: unknown, traceFlags?: unknown }>} input
 * @returns {{ traceparent: string }}
 */
function createTraceparentHeaders(input) {
  return { traceparent: createTraceparent(input) };
}

/**
 * @param {readonly Readonly<TracestateEntry>[]} entries
 * @returns {string}
 */
function serializeTracestate(entries) {
  return entries.map((entry) => `${entry.key}=${entry.value}`).join(",");
}

/**
 * @param {readonly ReadonlyBaggageEntry[]} entries
 * @returns {string}
 */
function serializeBaggage(entries) {
  return entries
    .map((entry) => {
      const properties = entry.properties === undefined ? "" : `;${entry.properties.join(";")}`;
      return `${entry.key}=${encodeURIComponent(entry.value)}${properties}`;
    })
    .join(",");
}

/**
 * @param {unknown} key
 * @returns {string}
 */
function validateTracestateKey(key) {
  if (typeof key !== "string" || key.trim() === "") {
    throw new SdkError("validation_error", "tracestate key must be non-empty");
  }
  const normalized = key.trim();
  if (!TRACESTATE_SIMPLE_KEY_PATTERN.test(normalized) && !TRACESTATE_TENANT_KEY_PATTERN.test(normalized)) {
    throw new SdkError("validation_error", "tracestate key must be lowercase W3C tracestate key");
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function validateTracestateValue(value) {
  if (
    typeof value !== "string"
    || value === ""
    || value.length > MAX_TRACESTATE_VALUE_LENGTH
    || !TRACESTATE_VALUE_PATTERN.test(value)
  ) {
    throw new SdkError("validation_error", "tracestate value must be printable ASCII without comma or equals");
  }
  return value;
}

/**
 * @param {unknown} key
 * @returns {string}
 */
function validateBaggageKey(key) {
  if (typeof key !== "string" || !BAGGAGE_KEY_PATTERN.test(key)) {
    throw new SdkError("validation_error", "baggage key must use RFC header-name characters");
  }
  return key;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function validateBaggageValue(value) {
  if (typeof value !== "string") {
    throw new SdkError("validation_error", "baggage value must be a string");
  }
  return value;
}

/**
 * @param {unknown} properties
 * @returns {string[] | undefined}
 */
function normalizeBaggageProperties(properties) {
  if (properties === undefined) {
    return undefined;
  }
  if (!Array.isArray(properties)) {
    throw new SdkError("validation_error", "baggage properties must be an array");
  }
  /** @type {readonly unknown[]} */
  const candidates = properties;
  const safeProperties = candidates.map((property) => {
    if (typeof property !== "string" || !BAGGAGE_PROPERTY_PATTERN.test(property)) {
      throw new SdkError("validation_error", "baggage property must use RFC header-name characters");
    }
    return property;
  });
  return safeProperties.length > NO_PROPERTIES ? safeProperties : undefined;
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeBaggageValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SdkError("validation_error", "baggage value must use valid percent encoding");
  }
}

/**
 * @param {unknown} entries
 * @param {string} label
 * @param {number} maxEntries
 * @returns {readonly unknown[]}
 */
function requireEntryList(entries, label, maxEntries) {
  if (!Array.isArray(entries)) {
    throw new SdkError("validation_error", `${label} entries must be an array`);
  }
  if (entries.length > maxEntries) {
    throw new SdkError("validation_error", `${label} must contain at most ${maxEntries} entries`);
  }
  return entries;
}

/**
 * @param {unknown} entries
 * @returns {TracestateEntry[]}
 */
function normalizeTracestateEntries(entries) {
  const list = requireEntryList(entries, "tracestate", MAX_TRACESTATE_ENTRIES);
  const seenKeys = new Set();
  const normalized = list.map((entry) => {
    if (!isRecord(entry)) {
      throw new SdkError("validation_error", "tracestate entry must be an object");
    }
    const key = validateTracestateKey(entry["key"]);
    if (seenKeys.has(key)) {
      throw new SdkError("validation_error", "tracestate keys must be unique");
    }
    seenKeys.add(key);
    return { key, value: validateTracestateValue(entry["value"]) };
  });
  if (serializeTracestate(normalized).length > MAX_TRACESTATE_LENGTH) {
    throw new SdkError("validation_error", `tracestate must be at most ${MAX_TRACESTATE_LENGTH} characters`);
  }
  return normalized;
}

/**
 * @param {unknown} entry
 * @returns {BaggageEntry}
 */
function normalizeBaggageEntry(entry) {
  if (!isRecord(entry)) {
    throw new SdkError("validation_error", "baggage entry must be an object");
  }
  const key = validateBaggageKey(entry["key"]);
  const value = validateBaggageValue(entry["value"]);
  const properties = normalizeBaggageProperties(entry["properties"]);
  return { key, value, ...(properties === undefined ? {} : { properties }) };
}

/**
 * @param {unknown} entries
 * @returns {BaggageEntry[]}
 */
function normalizeBaggageEntries(entries) {
  const list = requireEntryList(entries, "baggage", MAX_BAGGAGE_ENTRIES);
  const normalized = list.map((entry) => normalizeBaggageEntry(entry));
  if (serializeBaggage(normalized).length > MAX_BAGGAGE_LENGTH) {
    throw new SdkError("validation_error", `baggage must be at most ${MAX_BAGGAGE_LENGTH} characters`);
  }
  return normalized;
}

/**
 * @param {string} header
 * @returns {string[]}
 */
function headerEntries(header) {
  return header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * @param {unknown} tracestate
 * @returns {TracestateEntry[]}
 */
function parseTracestate(tracestate) {
  if (typeof tracestate !== "string" || tracestate.trim() === "") {
    throw new SdkError("validation_error", "tracestate must be non-empty");
  }
  return normalizeTracestateEntries(
    headerEntries(tracestate).map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= KEY_START) {
        throw new SdkError("validation_error", "tracestate entries must use key=value");
      }
      return {
        key: entry.slice(KEY_START, separator).trim(),
        value: entry.slice(separator + SEPARATOR_WIDTH).trim()
      };
    })
  );
}

/**
 * @param {string} entry
 * @returns {ReadonlyBaggageEntry}
 */
function parseBaggageEntry(entry) {
  const [pair = "", ...rawProperties] = entry.split(";");
  const separator = pair.indexOf("=");
  if (separator <= KEY_START) {
    throw new SdkError("validation_error", "baggage entries must use key=value");
  }
  const key = pair.slice(KEY_START, separator).trim();
  const value = decodeBaggageValue(pair.slice(separator + SEPARATOR_WIDTH).trim());
  const properties = rawProperties.map((property) => property.trim()).filter((property) => property !== "");
  return {
    key,
    value,

    properties
  };
}

/**
 * @param {unknown} baggage
 * @returns {BaggageEntry[]}
 */
function parseBaggage(baggage) {
  if (typeof baggage !== "string" || baggage.trim() === "") {
    throw new SdkError("validation_error", "baggage must be non-empty");
  }
  return normalizeBaggageEntries(headerEntries(baggage).map((entry) => parseBaggageEntry(entry)));
}

/**
 * @param {unknown} entries
 * @returns {string}
 */
function createTracestate(entries) {
  return serializeTracestate(normalizeTracestateEntries(entries));
}

/**
 * @param {unknown} entries
 * @returns {string}
 */
function createBaggage(entries) {
  return serializeBaggage(normalizeBaggageEntries(entries));
}

/**
 * @param {unknown} tracestate
 * @returns {{ tracestate?: string }}
 */
function tracestateHeader(tracestate) {
  if (tracestate === undefined) {
    return {};
  }
  const value = typeof tracestate === "string" ? createTracestate(parseTracestate(tracestate)) : createTracestate(tracestate);
  return value === "" ? {} : { tracestate: value };
}

/**
 * @param {unknown} baggage
 * @returns {{ baggage?: string }}
 */
function baggageHeader(baggage) {
  if (baggage === undefined) {
    return {};
  }
  const value = typeof baggage === "string" ? createBaggage(parseBaggage(baggage)) : createBaggage(baggage);
  return value === "" ? {} : { baggage: value };
}

/**
 * @param {unknown} input
 * @returns {TraceContextHeaders}
 */
function createTraceContextHeaders(input) {
  if (!isRecord(input)) {
    throw new SdkError("validation_error", "trace context input must be an object");
  }
  const traceparent = createTraceparent(input);
  return { traceparent, ...tracestateHeader(input["tracestate"]), ...baggageHeader(input["baggage"]) };
}

module.exports = {
  createBaggage,
  createTraceContextHeaders,
  createTraceparent,
  createTraceparentHeaders,
  createTracestate,
  parseBaggage,
  parseTraceparent,
  parseTracestate
};
