"use strict";

const { SdkError } = require("./sdk-error.cjs");
const { boundedIdentity, optionalText } = require("./issue-text.cjs");
const { optionalEntry, rejectUnknownKeys, requireObject } = require("./validation.cjs");

/**
 * @import { IssueDiagnosticEvidence, IssueImpactEvidence, IssueLikelyFixArea } from "./index.cjs"
 * @import { DeepReadonly } from "./validation.cjs"
 * @typedef {"capturedFields" | "missingFields" | "redactedFields" | "truncatedFields"} EvidenceFieldKey
 * @typedef {Pick<IssueDiagnosticEvidence, EvidenceFieldKey>} EvidenceFieldLists
 */

const MAX_DIAGNOSTIC_IDENTITY_LENGTH = 256;
const MAX_DIAGNOSTIC_CAUSE_LENGTH = 1024;
const MAX_DIAGNOSTIC_OUTCOME_LENGTH = 512;
const MAX_DIAGNOSTIC_FIELDS = 32;
const MIN_DIAGNOSTIC_FIELDS = 1;
const MIN_COORDINATE = 1;
const MAX_COORDINATE = 2_147_483_647;
const NO_FIELDS = 0;
const EVIDENCE_FIELD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:\//u;
/** @type {readonly EvidenceFieldKey[]} */
const EVIDENCE_FIELD_KEYS = ["capturedFields", "missingFields", "redactedFields", "truncatedFields"];
const EVIDENCE_KEYS = new Set(["likelyRootCause", "likelyFixArea", "impact", ...EVIDENCE_FIELD_KEYS]);
const FIX_AREA_KEYS = new Set(["component", "module", "function", "file", "line", "column", "inApp"]);
const IMPACT_KEYS = new Set(["affectedUserSegment", "failedAction", "userVisibleOutcome"]);
/** @type {readonly ["component", "module", "function"]} */
const FIX_AREA_IDENTITY_KEYS = ["component", "module", "function"];
/** @type {readonly ["affectedUserSegment", "failedAction"]} */
const IMPACT_IDENTITY_KEYS = ["affectedUserSegment", "failedAction"];

/**
 * @template {string} Field
 * @param {Readonly<Record<string, unknown>>} source
 * @param {readonly Field[]} fields
 * @param {string} label
 * @returns {{ [Key in Field]?: string }}
 */
function identityFields(source, fields, label) {
  /** @type {{ [Key in Field]?: string }} */
  const validated = {};
  for (const field of fields) {
    const value = source[field];
    if (value !== undefined) {
      validated[field] = boundedIdentity(`${label} ${field}`, value, MAX_DIAGNOSTIC_IDENTITY_LENGTH);
    }
  }
  return validated;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeRelativeSourcePath(value) {
  const path = boundedIdentity("issue evidence likelyFixArea file", value, MAX_DIAGNOSTIC_IDENTITY_LENGTH).replaceAll("\\", "/");
  if (
    path.startsWith("/")
    || WINDOWS_DRIVE_PATTERN.test(path)
    || path.includes("://")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new SdkError("validation_error", "issue evidence likelyFixArea file must be a safe relative path");
  }
  return path;
}

/**
 * @param {"line" | "column"} key
 * @param {unknown} value
 * @returns {number | undefined}
 */
function optionalCoordinate(key, value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_COORDINATE || value > MAX_COORDINATE) {
    throw new SdkError("validation_error", `issue evidence likelyFixArea ${key} must be a positive integer`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
function optionalInApp(value) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new SdkError("validation_error", "issue evidence likelyFixArea inApp must be a boolean");
  }
  return value;
}

/**
 * @param {Readonly<Record<string, unknown>>} source
 * @returns {Omit<IssueLikelyFixArea, "inApp">}
 */
function fixAreaLocation(source) {
  const identities = identityFields(source, FIX_AREA_IDENTITY_KEYS, "issue evidence likelyFixArea");
  const file = source["file"] === undefined ? undefined : safeRelativeSourcePath(source["file"]);
  const line = optionalCoordinate("line", source["line"]);
  const column = optionalCoordinate("column", source["column"]);
  return {
    ...identities,
    ...optionalEntry("file", file),
    ...optionalEntry("line", line),
    ...optionalEntry("column", column)
  };
}

/**
 * @param {unknown} area
 * @returns {IssueLikelyFixArea | undefined}
 */
function validateLikelyFixArea(area) {
  if (area === undefined) {
    return undefined;
  }
  const source = requireObject("issue evidence likelyFixArea", area);
  rejectUnknownKeys("issue evidence likelyFixArea", source, FIX_AREA_KEYS);
  const location = fixAreaLocation(source);
  const inApp = optionalInApp(source["inApp"]);
  if (Object.keys(location).length === NO_FIELDS) {
    throw new SdkError("validation_error", "issue evidence likelyFixArea must identify a code location");
  }
  return { ...location, ...optionalEntry("inApp", inApp) };
}

/**
 * @param {unknown} impact
 * @returns {IssueImpactEvidence | undefined}
 */
function validateImpactEvidence(impact) {
  if (impact === undefined) {
    return undefined;
  }
  const source = requireObject("issue evidence impact", impact);
  rejectUnknownKeys("issue evidence impact", source, IMPACT_KEYS);
  const validated = {
    ...identityFields(source, IMPACT_IDENTITY_KEYS, "issue evidence impact"),
    ...optionalEntry(
      "userVisibleOutcome",
      optionalText("issue evidence impact userVisibleOutcome", source["userVisibleOutcome"], MAX_DIAGNOSTIC_OUTCOME_LENGTH)
    )
  };
  if (Object.keys(validated).length === NO_FIELDS) {
    throw new SdkError("validation_error", "issue evidence impact must contain at least one field");
  }
  return validated;
}

/**
 * @param {unknown} field
 * @returns {field is string}
 */
function isEvidenceField(field) {
  return typeof field === "string" && EVIDENCE_FIELD_PATTERN.test(field);
}

/**
 * @param {EvidenceFieldKey} key
 * @param {unknown} fields
 * @returns {string[] | undefined}
 */
function validateEvidenceFields(key, fields) {
  if (fields === undefined) {
    return undefined;
  }
  if (!Array.isArray(fields) || fields.length < MIN_DIAGNOSTIC_FIELDS || fields.length > MAX_DIAGNOSTIC_FIELDS) {
    throw new SdkError("validation_error", `issue evidence ${key} must contain 1-${MAX_DIAGNOSTIC_FIELDS} fields`);
  }
  /** @type {readonly unknown[]} */
  const list = fields;
  const identifiers = list.filter((field) => isEvidenceField(field));
  if (new Set(list).size !== list.length || identifiers.length !== list.length) {
    throw new SdkError("validation_error", `issue evidence ${key} fields must be unique bounded identifiers`);
  }
  return identifiers;
}

/**
 * @param {DeepReadonly<EvidenceFieldLists>} lists
 * @returns {void}
 */
function rejectConflictingFields(lists) {
  const present = new Set();
  for (const field of Object.values(lists).flat()) {
    if (present.has(field)) {
      throw new SdkError("validation_error", `issue evidence field ${field} has conflicting states`);
    }
    present.add(field);
  }
}

/**
 * @param {Readonly<Record<string, unknown>>} source
 * @returns {EvidenceFieldLists}
 */
function evidenceFieldLists(source) {
  /** @type {EvidenceFieldLists} */
  const lists = {};
  for (const key of EVIDENCE_FIELD_KEYS) {
    const fields = validateEvidenceFields(key, source[key]);
    if (fields !== undefined) {
      lists[key] = fields;
    }
  }
  rejectConflictingFields(lists);
  return lists;
}

/**
 * @param {unknown} evidence
 * @returns {IssueDiagnosticEvidence | undefined}
 */
function validateIssueEvidence(evidence) {
  if (evidence === undefined) {
    return undefined;
  }
  const source = requireObject("issue evidence", evidence);
  rejectUnknownKeys("issue evidence", source, EVIDENCE_KEYS);
  const validated = {
    ...optionalEntry(
      "likelyRootCause",
      optionalText("issue evidence likelyRootCause", source["likelyRootCause"], MAX_DIAGNOSTIC_CAUSE_LENGTH)
    ),
    ...optionalEntry("likelyFixArea", validateLikelyFixArea(source["likelyFixArea"])),
    ...optionalEntry("impact", validateImpactEvidence(source["impact"])),
    ...evidenceFieldLists(source)
  };
  if (Object.keys(validated).length === NO_FIELDS) {
    throw new SdkError("validation_error", "issue evidence must contain at least one field");
  }
  return validated;
}

/**
 * @param {DeepReadonly<IssueDiagnosticEvidence>} evidence
 * @returns {DeepReadonly<IssueDiagnosticEvidence>}
 */
function cloneIssueEvidence(evidence) {
  const { capturedFields, impact, likelyFixArea, missingFields, redactedFields, truncatedFields } = evidence;
  return {
    ...evidence,
    ...optionalEntry("likelyFixArea", likelyFixArea === undefined ? undefined : { ...likelyFixArea }),
    ...optionalEntry("impact", impact === undefined ? undefined : { ...impact }),
    ...optionalEntry("capturedFields", capturedFields === undefined ? undefined : [...capturedFields]),
    ...optionalEntry("missingFields", missingFields === undefined ? undefined : [...missingFields]),
    ...optionalEntry("redactedFields", redactedFields === undefined ? undefined : [...redactedFields]),
    ...optionalEntry("truncatedFields", truncatedFields === undefined ? undefined : [...truncatedFields])
  };
}

module.exports = { cloneIssueEvidence, validateIssueEvidence };
