"use strict";

const MAX_ISSUE_BREADCRUMBS = 64;
const MAX_EXCEPTION_TYPE_LENGTH = 256;
const MAX_MECHANISM_TYPE_LENGTH = 64;
const MAX_BREADCRUMB_NAME_LENGTH = 64;
const MAX_BREADCRUMB_MESSAGE_LENGTH = 512;
const MAX_BREADCRUMB_DATA_FIELDS = 8;
const MAX_BREADCRUMB_DATA_STRING_LENGTH = 256;
const MACHINE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
const DATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
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

function buildIssueDiagnosticsHelpers({ SdkError, requireTimestamp }) {
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
    const breadcrumbs = validateIssueBreadcrumbs(attributes.breadcrumbs);
    if (
      attributes.breadcrumbsTruncated !== undefined
      && typeof attributes.breadcrumbsTruncated !== "boolean"
    ) {
      throw validationError("issue breadcrumbsTruncated must be a boolean");
    }
    return {
      ...(exception === undefined ? {} : { exception }),
      ...(breadcrumbs === undefined ? {} : { breadcrumbs }),
      ...(attributes.breadcrumbsTruncated === true ? { breadcrumbsTruncated: true } : {})
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
    if (Array.isArray(attributes.breadcrumbs)) {
      diagnostics.breadcrumbs = attributes.breadcrumbs.map((breadcrumb) => ({
        ...breadcrumb,
        ...(breadcrumb.data === undefined ? {} : { data: { ...breadcrumb.data } })
      }));
    }
    if (attributes.breadcrumbsTruncated === true) {
      diagnostics.breadcrumbsTruncated = true;
    }
    return diagnostics;
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
    if (typeof value !== "string" || value.trim() === "") {
      throw validationError(`${label} must be non-empty`);
    }
    if (
      Array.from(value).length > maxLength
      || hasControlCharacter(value)
      || (rejectLocationText && /[?#]/u.test(value))
    ) {
      throw validationError(`${label} is invalid or exceeds ${maxLength} characters`);
    }
    return value;
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
    cloneIssueDiagnostics,
    createIssueException,
    validateIssueBreadcrumb,
    validateIssueDiagnostics
  };
}

module.exports = { buildIssueDiagnosticsHelpers };
