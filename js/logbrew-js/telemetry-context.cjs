"use strict";

const CONTEXT_SCHEMA_VERSION = 1;
const MAX_CONTEXT_ID_LENGTH = 200;
const MAX_CONTEXT_STRING_LENGTH = 256;
const MAX_CONTEXT_TAGS = 32;
const MAX_CONTEXT_TAG_KEY_LENGTH = 64;
const MAX_CONTEXT_TAG_VALUE_LENGTH = 256;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/iu;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/iu;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";
const TAG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const CONTEXT_KEYS = new Set(["schemaVersion", "resource", "trace", "session", "subject", "tags"]);
const RESOURCE_KEYS = [
  "service",
  "deployment",
  "runtime",
  "framework",
  "operatingSystem",
  "device",
  "application"
];

function buildTelemetryContextHelpers({ SdkError }) {
  function validateTelemetryContext(context, label = "telemetry context") {
    if (context === undefined) {
      return undefined;
    }
    const source = requireRecord(context, label);
    rejectUnknownFields(source, CONTEXT_KEYS, label);
    if (source.schemaVersion !== CONTEXT_SCHEMA_VERSION) {
      throw invalid(`${label} schemaVersion must be ${CONTEXT_SCHEMA_VERSION}`);
    }

    const normalized = { schemaVersion: CONTEXT_SCHEMA_VERSION };
    const resource = normalizeResource(source.resource, `${label} resource`);
    const trace = normalizeTrace(source.trace, `${label} trace`);
    const session = normalizeSession(source.session, `${label} session`);
    const subject = normalizeSubject(source.subject, `${label} subject`);
    const tags = normalizeTags(source.tags, `${label} tags`);
    if (resource !== undefined) {
      normalized.resource = resource;
    }
    if (trace !== undefined) {
      normalized.trace = trace;
    }
    if (session !== undefined) {
      normalized.session = session;
    }
    if (subject !== undefined) {
      normalized.subject = subject;
    }
    if (tags !== undefined) {
      normalized.tags = tags;
    }
    if (Object.keys(normalized).length === 1) {
      throw invalid(`${label} must include resource, trace, session, subject, or tags`);
    }
    return normalized;
  }

  function mergeTelemetryContexts(base, override) {
    const normalizedBase = validateTelemetryContext(base, "client telemetry context");
    const normalizedOverride = validateTelemetryContext(override, "event telemetry context");
    if (normalizedBase === undefined) {
      return normalizedOverride;
    }
    if (normalizedOverride === undefined) {
      return normalizedBase;
    }

    const merged = { schemaVersion: CONTEXT_SCHEMA_VERSION };
    const resource = mergeResources(normalizedBase.resource, normalizedOverride.resource);
    if (resource !== undefined) {
      merged.resource = resource;
    }
    if (normalizedOverride.trace ?? normalizedBase.trace) {
      merged.trace = { ...(normalizedOverride.trace ?? normalizedBase.trace) };
    }
    if (normalizedOverride.session ?? normalizedBase.session) {
      merged.session = { ...(normalizedOverride.session ?? normalizedBase.session) };
    }
    if (normalizedOverride.subject ?? normalizedBase.subject) {
      merged.subject = { ...(normalizedOverride.subject ?? normalizedBase.subject) };
    }
    const mergedTagValues = normalizedBase.tags !== undefined || normalizedOverride.tags !== undefined
      ? { ...(normalizedBase.tags ?? {}), ...(normalizedOverride.tags ?? {}) }
      : undefined;
    const tags = normalizeTags(mergedTagValues, "merged telemetry context tags");
    if (tags !== undefined) {
      merged.tags = tags;
    }
    return validateTelemetryContext(merged, "merged telemetry context");
  }

  function cloneTelemetryContext(context) {
    return validateTelemetryContext(context);
  }

  function invalid(message) {
    return new SdkError("validation_error", message);
  }

  function requireRecord(value, label) {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw invalid(`${label} must be an object`);
    }
    return value;
  }

  function rejectUnknownFields(value, allowed, label) {
    const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
    if (unknown.length > 0) {
      throw invalid(`${label} has unsupported fields: ${unknown.join(", ")}`);
    }
  }

  function normalizeResource(value, label) {
    if (value === undefined) {
      return undefined;
    }
    const resource = requireRecord(value, label);
    rejectUnknownFields(resource, new Set(RESOURCE_KEYS), label);
    const normalized = {};
    for (const key of RESOURCE_KEYS) {
      if (resource[key] === undefined) {
        continue;
      }
      normalized[key] = normalizeResourceSection(key, resource[key], `${label} ${key}`);
    }
    if (Object.keys(normalized).length === 0) {
      throw invalid(`${label} must not be empty`);
    }
    return normalized;
  }

  function normalizeResourceSection(kind, value, label) {
    const section = requireRecord(value, label);
    const fields = resourceFields(kind);
    rejectUnknownFields(section, new Set(fields), label);
    const normalized = {};
    for (const field of fields) {
      if (section[field] !== undefined) {
        normalized[field] = boundedString(section[field], `${label} ${field}`);
      }
    }
    if (["service", "runtime", "framework", "operatingSystem"].includes(kind) && normalized.name === undefined) {
      throw invalid(`${label} name is required`);
    }
    if (Object.keys(normalized).length === 0) {
      throw invalid(`${label} must not be empty`);
    }
    return normalized;
  }

  function resourceFields(kind) {
    switch (kind) {
      case "service":
      case "runtime":
      case "framework":
        return ["name", "version"];
      case "deployment":
        return ["environment", "release"];
      case "operatingSystem":
        return ["name", "version", "build"];
      case "device":
        return ["family", "model", "architecture"];
      case "application":
        return ["name", "version", "build"];
      default:
        return [];
    }
  }

  function normalizeTrace(value, label) {
    if (value === undefined) {
      return undefined;
    }
    const trace = requireRecord(value, label);
    rejectUnknownFields(trace, new Set(["traceId", "spanId", "parentSpanId", "sampled"]), label);
    const traceId = normalizedHexId(trace.traceId, TRACE_ID_PATTERN, ZERO_TRACE_ID, `${label} traceId`, 32);
    const normalized = { traceId };
    if (trace.spanId !== undefined) {
      normalized.spanId = normalizedHexId(trace.spanId, SPAN_ID_PATTERN, ZERO_SPAN_ID, `${label} spanId`, 16);
    }
    if (trace.parentSpanId !== undefined) {
      normalized.parentSpanId = normalizedHexId(
        trace.parentSpanId,
        SPAN_ID_PATTERN,
        ZERO_SPAN_ID,
        `${label} parentSpanId`,
        16
      );
    }
    if (trace.sampled !== undefined) {
      if (typeof trace.sampled !== "boolean") {
        throw invalid(`${label} sampled must be a boolean`);
      }
      normalized.sampled = trace.sampled;
    }
    return normalized;
  }

  function normalizeSession(value, label) {
    if (value === undefined) {
      return undefined;
    }
    const session = requireRecord(value, label);
    rejectUnknownFields(session, new Set(["id", "previousId"]), label);
    const id = boundedString(session.id, `${label} id`, MAX_CONTEXT_ID_LENGTH);
    const normalized = { id };
    if (session.previousId !== undefined) {
      normalized.previousId = boundedString(session.previousId, `${label} previousId`, MAX_CONTEXT_ID_LENGTH);
      if (normalized.previousId === id) {
        throw invalid(`${label} previousId must differ from id`);
      }
    }
    return normalized;
  }

  function normalizeSubject(value, label) {
    if (value === undefined) {
      return undefined;
    }
    const subject = requireRecord(value, label);
    rejectUnknownFields(subject, new Set(["id", "kind"]), label);
    const id = boundedString(subject.id, `${label} id`, MAX_CONTEXT_ID_LENGTH);
    if (subject.kind !== "anonymous" && subject.kind !== "user") {
      throw invalid(`${label} kind must be anonymous or user`);
    }
    return { id, kind: subject.kind };
  }

  function normalizeTags(value, label) {
    if (value === undefined) {
      return undefined;
    }
    const tags = requireRecord(value, label);
    const entries = Object.entries(tags).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (entries.length === 0 || entries.length > MAX_CONTEXT_TAGS) {
      throw invalid(`${label} must contain 1-${MAX_CONTEXT_TAGS} entries`);
    }
    const normalized = {};
    for (const [key, tagValue] of entries) {
      if (key.length > MAX_CONTEXT_TAG_KEY_LENGTH || !TAG_KEY_PATTERN.test(key)) {
        throw invalid(`${label} key is invalid`);
      }
      normalized[key] = boundedString(tagValue, `${label} value for ${key}`, MAX_CONTEXT_TAG_VALUE_LENGTH);
    }
    return normalized;
  }

  function boundedString(value, label, maxLength = MAX_CONTEXT_STRING_LENGTH) {
    if (typeof value !== "string") {
      throw invalid(`${label} must be a string`);
    }
    const normalized = value.trim();
    if (!normalized
      || Array.from(normalized).length > maxLength
      || Array.from(normalized).some((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && (code <= 31 || (code >= 127 && code <= 159));
      })) {
      throw invalid(`${label} is invalid`);
    }
    return normalized;
  }

  function normalizedHexId(value, pattern, zeroValue, label, width) {
    if (typeof value !== "string" || !pattern.test(value) || value.toLowerCase() === zeroValue) {
      throw invalid(`${label} must be ${width} non-zero hex characters`);
    }
    return value.toLowerCase();
  }

  function mergeResources(base, override) {
    if (base === undefined) {
      return override;
    }
    if (override === undefined) {
      return base;
    }
    const merged = {};
    for (const key of RESOURCE_KEYS) {
      const baseSection = base[key];
      const overrideSection = override[key];
      if (baseSection !== undefined || overrideSection !== undefined) {
        merged[key] = { ...(baseSection ?? {}), ...(overrideSection ?? {}) };
      }
    }
    return merged;
  }

  return { cloneTelemetryContext, mergeTelemetryContexts, validateTelemetryContext };
}

module.exports = { buildTelemetryContextHelpers };
