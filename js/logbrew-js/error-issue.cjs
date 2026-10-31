const { errorCauseMetadata } = require("./error-causes.cjs");
const { errorDetails } = require("./error-details.cjs");
const { normalizeSeverity } = require("./event-validation.cjs");
const { createJavaScriptExceptionChain } = require("./exception-chain.cjs");
const { createIssueException, validateIssueEvidence } = require("./issue-diagnostics.cjs");
const { javascriptStackEvidence } = require("./issue-stack.cjs");
const { compactMetadata, traceMetadataFromLogContext } = require("./log-context.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { hasUnicodeControlCharacter, isRecord, optionalEntry, stringOrUndefined } = require("./validation.cjs");

/**
 * @import { IssueAttributes, IssueStackFrame } from "./index.cjs"
 * @import { ErrorDetails } from "./error-details.cjs"
 * @import { DeepReadonly } from "./validation.cjs"
 * @typedef {Readonly<{ details: Readonly<ErrorDetails>, frame: Readonly<IssueStackFrame> | undefined }>} ParsedError
 */

const MAX_EXCEPTION_TYPE_LENGTH = 256;
const NO_FRAMES = 0;
const LOCATION_TEXT_PATTERN = /[?#]/u;

/**
 * @param {string} value
 * @returns {string}
 */
function boundedIssueExceptionType(value) {
  const normalized = value.trim();
  if (
    normalized === ""
    || [...normalized].length > MAX_EXCEPTION_TYPE_LENGTH
    || LOCATION_TEXT_PATTERN.test(normalized)
    || hasUnicodeControlCharacter(normalized)
  ) {
    return "Error";
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function issueFingerprintOrUndefined(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new SdkError("validation_error", "issue fingerprint must be a non-empty string");
  }
  return value.trim();
}

/**
 * @param {string} groupingPrefix
 * @param {Readonly<IssueStackFrame> | undefined} frame
 * @param {string | undefined} issueFingerprint
 * @returns {Record<string, string>}
 */
function issueGroupingMetadata(groupingPrefix, frame, issueFingerprint) {
  /** @type {string} */
  let issueGroupingSource = "error_type";
  if (issueFingerprint !== undefined) {
    issueGroupingSource = "explicit_fingerprint";
  } else if (frame !== undefined) {
    issueGroupingSource = "error_type_and_frame";
  }
  return {
    issueGroupingKey: frame === undefined ? groupingPrefix : `${groupingPrefix}:${frame.filename}`,

    issueGroupingSource,
    ...optionalEntry("issueFingerprint", issueFingerprint)
  };
}

/**
 * @param {Readonly<IssueStackFrame> | undefined} frame
 * @returns {Record<string, string>}
 */
function releaseArtifactMetadata(frame) {
  if (frame?.debugId === undefined || frame.debugId === "") {
    return {};
  }
  return {
    releaseArtifactType: "sourcemap",

    releaseArtifactCodeFile: frame.filename,

    releaseArtifactDebugId: frame.debugId
  };
}

/**
 * @param {Readonly<Record<string, unknown>>} options
 * @returns {Record<string, unknown>}
 */
function labelMetadata(options) {
  /** @type {Record<string, unknown>} */
  const labels = {};
  for (const key of ["release", "environment", "service", "runtime", "platform"]) {
    if (stringOrUndefined(options[key]) !== undefined) {
      labels[key] = options[key];
    }
  }
  return labels;
}

/**
 * @param {Readonly<IssueStackFrame> | undefined} frame
 * @returns {Record<string, unknown>}
 */
function errorFrameMetadata(frame) {
  if (frame === undefined) {
    return {};
  }
  return {
    errorFrameFile: frame.filename,

    errorFrameLine: frame.line,

    errorFrameColumn: frame.column
  };
}

/**
 * @param {unknown} error
 * @param {Readonly<Record<string, unknown>>} options
 * @param {ParsedError} parsed
 * @returns {Record<string, unknown>}
 */
function errorIssueMetadata(error, options, parsed) {
  const { details, frame } = parsed;
  const source = stringOrUndefined(options["source"]) ?? "javascript.error";
  return {
    ...compactMetadata(options["metadata"]),

    source,

    errorName: details.name,
    ...optionalEntry("errorMessage", details.message),
    ...errorFrameMetadata(frame),
    ...issueGroupingMetadata(`${source}:${details.name}`, frame, issueFingerprintOrUndefined(options["fingerprint"])),
    ...errorCauseMetadata(error),
    ...labelMetadata(options),
    ...traceMetadataFromLogContext(options["trace"]),
    ...releaseArtifactMetadata(frame),
    ...optionalEntry("errorStack", options["includeErrorStack"] === true ? details.stack : undefined)
  };
}

/**
 * @param {unknown} error
 * @param {unknown} [options]
 * @returns {DeepReadonly<IssueAttributes>}
 */
function createIssueAttributesFromError(error, options = {}) {
  if (!isRecord(options)) {
    throw new SdkError("validation_error", "error issue options must be an object");
  }
  const details = errorDetails(error);
  const stackEvidence = javascriptStackEvidence(details.stack, options["debugIdMap"]);
  const [frame] = stackEvidence.frames;
  const metadata = errorIssueMetadata(error, options, { details, frame });
  const exception = createIssueException(
    boundedIssueExceptionType(details.name),
    stringOrUndefined(options["mechanism"]) ?? "javascript.error",
    options["handled"] === undefined ? true : options["handled"]
  );
  const exceptionChain = createJavaScriptExceptionChain(error, {
    debugIdMap: options["debugIdMap"],
    details,
    exception,
    stackEvidence
  });
  return {
    title: stringOrUndefined(options["title"]) ?? details.name,

    level: normalizeSeverity("issue level", options["level"] ?? "error"),
    ...optionalEntry("message", stringOrUndefined(options["message"]) ?? details.message),
    exception,
    exceptionChain,
    ...optionalEntry("stackFrames", stackEvidence.frames.length > NO_FRAMES ? stackEvidence.frames : undefined),
    ...optionalEntry("evidence", validateIssueEvidence(options["evidence"])),
    metadata: compactMetadata(metadata)
  };
}

module.exports = { createIssueAttributesFromError };
