const { SdkError } = require("./sdk-error.cjs");
const { isRecord, requireAllowedValue, requireNonEmpty, requireTraceId } = require("./validation.cjs");

/**
 * @import { SupportTicketCategory, SupportTicketDraft, SupportTicketSource } from "./index.cjs"
 * @typedef {string | number | boolean | null | undefined | SanitizedDiagnosticsValue[] | SanitizedDiagnostics} SanitizedDiagnosticsValue
 * @typedef {{ [key: string]: SanitizedDiagnosticsValue }} SanitizedDiagnostics
 * @typedef {Omit<SupportTicketDraft, "diagnostics"> & { diagnostics?: SanitizedDiagnostics }} SanitizedSupportTicketDraft
 * @typedef {Omit<SanitizedSupportTicketDraft, "category" | "description" | "source" | "title">} SupportTicketContext
 * @typedef {(child: unknown, childKey: string) => SanitizedDiagnosticsValue} SanitizeChild
 */

/** @type {ReadonlySet<SupportTicketSource>} */
const SUPPORT_TICKET_SOURCES = new Set(["cli", "sdk", "website", "docs", "mobile"]);
/** @type {ReadonlySet<SupportTicketCategory>} */
const SUPPORT_TICKET_CATEGORIES = new Set([
  "sdk_install_failure",
  "ingest_failure",
  "auth_failure",
  "project_setup",
  "dashboard_issue",
  "docs_confusion",
  "cli_issue",
  "mobile_issue",
  "billing_question",
  "other"
]);
const SENSITIVE_KEY_PARTS = [
  "apikey",
  "auth",
  "authorization",
  "authtoken",
  "bearer",
  "clientsecret",
  "connectionstring",
  "cookie",
  "credential",
  "dsn",
  "email",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "session",
  "setcookie",
  "token"
];
const SUPPORT_DIAGNOSTICS_MAX_DEPTH = 5;
const SUPPORT_DIAGNOSTICS_MAX_ARRAY_LENGTH = 20;
const SUPPORT_DIAGNOSTICS_MAX_STRING_LENGTH = 500;
const ROOT_DEPTH = 0;
const DEPTH_STEP = 1;
const TEXT_START = 0;
const KEY_SEPARATOR_PATTERN = /[^a-z0-9]/giu;
const SECRET_ASSIGNMENT_PATTERN = /(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\s*[:=]/iu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu;
const LOGBREW_KEY_PATTERN = /\blbw_(?:ingest|client|api)_[A-Za-z0-9._-]+/iu;
const VENDOR_TOKEN_PATTERN = /\b(?:github_pat|ghp|gho|npm|pypi|sk_live|sk_test|xox[baprs]|AKIA)[A-Za-z0-9._-]+/u;
const LOCAL_PATH_PATTERN = /^(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)/u;
const QUERY_OR_FRAGMENT_PATTERN = /[?#]/u;

/**
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveSupportKey(key) {
  if (key === "") {
    return false;
  }
  const normalized = key.replaceAll(KEY_SEPARATOR_PATTERN, "").toLowerCase();
  return SENSITIVE_KEY_PARTS.some((needle) => normalized.includes(needle));
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isSensitiveSupportString(value) {
  return SECRET_ASSIGNMENT_PATTERN.test(value)
    || BEARER_PATTERN.test(value)
    || LOGBREW_KEY_PATTERN.test(value)
    || VENDOR_TOKEN_PATTERN.test(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactUrl(value) {
  try {
    const url = new URL(value);
    return `[redacted-url]${url.pathname || "/"}`;
  } catch {
    const [beforeQuery = value] = value.split(QUERY_OR_FRAGMENT_PATTERN);
    return beforeQuery;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function sanitizeSupportDiagnosticString(value) {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }
  if (isSensitiveSupportString(trimmed)) {
    return "[redacted]";
  }
  const urlRedacted = redactUrl(LOCAL_PATH_PATTERN.test(trimmed) ? "[redacted-path]" : trimmed);
  return urlRedacted.length > SUPPORT_DIAGNOSTICS_MAX_STRING_LENGTH
    ? `${urlRedacted.slice(TEXT_START, SUPPORT_DIAGNOSTICS_MAX_STRING_LENGTH)}...`
    : urlRedacted;
}

/**
 * @param {Readonly<Error>} error
 * @returns {SanitizedDiagnostics}
 */
function errorDiagnostics(error) {
  return { name: error.name || "Error" };
}

/**
 * @param {unknown} value
 * @returns {SanitizedDiagnosticsValue}
 */
function sanitizeSupportDiagnosticScalar(value) {
  if (value === null || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") {
    return value;
  }
  return typeof value === "string" ? sanitizeSupportDiagnosticString(value) : undefined;
}

/**
 * @param {readonly unknown[]} value
 * @param {SanitizeChild} sanitizeChild
 * @returns {SanitizedDiagnosticsValue[]}
 */
function sanitizeSupportDiagnosticList(value, sanitizeChild) {
  return value.slice(TEXT_START, SUPPORT_DIAGNOSTICS_MAX_ARRAY_LENGTH).map((item) => sanitizeChild(item, ""));
}

/**
 * @param {Readonly<Record<string, unknown>>} value
 * @param {SanitizeChild} sanitizeChild
 * @returns {SanitizedDiagnostics}
 */
function sanitizeSupportDiagnosticRecord(value, sanitizeChild) {
  /** @type {SanitizedDiagnostics} */
  const safe = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = sanitizeChild(childValue, childKey);
    if (sanitized !== undefined) {
      safe[childKey] = sanitized;
    }
  }
  return safe;
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {string} key
 * @returns {SanitizedDiagnosticsValue}
 */
function sanitizeSupportDiagnosticValue(value, depth, key) {
  if (isSensitiveSupportKey(key)) {
    return "[redacted]";
  }
  if (value instanceof Error) {
    return errorDiagnostics(value);
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    return sanitizeSupportDiagnosticScalar(value);
  }
  if (depth >= SUPPORT_DIAGNOSTICS_MAX_DEPTH) {
    return "[max-depth]";
  }
  const childDepth = depth + DEPTH_STEP;
  return isRecord(value)
    ? sanitizeSupportDiagnosticRecord(value, (child, childKey) => sanitizeSupportDiagnosticValue(child, childDepth, childKey))
    : sanitizeSupportDiagnosticList(value, (child, childKey) => sanitizeSupportDiagnosticValue(child, childDepth, childKey));
}

/**
 * @param {unknown} diagnostics
 * @returns {{ diagnostics?: SanitizedDiagnostics }}
 */
function optionalDiagnostics(diagnostics) {
  if (diagnostics === undefined) {
    return {};
  }
  if (!isRecord(diagnostics)) {
    throw new SdkError("validation_error", "support ticket diagnostics must be an object");
  }
  if (diagnostics instanceof Error) {
    return { diagnostics: errorDiagnostics(diagnostics) };
  }
  return {
    diagnostics: sanitizeSupportDiagnosticRecord(
      diagnostics,
      (child, childKey) => sanitizeSupportDiagnosticValue(child, ROOT_DEPTH + DEPTH_STEP, childKey)
    )
  };
}

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {string}
 */
function requiredSupportString(label, value) {
  return requireNonEmpty(label, value).trim();
}

/**
 * @template {string} Key
 * @param {Key} key
 * @param {string} label
 * @param {unknown} value
 * @returns {{ [Field in Key]?: string }}
 */
function optionalSupportString(key, label, value) {
  /** @type {{ [Field in Key]?: string }} */
  const field = {};
  if (value !== undefined) {
    field[key] = requiredSupportString(label, value);
  }
  return field;
}

/**
 * @param {unknown} traceId
 * @returns {{ trace_id?: string }}
 */
function optionalTraceId(traceId) {
  return traceId === undefined ? {} : { trace_id: requireTraceId(traceId).toLowerCase() };
}

/**
 * @param {Readonly<Record<string, unknown>>} input
 * @returns {SupportTicketContext}
 */
function supportTicketContext(input) {
  return {
    ...optionalSupportString("project_id", "support ticket projectId", input["projectId"]),
    ...optionalSupportString("environment", "support ticket environment", input["environment"]),
    ...optionalSupportString("runtime", "support ticket runtime", input["runtime"]),
    ...optionalSupportString("framework", "support ticket framework", input["framework"]),
    ...optionalSupportString("sdk_package", "support ticket sdkPackage", input["sdkPackage"]),
    ...optionalSupportString("sdk_version", "support ticket sdkVersion", input["sdkVersion"]),
    ...optionalSupportString("release", "support ticket release", input["release"]),
    ...optionalTraceId(input["traceId"]),
    ...optionalSupportString("event_id", "support ticket eventId", input["eventId"]),
    ...optionalDiagnostics(input["diagnostics"])
  };
}

/**
 * @param {unknown} input
 * @returns {SanitizedSupportTicketDraft}
 */
function createSupportTicketDraft(input) {
  if (!isRecord(input)) {
    throw new SdkError("validation_error", "support ticket draft input must be an object");
  }
  const source = requireAllowedValue("support ticket source", input["source"], SUPPORT_TICKET_SOURCES);
  const category = requireAllowedValue("support ticket category", input["category"], SUPPORT_TICKET_CATEGORIES);
  const title = requiredSupportString("support ticket title", input["title"]);
  const description = requiredSupportString("support ticket description", input["description"]);
  return {
    source,

    category,
    title,

    description,
    ...supportTicketContext(input)
  };
}

module.exports = { createSupportTicketDraft };
