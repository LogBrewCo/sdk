const SUPPORT_TICKET_SOURCES = new Set(["cli", "sdk", "website", "docs", "mobile"]);
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
const SUPPORT_DIAGNOSTICS_MAX_DEPTH = 5;
const SUPPORT_DIAGNOSTICS_MAX_ARRAY_LENGTH = 20;
const SUPPORT_DIAGNOSTICS_MAX_STRING_LENGTH = 500;

function buildCreateSupportTicketDraft({ SdkError, requireAllowedValue, requireNonEmpty, requireTraceId }) {
  return function createSupportTicketDraft(input) {
    if (!input || Array.isArray(input) || typeof input !== "object") {
      throw new SdkError("validation_error", "support ticket draft input must be an object");
    }

    requireAllowedValue("support ticket source", input.source, SUPPORT_TICKET_SOURCES);
    requireAllowedValue("support ticket category", input.category, SUPPORT_TICKET_CATEGORIES);
    const draft = {
      source: input.source,
      category: input.category,
      title: requiredSupportString(requireNonEmpty, "support ticket title", input.title),
      description: requiredSupportString(requireNonEmpty, "support ticket description", input.description)
    };

    addOptionalSupportString(draft, "project_id", "support ticket projectId", input.projectId, requireNonEmpty);
    addOptionalSupportString(draft, "environment", "support ticket environment", input.environment, requireNonEmpty);
    addOptionalSupportString(draft, "runtime", "support ticket runtime", input.runtime, requireNonEmpty);
    addOptionalSupportString(draft, "framework", "support ticket framework", input.framework, requireNonEmpty);
    addOptionalSupportString(draft, "sdk_package", "support ticket sdkPackage", input.sdkPackage, requireNonEmpty);
    addOptionalSupportString(draft, "sdk_version", "support ticket sdkVersion", input.sdkVersion, requireNonEmpty);
    addOptionalSupportString(draft, "release", "support ticket release", input.release, requireNonEmpty);
    if (input.traceId !== undefined) {
      requireTraceId(input.traceId);
      draft.trace_id = input.traceId.toLowerCase();
    }
    addOptionalSupportString(draft, "event_id", "support ticket eventId", input.eventId, requireNonEmpty);
    if (input.diagnostics !== undefined) {
      draft.diagnostics = sanitizeSupportDiagnostics(input.diagnostics, SdkError);
    }

    return draft;
  };
}

function requiredSupportString(requireNonEmpty, label, value) {
  requireNonEmpty(label, value);
  return value.trim();
}

function addOptionalSupportString(target, key, label, value, requireNonEmpty) {
  if (value === undefined) {
    return;
  }
  target[key] = requiredSupportString(requireNonEmpty, label, value);
}

function sanitizeSupportDiagnostics(diagnostics, SdkError) {
  if (!diagnostics || Array.isArray(diagnostics) || typeof diagnostics !== "object") {
    throw new SdkError("validation_error", "support ticket diagnostics must be an object");
  }
  return sanitizeSupportDiagnosticValue(diagnostics, 0, "");
}

function sanitizeSupportDiagnosticValue(value, depth, key) {
  if (isSensitiveSupportKey(key)) {
    return "[redacted]";
  }
  if (value instanceof Error) {
    return { name: value.name || "Error" };
  }
  if (value === null || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeSupportDiagnosticString(value);
  }
  if (Array.isArray(value)) {
    if (depth >= SUPPORT_DIAGNOSTICS_MAX_DEPTH) {
      return "[max-depth]";
    }
    return value
      .slice(0, SUPPORT_DIAGNOSTICS_MAX_ARRAY_LENGTH)
      .map((item) => sanitizeSupportDiagnosticValue(item, depth + 1, ""));
  }
  if (value && typeof value === "object") {
    if (depth >= SUPPORT_DIAGNOSTICS_MAX_DEPTH) {
      return "[max-depth]";
    }
    const safe = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitized = sanitizeSupportDiagnosticValue(childValue, depth + 1, childKey);
      if (sanitized !== undefined) {
        safe[childKey] = sanitized;
      }
    }
    return safe;
  }
  return undefined;
}

function isSensitiveSupportKey(key) {
  if (typeof key !== "string" || key === "") {
    return false;
  }
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return [
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
  ].some((needle) => normalized.includes(needle));
}

function sanitizeSupportDiagnosticString(value) {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }
  if (isSensitiveSupportString(trimmed)) {
    return "[redacted]";
  }
  const pathRedacted = redactLocalPath(trimmed);
  const urlRedacted = redactUrl(pathRedacted);
  return urlRedacted.length > SUPPORT_DIAGNOSTICS_MAX_STRING_LENGTH
    ? `${urlRedacted.slice(0, SUPPORT_DIAGNOSTICS_MAX_STRING_LENGTH)}...`
    : urlRedacted;
}

function isSensitiveSupportString(value) {
  return /(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\s*[:=]/iu.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu.test(value)
    || /\blbw_(?:ingest|client|api)_[A-Za-z0-9._-]+/iu.test(value)
    || /\b(?:github_pat|ghp|gho|npm|pypi|sk_live|sk_test|xox[baprs]|AKIA)[A-Za-z0-9._-]+/u.test(value);
}

function redactLocalPath(value) {
  if (/^(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)/u.test(value)) {
    return "[redacted-path]";
  }
  return value;
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    return `[redacted-url]${url.pathname || "/"}`;
  } catch {
    return value.split(/[?#]/u)[0];
  }
}

module.exports = { buildCreateSupportTicketDraft };
