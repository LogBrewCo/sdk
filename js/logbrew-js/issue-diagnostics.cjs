"use strict";

const MAX_ISSUE_BREADCRUMBS = 64;
const MAX_ISSUE_EXCEPTIONS = 8;
const MAX_EXCEPTION_TYPE_LENGTH = 256;
const MAX_EXCEPTION_MESSAGE_LENGTH = 1024;
const MAX_EXCEPTION_MODULE_LENGTH = 512;
const MAX_MECHANISM_TYPE_LENGTH = 64;
const MAX_BREADCRUMB_NAME_LENGTH = 64;
const MAX_BREADCRUMB_MESSAGE_LENGTH = 512;
const MAX_BREADCRUMB_DATA_FIELDS = 8;
const MAX_BREADCRUMB_DATA_STRING_LENGTH = 256;
const MAX_DIAGNOSTIC_IDENTITY_LENGTH = 256;
const MAX_DIAGNOSTIC_CAUSE_LENGTH = 1024;
const MAX_DIAGNOSTIC_OUTCOME_LENGTH = 512;
const MAX_DIAGNOSTIC_FIELDS = 32;
const MACHINE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
const DATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const EVIDENCE_FIELD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const BREADCRUMB_LEVEL_ALIASES = new Map([
  ["trace", "debug"],
  ["debug", "debug"],
  ["info", "info"],
  ["log", "info"],
  ["warn", "warning"],
  ["warning", "warning"],
  ["error", "error"],
  ["fatal", "critical"],
  ["critical", "critical"]
]);

function buildIssueDiagnosticsHelpers({ SdkError, requireTimestamp, validateIssueStackFrames }) {
  function validationError(message) {
    return new SdkError("validation_error", message);
  }

  function validateIssueException(exception) {
    if (exception === undefined) {
      return undefined;
    }
    requireObject("issue exception", exception);
    rejectUnknownKeys("issue exception", exception, new Set(["type", "mechanism"]));
    const type = boundedText("issue exception type", exception.type, MAX_EXCEPTION_TYPE_LENGTH, {
      rejectLocationText: true
    });
    const mechanism = validateIssueExceptionMechanism(exception.mechanism);
    return {
      type,
      ...(mechanism === undefined ? {} : { mechanism })
    };
  }

  function validateIssueExceptionMechanism(mechanism) {
    if (mechanism === undefined) {
      return undefined;
    }
    requireObject("issue exception mechanism", mechanism);
    rejectUnknownKeys(
      "issue exception mechanism",
      mechanism,
      new Set(["type", "handled"])
    );
    if (typeof mechanism.type !== "string" || !MACHINE_NAME_PATTERN.test(mechanism.type)) {
      throw validationError(
        `issue exception mechanism type must match ${MACHINE_NAME_PATTERN}`
      );
    }
    if (Array.from(mechanism.type).length > MAX_MECHANISM_TYPE_LENGTH) {
      throw validationError(
        `issue exception mechanism type must be at most ${MAX_MECHANISM_TYPE_LENGTH} characters`
      );
    }
    if (typeof mechanism.handled !== "boolean") {
      throw validationError("issue exception mechanism handled must be a boolean");
    }
    return { type: mechanism.type, handled: mechanism.handled };
  }

  function createIssueException(type, mechanism, handled) {
    return validateIssueException({
      type,
      mechanism: { type: mechanism, handled }
    });
  }

  function validateIssueExceptionChain(chain, legacyException, legacyStackFrames) {
    if (chain === undefined) {
      return undefined;
    }
    requireObject("issue exceptionChain", chain);
    rejectUnknownKeys("issue exceptionChain", chain, new Set(["entries", "truncated"]));
    if (!Array.isArray(chain.entries)
      || chain.entries.length < 1
      || chain.entries.length > MAX_ISSUE_EXCEPTIONS) {
      throw validationError(
        `issue exceptionChain entries must contain 1-${MAX_ISSUE_EXCEPTIONS} exceptions`
      );
    }
    if (typeof chain.truncated !== "boolean") {
      throw validationError("issue exceptionChain truncated must be a boolean");
    }
    const entries = chain.entries.map((entry, index) => validateIssueExceptionChainEntry(entry, index));
    const reportedException = {
      type: entries[0].type,
      ...(entries[0].mechanism === undefined ? {} : { mechanism: entries[0].mechanism })
    };
    if (legacyException === undefined
      || JSON.stringify(reportedException) !== JSON.stringify(legacyException)) {
      throw validationError("issue exceptionChain reported exception must match exception");
    }
    const reportedFrames = entries[0].stackFrames;
    const canonicalLegacyFrames = validateIssueStackFrames(legacyStackFrames);
    if (entries[0].stackFramesState === "not_captured") {
      if (canonicalLegacyFrames !== undefined) {
        throw validationError("issue exceptionChain reported stack must match stackFrames");
      }
    } else if (JSON.stringify(reportedFrames) !== JSON.stringify(canonicalLegacyFrames)) {
      throw validationError("issue exceptionChain reported stack must match stackFrames");
    }
    return {
      entries,
      truncated: chain.truncated
    };
  }

  function validateIssueExceptionChainEntry(entry, index) {
    requireObject(`issue exceptionChain entry ${index}`, entry);
    rejectUnknownKeys(
      `issue exceptionChain entry ${index}`,
      entry,
      new Set([
        "id",
        "parentId",
        "relationship",
        "type",
        "message",
        "messageState",
        "module",
        "mechanism",
        "stackFrames",
        "stackFramesState"
      ])
    );
    if (!Number.isInteger(entry.id) || entry.id !== index) {
      throw validationError(`issue exceptionChain entry ${index} id must equal its array index`);
    }
    const relationship = entry.relationship;
    const parentId = entry.parentId;
    if (index === 0) {
      if (relationship !== "reported" || parentId !== undefined) {
        throw validationError("issue exceptionChain entry 0 must be the parentless reported exception");
      }
    } else if (!new Set(["cause", "context", "aggregate_member", "suppressed"]).has(relationship)
      || !Number.isInteger(parentId)
      || parentId < 0
      || parentId >= index) {
      throw validationError(`issue exceptionChain entry ${index} parent relationship is invalid`);
    }
    const type = boundedText(
      `issue exceptionChain entry ${index} type`,
      entry.type,
      MAX_EXCEPTION_TYPE_LENGTH,
      { rejectLocationText: true }
    );
    const messageState = entry.messageState;
    if (!new Set(["captured", "truncated", "redacted", "not_captured"]).has(messageState)) {
      throw validationError(`issue exceptionChain entry ${index} messageState is invalid`);
    }
    const message = entry.message === undefined
      ? undefined
      : boundedText(
          `issue exceptionChain entry ${index} message`,
          entry.message,
          MAX_EXCEPTION_MESSAGE_LENGTH
        );
    if ((messageState === "captured" || messageState === "truncated") !== (message !== undefined)) {
      throw validationError(`issue exceptionChain entry ${index} message does not match messageState`);
    }
    const moduleName = entry.module === undefined
      ? undefined
      : boundedText(
          `issue exceptionChain entry ${index} module`,
          entry.module,
          MAX_EXCEPTION_MODULE_LENGTH,
          { rejectLocationText: true }
        );
    const mechanism = validateIssueExceptionMechanism(entry.mechanism);
    const stackFramesState = entry.stackFramesState;
    if (!new Set(["captured", "truncated", "not_captured"]).has(stackFramesState)) {
      throw validationError(`issue exceptionChain entry ${index} stackFramesState is invalid`);
    }
    const stackFrames = validateIssueStackFrames(entry.stackFrames);
    if ((stackFramesState === "captured" || stackFramesState === "truncated")
      !== (stackFrames !== undefined)) {
      throw validationError(
        `issue exceptionChain entry ${index} stackFrames do not match stackFramesState`
      );
    }
    return {
      id: entry.id,
      ...(parentId === undefined ? {} : { parentId }),
      relationship,
      type,
      ...(message === undefined ? {} : { message }),
      messageState,
      ...(moduleName === undefined ? {} : { module: moduleName }),
      ...(mechanism === undefined ? {} : { mechanism }),
      ...(stackFrames === undefined ? {} : { stackFrames }),
      stackFramesState
    };
  }

  function validateIssueBreadcrumb(breadcrumb, defaultTimestamp) {
    requireObject("issue breadcrumb", breadcrumb);
    rejectUnknownKeys(
      "issue breadcrumb",
      breadcrumb,
      new Set(["timestamp", "type", "category", "level", "message", "data"])
    );
    const timestamp = breadcrumb.timestamp ?? defaultTimestamp;
    requireTimestamp(timestamp);
    if (typeof breadcrumb.category !== "string" || !MACHINE_NAME_PATTERN.test(breadcrumb.category)) {
      throw validationError(`issue breadcrumb category must match ${MACHINE_NAME_PATTERN}`);
    }
    const type = optionalMachineName("issue breadcrumb type", breadcrumb.type);
    const level = optionalBreadcrumbLevel(breadcrumb.level);
    const message = breadcrumb.message === undefined
      ? undefined
      : boundedText(
          "issue breadcrumb message",
          breadcrumb.message,
          MAX_BREADCRUMB_MESSAGE_LENGTH
        );
    const data = validateBreadcrumbData(breadcrumb.data);
    return {
      timestamp,
      ...(type === undefined ? {} : { type }),
      category: breadcrumb.category,
      ...(level === undefined ? {} : { level }),
      ...(message === undefined ? {} : { message }),
      ...(data === undefined ? {} : { data })
    };
  }

  function validateIssueBreadcrumbs(breadcrumbs) {
    if (breadcrumbs === undefined) {
      return undefined;
    }
    if (!Array.isArray(breadcrumbs) || breadcrumbs.length < 1 || breadcrumbs.length > MAX_ISSUE_BREADCRUMBS) {
      throw validationError(
        `issue breadcrumbs must contain 1-${MAX_ISSUE_BREADCRUMBS} entries`
      );
    }
    return breadcrumbs.map((breadcrumb) => validateIssueBreadcrumb(breadcrumb));
  }

  function validateIssueDiagnostics(attributes) {
    const exception = validateIssueException(attributes.exception);
    const exceptionChain = validateIssueExceptionChain(
      attributes.exceptionChain,
      exception,
      attributes.stackFrames
    );
    const breadcrumbs = validateIssueBreadcrumbs(attributes.breadcrumbs);
    const evidence = validateIssueEvidence(attributes.evidence);
    if (
      attributes.breadcrumbsTruncated !== undefined
      && typeof attributes.breadcrumbsTruncated !== "boolean"
    ) {
      throw validationError("issue breadcrumbsTruncated must be a boolean");
    }
    return {
      ...(exception === undefined ? {} : { exception }),
      ...(exceptionChain === undefined ? {} : { exceptionChain }),
      ...(breadcrumbs === undefined ? {} : { breadcrumbs }),
      ...(attributes.breadcrumbsTruncated === true ? { breadcrumbsTruncated: true } : {}),
      ...(evidence === undefined ? {} : { evidence })
    };
  }

  function cloneIssueDiagnostics(attributes) {
    const diagnostics = {};
    if (attributes.exception !== undefined) {
      diagnostics.exception = {
        ...attributes.exception,
        ...(attributes.exception.mechanism === undefined
          ? {}
          : { mechanism: { ...attributes.exception.mechanism } })
      };
    }
    if (attributes.exceptionChain !== undefined) {
      diagnostics.exceptionChain = {
        entries: attributes.exceptionChain.entries.map((entry) => ({
          ...entry,
          ...(entry.mechanism === undefined
            ? {}
            : { mechanism: { ...entry.mechanism } }),
          ...(entry.stackFrames === undefined
            ? {}
            : { stackFrames: entry.stackFrames.map((frame) => ({ ...frame })) })
        })),
        truncated: attributes.exceptionChain.truncated
      };
    }
    if (Array.isArray(attributes.breadcrumbs)) {
      diagnostics.breadcrumbs = attributes.breadcrumbs.map((breadcrumb) => ({
        ...breadcrumb,
        ...(breadcrumb.data === undefined ? {} : { data: { ...breadcrumb.data } })
      }));
    }
    if (attributes.breadcrumbsTruncated === true) {
      diagnostics.breadcrumbsTruncated = true;
    }
    if (attributes.evidence !== undefined) {
      diagnostics.evidence = cloneIssueEvidence(attributes.evidence);
    }
    return diagnostics;
  }

  function validateIssueEvidence(evidence) {
    if (evidence === undefined) {
      return undefined;
    }
    requireObject("issue evidence", evidence);
    const fieldKeys = ["capturedFields", "missingFields", "redactedFields", "truncatedFields"];
    rejectUnknownKeys(
      "issue evidence",
      evidence,
      new Set(["likelyRootCause", "likelyFixArea", "impact", ...fieldKeys])
    );
    const likelyRootCause = evidence.likelyRootCause === undefined
      ? undefined
      : boundedText(
          "issue evidence likelyRootCause",
          evidence.likelyRootCause,
          MAX_DIAGNOSTIC_CAUSE_LENGTH
        ).trim();
    const likelyFixArea = validateLikelyFixArea(evidence.likelyFixArea);
    const impact = validateImpactEvidence(evidence.impact);
    const fieldLists = Object.fromEntries(
      fieldKeys.map((key) => [key, validateEvidenceFields(key, evidence[key])])
    );
    const present = new Set();
    for (const key of fieldKeys) {
      for (const field of fieldLists[key] ?? []) {
        if (present.has(field)) {
          throw validationError(`issue evidence field ${field} has conflicting states`);
        }
        present.add(field);
      }
    }
    const validated = {
      ...(likelyRootCause === undefined ? {} : { likelyRootCause }),
      ...(likelyFixArea === undefined ? {} : { likelyFixArea }),
      ...(impact === undefined ? {} : { impact }),
      ...Object.fromEntries(fieldKeys.flatMap((key) => fieldLists[key] === undefined ? [] : [[key, fieldLists[key]]]))
    };
    if (Object.keys(validated).length === 0) {
      throw validationError("issue evidence must contain at least one field");
    }
    return validated;
  }

  function validateLikelyFixArea(area) {
    if (area === undefined) {
      return undefined;
    }
    requireObject("issue evidence likelyFixArea", area);
    rejectUnknownKeys(
      "issue evidence likelyFixArea",
      area,
      new Set(["component", "module", "function", "file", "line", "column", "inApp"])
    );
    const validated = {};
    for (const key of ["component", "module", "function"]) {
      if (area[key] !== undefined) {
        validated[key] = boundedText(
          `issue evidence likelyFixArea ${key}`,
          area[key],
          MAX_DIAGNOSTIC_IDENTITY_LENGTH,
          { rejectLocationText: true }
        ).trim();
      }
    }
    if (area.file !== undefined) {
      validated.file = safeRelativeSourcePath(area.file);
    }
    for (const key of ["line", "column"]) {
      if (area[key] !== undefined) {
        if (!Number.isInteger(area[key]) || area[key] < 1 || area[key] > 2147483647) {
          throw validationError(`issue evidence likelyFixArea ${key} must be a positive integer`);
        }
        validated[key] = area[key];
      }
    }
    if (area.inApp !== undefined) {
      if (typeof area.inApp !== "boolean") {
        throw validationError("issue evidence likelyFixArea inApp must be a boolean");
      }
      validated.inApp = area.inApp;
    }
    if (!Object.keys(validated).some((key) => key !== "inApp")) {
      throw validationError("issue evidence likelyFixArea must identify a code location");
    }
    return validated;
  }

  function validateImpactEvidence(impact) {
    if (impact === undefined) {
      return undefined;
    }
    requireObject("issue evidence impact", impact);
    rejectUnknownKeys(
      "issue evidence impact",
      impact,
      new Set(["affectedUserSegment", "failedAction", "userVisibleOutcome"])
    );
    const validated = {};
    for (const key of ["affectedUserSegment", "failedAction"]) {
      if (impact[key] !== undefined) {
        validated[key] = boundedText(
          `issue evidence impact ${key}`,
          impact[key],
          MAX_DIAGNOSTIC_IDENTITY_LENGTH,
          { rejectLocationText: true }
        ).trim();
      }
    }
    if (impact.userVisibleOutcome !== undefined) {
      validated.userVisibleOutcome = boundedText(
        "issue evidence impact userVisibleOutcome",
        impact.userVisibleOutcome,
        MAX_DIAGNOSTIC_OUTCOME_LENGTH
      ).trim();
    }
    if (Object.keys(validated).length === 0) {
      throw validationError("issue evidence impact must contain at least one field");
    }
    return validated;
  }

  function validateEvidenceFields(key, fields) {
    if (fields === undefined) {
      return undefined;
    }
    if (!Array.isArray(fields) || fields.length < 1 || fields.length > MAX_DIAGNOSTIC_FIELDS) {
      throw validationError(`issue evidence ${key} must contain 1-${MAX_DIAGNOSTIC_FIELDS} fields`);
    }
    const unique = new Set(fields);
    if (unique.size !== fields.length || fields.some((field) => typeof field !== "string" || !EVIDENCE_FIELD_PATTERN.test(field))) {
      throw validationError(`issue evidence ${key} fields must be unique bounded identifiers`);
    }
    return [...fields];
  }

  function safeRelativeSourcePath(value) {
    const path = boundedText(
      "issue evidence likelyFixArea file",
      value,
      MAX_DIAGNOSTIC_IDENTITY_LENGTH,
      { rejectLocationText: true }
    ).trim().replaceAll("\\", "/");
    const parts = path.split("/");
    if (path.startsWith("/") || /^[A-Za-z]:\//u.test(path) || path.includes("://")
      || parts.some((part) => part === "" || part === "." || part === "..")) {
      throw validationError("issue evidence likelyFixArea file must be a safe relative path");
    }
    return path;
  }

  function cloneIssueEvidence(evidence) {
    return {
      ...evidence,
      ...(evidence.likelyFixArea === undefined ? {} : { likelyFixArea: { ...evidence.likelyFixArea } }),
      ...(evidence.impact === undefined ? {} : { impact: { ...evidence.impact } }),
      ...Object.fromEntries(
        ["capturedFields", "missingFields", "redactedFields", "truncatedFields"]
          .flatMap((key) => evidence[key] === undefined ? [] : [[key, [...evidence[key]]]])
      )
    };
  }

  function validateBreadcrumbData(data) {
    if (data === undefined) {
      return undefined;
    }
    requireObject("issue breadcrumb data", data);
    const entries = Object.entries(data);
    if (entries.length > MAX_BREADCRUMB_DATA_FIELDS) {
      throw validationError(
        `issue breadcrumb data must contain at most ${MAX_BREADCRUMB_DATA_FIELDS} fields`
      );
    }
    const validated = {};
    for (const [key, value] of entries) {
      if (!DATA_KEY_PATTERN.test(key)) {
        throw validationError(`issue breadcrumb data key must match ${DATA_KEY_PATTERN}`);
      }
      if (typeof value === "string") {
        validated[key] = boundedText(
          `issue breadcrumb data value for ${key}`,
          value,
          MAX_BREADCRUMB_DATA_STRING_LENGTH
        );
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          throw validationError(`issue breadcrumb data value for ${key} must be finite`);
        }
        validated[key] = value;
      } else if (typeof value === "boolean" || value === null) {
        validated[key] = value;
      } else {
        throw validationError(
          `issue breadcrumb data value for ${key} must be a string, number, boolean, or null`
        );
      }
    }
    return validated;
  }

  function optionalMachineName(label, value) {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string" || !MACHINE_NAME_PATTERN.test(value)) {
      throw validationError(`${label} must match ${MACHINE_NAME_PATTERN}`);
    }
    if (Array.from(value).length > MAX_BREADCRUMB_NAME_LENGTH) {
      throw validationError(`${label} must be at most ${MAX_BREADCRUMB_NAME_LENGTH} characters`);
    }
    return value;
  }

  function optionalBreadcrumbLevel(value) {
    if (value === undefined) {
      return undefined;
    }
    const normalized = typeof value === "string" ? BREADCRUMB_LEVEL_ALIASES.get(value) : undefined;
    if (normalized === undefined) {
      throw validationError(
        `issue breadcrumb level must be one of: ${Array.from(BREADCRUMB_LEVEL_ALIASES.keys()).join(", ")}`
      );
    }
    return normalized;
  }

  function boundedText(label, value, maxLength, { rejectLocationText = false } = {}) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized === "") {
      throw validationError(`${label} must be non-empty`);
    }
    if (
      Array.from(normalized).length > maxLength
      || hasControlCharacter(normalized)
      || (rejectLocationText && /[?#]/u.test(normalized))
    ) {
      throw validationError(`${label} is invalid or exceeds ${maxLength} characters`);
    }
    return normalized;
  }

  function requireObject(label, value) {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw validationError(`${label} must be an object`);
    }
  }

  function rejectUnknownKeys(label, value, allowed) {
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw validationError(`${label} has unsupported fields: ${unknown.sort().join(", ")}`);
    }
  }

  function hasControlCharacter(value) {
    return Array.from(value).some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 31 || (code >= 127 && code <= 159));
    });
  }

  return {
    MAX_ISSUE_BREADCRUMBS,
    MAX_ISSUE_EXCEPTIONS,
    cloneIssueDiagnostics,
    createIssueException,
    validateIssueBreadcrumb,
    validateIssueDiagnostics,
    validateIssueEvidence
  };
}

module.exports = { buildIssueDiagnosticsHelpers };
