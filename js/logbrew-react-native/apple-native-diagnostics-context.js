import { hasControlCharacter, isRecord } from "./native-diagnostics-values.js";
import { configurationError } from "./apple-native-diagnostics-config.js";

/**
 * @typedef {{ traceId: string, spanId?: string, parentSpanId?: string, sampled?: boolean }} AppleTrace
 * @typedef {{ id: string, previousId?: string }} AppleSession
 * @typedef {{ id: string, kind: "anonymous" | "user" }} AppleSubject
 * @typedef {{ failedAction: string, userVisibleOutcome?: string }} AppleImpact
 * @typedef {{
 *   schemaVersion: 1,
 *   trace?: AppleTrace,
 *   session?: AppleSession,
 *   subject?: AppleSubject,
 *   impact?: AppleImpact
 * }} AppleCorrelationContext
 * @typedef {Readonly<{ maximum: number, name: string, rejectLocationText: boolean }>} DiagnosticTextRule
 */

const SCHEMA_VERSION = 1;
const ONLY_SCHEMA_VERSION = 1;
const TRACE_ID_WIDTH = 32;
const SPAN_ID_WIDTH = 16;
const NO_UNKNOWN_FIELDS = 0;
const EMPTY_LENGTH = 0;
const FAILED_ACTION_LIMIT = 256;
const USER_VISIBLE_OUTCOME_LIMIT = 512;
const CONTEXT_KEYS = ["impact", "schemaVersion", "session", "subject", "trace"];
const TRACE_KEYS = ["parentSpanId", "sampled", "spanId", "traceId"];
const SESSION_KEYS = ["id", "previousId"];
const SUBJECT_KEYS = ["id", "kind"];
const IMPACT_KEYS = ["failedAction", "userVisibleOutcome"];
/** @type {readonly ["spanId", "parentSpanId"]} */
const OPTIONAL_SPAN_IDS = ["spanId", "parentSpanId"];
const ZERO_ID_PATTERN = /^0+$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;
const LOCATION_TEXT_PATTERN = /[?#]/u;

/**
 * @param {unknown} value
 * @param {readonly string[]} allowedKeys
 * @param {string} name
 * @returns {Readonly<Record<string, unknown>>}
 */
function exactObject(value, allowedKeys, name) {
  if (!isRecord(value)) {
    throw configurationError(`${name} must be an object`);
  }
  const unknownKeys = Object.keys(value).filter(key => !allowedKeys.includes(key));
  if (unknownKeys.length > NO_UNKNOWN_FIELDS) {
    throw configurationError(`${name} contains unsupported fields`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {number} width
 * @param {string} name
 * @returns {string}
 */
function correlationHexId(value, width, name) {
  if (typeof value !== "string"
    || !new RegExp(`^[0-9a-f]{${width}}$`, "iu").test(value)
    || ZERO_ID_PATTERN.test(value)) {
    throw configurationError(`context trace ${name} must be a non-zero ${width}-character hex value`);
  }
  return value.toLowerCase();
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function opaqueCorrelationId(value, name) {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw configurationError(`context ${name} must be an opaque app-owned identifier`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {DiagnosticTextRule} rule
 * @returns {string}
 */
function diagnosticText(value, rule) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === EMPTY_LENGTH
    || [...normalized].length > rule.maximum
    || hasControlCharacter(normalized)
    || (rule.rejectLocationText && LOCATION_TEXT_PATTERN.test(normalized))) {
    throw configurationError(`context impact ${rule.name} is invalid`);
  }
  return normalized;
}

/**
 * @param {Readonly<Record<string, unknown>>} trace
 * @returns {{ spanId?: string, parentSpanId?: string }}
 */
function optionalSpanIds(trace) {
  /** @type {{ spanId?: string, parentSpanId?: string }} */
  const output = {};
  for (const key of OPTIONAL_SPAN_IDS) {
    if (trace[key] !== undefined) {
      output[key] = correlationHexId(trace[key], SPAN_ID_WIDTH, key);
    }
  }
  return output;
}

/**
 * @param {unknown} sampled
 * @returns {{ sampled?: boolean }}
 */
function optionalSampled(sampled) {
  if (sampled === undefined) {
    return {};
  }
  if (typeof sampled !== "boolean") {
    throw configurationError("context trace sampled must be a boolean");
  }
  return { sampled };
}

/**
 * @param {unknown} value
 * @returns {AppleTrace}
 */
function normalizeTrace(value) {
  const trace = exactObject(value, TRACE_KEYS, "context trace");
  const traceId = correlationHexId(trace["traceId"], TRACE_ID_WIDTH, "traceId");
  return { traceId, ...optionalSpanIds(trace), ...optionalSampled(trace["sampled"]) };
}

/**
 * @param {unknown} value
 * @returns {AppleSession}
 */
function normalizeSession(value) {
  const session = exactObject(value, SESSION_KEYS, "context session");
  /** @type {AppleSession} */
  const output = { id: opaqueCorrelationId(session["id"], "session id") };
  if (session["previousId"] !== undefined) {
    output.previousId = opaqueCorrelationId(session["previousId"], "session previousId");
    if (output.previousId === output.id) {
      throw configurationError("context session previousId must differ from id");
    }
  }
  return output;
}

/**
 * @param {unknown} value
 * @returns {AppleSubject}
 */
function normalizeSubject(value) {
  const subject = exactObject(value, SUBJECT_KEYS, "context subject");
  const { kind } = subject;
  if (kind !== "anonymous" && kind !== "user") {
    throw configurationError("context subject kind must be anonymous or user");
  }
  return { id: opaqueCorrelationId(subject["id"], "subject id"), kind };
}

/**
 * @param {unknown} value
 * @returns {AppleImpact}
 */
function normalizeImpact(value) {
  const impact = exactObject(value, IMPACT_KEYS, "context impact");
  /** @type {AppleImpact} */
  const output = {
    failedAction: diagnosticText(impact["failedAction"], { maximum: FAILED_ACTION_LIMIT, name: "failedAction", rejectLocationText: true })
  };
  if (impact["userVisibleOutcome"] !== undefined) {
    output.userVisibleOutcome = diagnosticText(
      impact["userVisibleOutcome"],
      { maximum: USER_VISIBLE_OUTCOME_LIMIT, name: "userVisibleOutcome", rejectLocationText: false }
    );
  }
  return output;
}

/**
 * @template T
 * @param {unknown} value
 * @param {(input: unknown) => T} normalize
 * @returns {T | undefined}
 */
function section(value, normalize) {
  return value === undefined ? undefined : normalize(value);
}

/**
 * @param {unknown} context
 * @returns {Readonly<Record<string, unknown>>}
 */
function correlationSource(context) {
  const source = exactObject(context, CONTEXT_KEYS, "context");
  if (source["schemaVersion"] !== SCHEMA_VERSION) {
    throw configurationError("context schemaVersion must be 1");
  }
  return source;
}

/**
 * @param {unknown} context
 * @returns {AppleCorrelationContext}
 */
function normalizeCorrelationContext(context) {
  const source = correlationSource(context);
  const trace = section(source["trace"], normalizeTrace);
  const session = section(source["session"], normalizeSession);
  const subject = section(source["subject"], normalizeSubject);
  const impact = section(source["impact"], normalizeImpact);
  /** @type {AppleCorrelationContext} */
  const output = {
    schemaVersion: SCHEMA_VERSION,
    ...(trace === undefined ? {} : { trace }),
    ...(session === undefined ? {} : { session }),
    ...(subject === undefined ? {} : { subject }),
    ...(impact === undefined ? {} : { impact })
  };
  if (Object.keys(output).length === ONLY_SCHEMA_VERSION) {
    throw configurationError("context must include trace, session, subject, or impact");
  }
  return output;
}

export { normalizeCorrelationContext };
