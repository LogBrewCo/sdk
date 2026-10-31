const { withMetadata } = require("./event-metadata.cjs");
const { validateIssueDiagnostics } = require("./issue-diagnostics.cjs");
const { validateIssueStackFrames, validateNativeStackFrames } = require("./issue-stack.cjs");
const { validateMetric } = require("./metric-validation.cjs");
const { validateSpan } = require("./span-validation.cjs");
const { optionalEntry, requireAllowedValue, requireNonEmpty } = require("./validation.cjs");

/**
 * @import {
 *   ActionAttributes,
 *   IssueStackFrame,
 *   NativeStackFrame,
 *   Severity,
 *   SeverityInput,
 *   SpanEventSummary,
 *   SpanLinkSummary,
 *   TelemetryContext
 * } from "./index.cjs"
 * @import { IssueDiagnostics } from "./issue-diagnostics.cjs"
 * @typedef {"release" | "environment" | "issue" | "log" | "span" | "action" | "metric"} EventType
 * @typedef {IssueDiagnostics & {
 *   [key: string]: unknown,
 *   context?: TelemetryContext,
 *   events?: SpanEventSummary[],
 *   links?: SpanLinkSummary[],
 *   metadata?: Record<string, unknown>,
 *   nativeStackFrames?: NativeStackFrame[],
 *   stackFrames?: IssueStackFrame[]
 * }} EventAttributes
 * @typedef {{ type: EventType, id: string, timestamp: string, attributes: EventAttributes }} SdkEvent
 * @typedef {(attributes: Readonly<Record<string, unknown>>) => EventAttributes} EventValidator
 */

/** @type {ReadonlyMap<SeverityInput, Severity>} */
const SEVERITY_ALIASES = new Map([
  ["trace", "info"],
  ["debug", "info"],
  ["info", "info"],
  ["warn", "warning"],
  ["warning", "warning"],
  ["error", "error"],
  ["fatal", "critical"],
  ["critical", "critical"]
]);
const SEVERITY_VALUES = new Set(SEVERITY_ALIASES.keys());
/** @type {ReadonlySet<ActionAttributes["status"]>} */
const ACTION_STATUSES = new Set(["queued", "running", "success", "failure"]);

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {Severity}
 */
function normalizeSeverity(label, value) {
  const severity = requireAllowedValue(label, value, SEVERITY_VALUES);
  return SEVERITY_ALIASES.get(severity) ?? "info";
}

/**
 * @param {Readonly<Record<string, unknown>>} attributes
 * @returns {EventAttributes}
 */
function validateRelease(attributes) {
  const version = requireNonEmpty("release version", attributes["version"]);
  const commit = attributes["commit"] === undefined ? undefined : requireNonEmpty("release commit", attributes["commit"]);
  return withMetadata({
    version,
    ...optionalEntry("commit", commit),
    ...optionalEntry("notes", attributes["notes"])
  }, attributes["metadata"], attributes["context"]);
}

/**
 * @param {Readonly<Record<string, unknown>>} attributes
 * @returns {EventAttributes}
 */
function validateEnvironment(attributes) {
  const name = requireNonEmpty("environment name", attributes["name"]);
  return withMetadata({
    name,
    ...optionalEntry("region", attributes["region"])
  }, attributes["metadata"], attributes["context"]);
}

/**
 * @param {Readonly<Record<string, unknown>>} attributes
 * @returns {EventAttributes}
 */
function validateIssue(attributes) {
  const title = requireNonEmpty("issue title", attributes["title"]);
  const level = normalizeSeverity("issue level", attributes["level"]);
  const stackFrames = validateIssueStackFrames(attributes["stackFrames"]);
  const nativeStackFrames = validateNativeStackFrames(attributes["nativeStackFrames"]);
  return withMetadata({
    title,

    level,
    ...optionalEntry("message", attributes["message"]),
    ...optionalEntry("stackFrames", stackFrames),
    ...optionalEntry("nativeStackFrames", nativeStackFrames),
    ...validateIssueDiagnostics(attributes)
  }, attributes["metadata"], attributes["context"]);
}

/**
 * @param {Readonly<Record<string, unknown>>} attributes
 * @returns {EventAttributes}
 */
function validateLog(attributes) {
  const message = requireNonEmpty("log message", attributes["message"]);
  const level = normalizeSeverity("log level", attributes["level"]);
  return withMetadata({
    message,

    level,
    ...optionalEntry("logger", attributes["logger"])
  }, attributes["metadata"], attributes["context"]);
}

/**
 * @param {Readonly<Record<string, unknown>>} attributes
 * @returns {EventAttributes}
 */
function validateAction(attributes) {
  const name = requireNonEmpty("action name", attributes["name"]);
  const status = requireAllowedValue("action status", attributes["status"], ACTION_STATUSES);
  return withMetadata({ name, status }, attributes["metadata"], attributes["context"]);
}

/** @type {ReadonlyMap<string, EventValidator>} */
const EVENT_VALIDATORS = new Map([
  ["release", validateRelease],
  ["environment", validateEnvironment],
  ["issue", validateIssue],
  ["log", validateLog],
  ["span", validateSpan],
  ["action", validateAction],
  ["metric", validateMetric]
]);

/**
 * @param {unknown} type
 * @returns {type is EventType}
 */
function isEventType(type) {
  return typeof type === "string" && EVENT_VALIDATORS.has(type);
}

module.exports = {
  ACTION_STATUSES,
  EVENT_VALIDATORS,
  isEventType,
  normalizeSeverity,
  validateAction,
  validateEnvironment,
  validateIssue,
  validateLog,
  validateRelease
};
