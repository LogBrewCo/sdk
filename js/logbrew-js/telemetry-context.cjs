"use strict";

const { SdkError } = require("./sdk-error.cjs");
const { hasUnicodeControlCharacter, optionalEntry, rejectUnknownKeys, requireObject } = require("./validation.cjs");

/**
 * @import { TelemetryContext, TelemetryResource, TelemetrySessionContext, TelemetrySubjectContext, TelemetryTraceContext } from "./index.cjs"
 * @typedef {{ readonly pattern: Readonly<RegExp>, readonly width: number, readonly zeroValue: string }} HexIdFormat
 * @typedef {{ readonly [Kind in keyof TelemetryResource]?: Readonly<NonNullable<TelemetryResource[Kind]>> }} ReadonlyResource
 * @typedef {{
 *   readonly schemaVersion: 1,
 *   readonly resource?: ReadonlyResource,
 *   readonly trace?: Readonly<TelemetryTraceContext>,
 *   readonly session?: Readonly<TelemetrySessionContext>,
 *   readonly subject?: Readonly<TelemetrySubjectContext>,
 *   readonly tags?: Readonly<Record<string, string>>
 * }} ReadonlyTelemetryContext
 */

/** @type {1} */
const CONTEXT_SCHEMA_VERSION = 1;
const MAX_CONTEXT_ID_LENGTH = 200;
const MAX_CONTEXT_STRING_LENGTH = 256;
const MAX_CONTEXT_TAGS = 32;
const MAX_CONTEXT_TAG_KEY_LENGTH = 64;
const MAX_CONTEXT_TAG_VALUE_LENGTH = 256;
const NO_ENTRIES = 0;
const ONLY_SCHEMA_VERSION = 1;
const TAG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const CONTEXT_KEYS = new Set(["schemaVersion", "resource", "trace", "session", "subject", "tags"]);
/** @type {ReadonlySet<keyof TelemetryResource>} */
const RESOURCE_KEYS = new Set(["service", "deployment", "runtime", "framework", "operatingSystem", "device", "application"]);
const TRACE_KEYS = new Set(["traceId", "spanId", "parentSpanId", "sampled"]);
const SESSION_KEYS = new Set(["id", "previousId"]);
const SUBJECT_KEYS = new Set(["id", "kind"]);
/** @type {readonly ["name", "version"]} */
const NAME_VERSION_FIELDS = ["name", "version"];
/** @type {readonly ["name", "version", "build"]} */
const NAME_VERSION_BUILD_FIELDS = ["name", "version", "build"];
/** @type {readonly ["environment", "release"]} */
const DEPLOYMENT_FIELDS = ["environment", "release"];
/** @type {readonly ["family", "model", "architecture"]} */
const DEVICE_FIELDS = ["family", "model", "architecture"];
/** @type {HexIdFormat} */
const TRACE_ID_FORMAT = { pattern: /^[0-9a-f]{32}$/iu, width: 32, zeroValue: "00000000000000000000000000000000" };
/** @type {HexIdFormat} */
const SPAN_ID_FORMAT = { pattern: /^[0-9a-f]{16}$/iu, width: 16, zeroValue: "0000000000000000" };

/**
 * @param {string} message
 * @returns {Error}
 */
function invalid(message) {
  return new SdkError("validation_error", message);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} [maxLength]
 * @returns {string}
 */
function boundedString(value, label, maxLength = MAX_CONTEXT_STRING_LENGTH) {
  if (typeof value !== "string") {
    throw invalid(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized === "" || [...normalized].length > maxLength || hasUnicodeControlCharacter(normalized)) {
    throw invalid(`${label} is invalid`);
  }
  return normalized;
}

/**
 * @template {string} Field
 * @param {unknown} value
 * @param {readonly Field[]} fields
 * @param {string} label
 * @returns {{ [Key in Field]?: string }}
 */
function sectionFields(value, fields, label) {
  const section = requireObject(label, value);
  rejectUnknownKeys(label, section, new Set(fields));
  /** @type {{ [Key in Field]?: string }} */
  const normalized = {};
  for (const field of fields) {
    const fieldValue = section[field];
    if (fieldValue !== undefined) {
      normalized[field] = boundedString(fieldValue, `${label} ${field}`);
    }
  }
  return normalized;
}

/**
 * @template {string} Field
 * @param {unknown} value
 * @param {readonly ["name", ...Field[]]} fields
 * @param {string} label
 * @returns {({ name: string } & { [Key in Field]?: string }) | undefined}
 */
function namedSection(value, fields, label) {
  if (value === undefined) {
    return undefined;
  }
  const { name, ...rest } = sectionFields(value, fields, label);
  if (name === undefined) {
    throw invalid(`${label} name is required`);
  }
  return { name, ...rest };
}

/**
 * @template {string} Field
 * @param {unknown} value
 * @param {readonly Field[]} fields
 * @param {string} label
 * @returns {{ [Key in Field]?: string } | undefined}
 */
function nonEmptySection(value, fields, label) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = sectionFields(value, fields, label);
  if (Object.keys(normalized).length === NO_ENTRIES) {
    throw invalid(`${label} must not be empty`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {TelemetryResource | undefined}
 */
function normalizeResource(value, label) {
  if (value === undefined) {
    return undefined;
  }
  const resource = requireObject(label, value);
  rejectUnknownKeys(label, resource, RESOURCE_KEYS);
  const normalized = {
    ...optionalEntry("service", namedSection(resource["service"], NAME_VERSION_FIELDS, `${label} service`)),
    ...optionalEntry("deployment", nonEmptySection(resource["deployment"], DEPLOYMENT_FIELDS, `${label} deployment`)),
    ...optionalEntry("runtime", namedSection(resource["runtime"], NAME_VERSION_FIELDS, `${label} runtime`)),
    ...optionalEntry("framework", namedSection(resource["framework"], NAME_VERSION_FIELDS, `${label} framework`)),
    ...optionalEntry(
      "operatingSystem",
      namedSection(resource["operatingSystem"], NAME_VERSION_BUILD_FIELDS, `${label} operatingSystem`)
    ),
    ...optionalEntry("device", nonEmptySection(resource["device"], DEVICE_FIELDS, `${label} device`)),
    ...optionalEntry("application", nonEmptySection(resource["application"], NAME_VERSION_BUILD_FIELDS, `${label} application`))
  };
  if (Object.keys(normalized).length === NO_ENTRIES) {
    throw invalid(`${label} must not be empty`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {HexIdFormat} format
 * @returns {string}
 */
function requireHexId(value, label, format) {
  if (typeof value !== "string" || !format.pattern.test(value) || value.toLowerCase() === format.zeroValue) {
    throw invalid(`${label} must be ${format.width} non-zero hex characters`);
  }
  return value.toLowerCase();
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {HexIdFormat} format
 * @returns {string | undefined}
 */
function optionalHexId(value, label, format) {
  return value === undefined ? undefined : requireHexId(value, label, format);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {boolean | undefined}
 */
function optionalBoolean(value, label) {
  if (value !== undefined && typeof value !== "boolean") {
    throw invalid(`${label} must be a boolean`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {TelemetryTraceContext | undefined}
 */
function normalizeTrace(value, label) {
  if (value === undefined) {
    return undefined;
  }
  const trace = requireObject(label, value);
  rejectUnknownKeys(label, trace, TRACE_KEYS);
  const traceId = requireHexId(trace["traceId"], `${label} traceId`, TRACE_ID_FORMAT);
  const spanId = optionalHexId(trace["spanId"], `${label} spanId`, SPAN_ID_FORMAT);
  const parentSpanId = optionalHexId(trace["parentSpanId"], `${label} parentSpanId`, SPAN_ID_FORMAT);
  const sampled = optionalBoolean(trace["sampled"], `${label} sampled`);
  return {
    traceId,
    ...optionalEntry("spanId", spanId),
    ...optionalEntry("parentSpanId", parentSpanId),
    ...optionalEntry("sampled", sampled)
  };
}

/**
 * @param {unknown} value
 * @param {string} id
 * @param {string} label
 * @returns {string | undefined}
 */
function previousSessionId(value, id, label) {
  if (value === undefined) {
    return undefined;
  }
  const previousId = boundedString(value, `${label} previousId`, MAX_CONTEXT_ID_LENGTH);
  if (previousId === id) {
    throw invalid(`${label} previousId must differ from id`);
  }
  return previousId;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {TelemetrySessionContext | undefined}
 */
function normalizeSession(value, label) {
  if (value === undefined) {
    return undefined;
  }
  const session = requireObject(label, value);
  rejectUnknownKeys(label, session, SESSION_KEYS);
  const id = boundedString(session["id"], `${label} id`, MAX_CONTEXT_ID_LENGTH);
  const previousId = previousSessionId(session["previousId"], id, label);
  return { id, ...optionalEntry("previousId", previousId) };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {TelemetrySubjectContext | undefined}
 */
function normalizeSubject(value, label) {
  if (value === undefined) {
    return undefined;
  }
  const subject = requireObject(label, value);
  rejectUnknownKeys(label, subject, SUBJECT_KEYS);
  const id = boundedString(subject["id"], `${label} id`, MAX_CONTEXT_ID_LENGTH);
  const { kind } = subject;
  if (kind !== "anonymous" && kind !== "user") {
    throw invalid(`${label} kind must be anonymous or user`);
  }
  return { id, kind };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, string> | undefined}
 */
function normalizeTags(value, label) {
  if (value === undefined) {
    return undefined;
  }
  const tags = requireObject(label, value);
  const keys = Object.keys(tags);
  keys.sort();
  if (keys.length === NO_ENTRIES || keys.length > MAX_CONTEXT_TAGS) {
    throw invalid(`${label} must contain 1-${MAX_CONTEXT_TAGS} entries`);
  }
  return Object.fromEntries(keys.map((key) => {
    if (key.length > MAX_CONTEXT_TAG_KEY_LENGTH || !TAG_KEY_PATTERN.test(key)) {
      throw invalid(`${label} key is invalid`);
    }
    return [key, boundedString(tags[key], `${label} value for ${key}`, MAX_CONTEXT_TAG_VALUE_LENGTH)];
  }));
}

/**
 * @param {Readonly<Record<string, unknown>>} source
 * @param {string} label
 * @returns {TelemetryContext}
 */
function normalizeContextSections(source, label) {
  const resource = normalizeResource(source["resource"], `${label} resource`);
  const trace = normalizeTrace(source["trace"], `${label} trace`);
  const session = normalizeSession(source["session"], `${label} session`);
  const subject = normalizeSubject(source["subject"], `${label} subject`);
  const tags = normalizeTags(source["tags"], `${label} tags`);
  const normalized = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    ...optionalEntry("resource", resource),
    ...optionalEntry("trace", trace),
    ...optionalEntry("session", session),
    ...optionalEntry("subject", subject),
    ...optionalEntry("tags", tags)
  };
  if (Object.keys(normalized).length === ONLY_SCHEMA_VERSION) {
    throw invalid(`${label} must include resource, trace, session, subject, or tags`);
  }
  return normalized;
}

/**
 * @param {unknown} context
 * @param {string} [label]
 * @returns {TelemetryContext | undefined}
 */
function validateTelemetryContext(context, label = "telemetry context") {
  if (context === undefined) {
    return undefined;
  }
  const source = requireObject(label, context);
  rejectUnknownKeys(label, source, CONTEXT_KEYS);
  if (source["schemaVersion"] !== CONTEXT_SCHEMA_VERSION) {
    throw invalid(`${label} schemaVersion must be ${CONTEXT_SCHEMA_VERSION}`);
  }
  return normalizeContextSections(source, label);
}

/**
 * @param {ReadonlyResource | undefined} base
 * @param {ReadonlyResource | undefined} override
 * @returns {Readonly<Record<string, unknown>> | undefined}
 */
function mergeResources(base, override) {
  if (base === undefined || override === undefined) {
    return base ?? override;
  }
  return Object.fromEntries([...RESOURCE_KEYS].flatMap((key) => {
    const baseSection = base[key];
    const overrideSection = override[key];
    return baseSection === undefined && overrideSection === undefined ? [] : [[key, { ...baseSection, ...overrideSection }]];
  }));
}

/**
 * @param {ReadonlyTelemetryContext} base
 * @param {ReadonlyTelemetryContext} override
 * @returns {Readonly<Record<string, unknown>>}
 */
function mergeDefinedContexts(base, override) {
  const tags = base.tags === undefined && override.tags === undefined ? undefined : { ...base.tags, ...override.tags };
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    ...optionalEntry("resource", mergeResources(base.resource, override.resource)),
    ...optionalEntry("trace", override.trace ?? base.trace),
    ...optionalEntry("session", override.session ?? base.session),
    ...optionalEntry("subject", override.subject ?? base.subject),
    ...optionalEntry("tags", normalizeTags(tags, "merged telemetry context tags"))
  };
}

/**
 * @param {unknown} base
 * @param {unknown} override
 * @returns {TelemetryContext | undefined}
 */
function mergeTelemetryContexts(base, override) {
  const normalizedBase = validateTelemetryContext(base, "client telemetry context");
  const normalizedOverride = validateTelemetryContext(override, "event telemetry context");
  if (normalizedBase === undefined || normalizedOverride === undefined) {
    return normalizedOverride ?? normalizedBase;
  }
  return validateTelemetryContext(mergeDefinedContexts(normalizedBase, normalizedOverride), "merged telemetry context");
}

/**
 * @param {unknown} context
 * @returns {TelemetryContext | undefined}
 */
function cloneTelemetryContext(context) {
  return validateTelemetryContext(context);
}

module.exports = { cloneTelemetryContext, mergeTelemetryContexts, validateTelemetryContext };
