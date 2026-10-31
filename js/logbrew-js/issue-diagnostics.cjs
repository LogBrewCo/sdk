"use strict";

const { SdkError } = require("./sdk-error.cjs");
const { MAX_ISSUE_BREADCRUMBS, validateIssueBreadcrumb, validateIssueBreadcrumbs } = require("./issue-breadcrumbs.cjs");
const { cloneIssueEvidence, validateIssueEvidence } = require("./issue-evidence.cjs");
const { createIssueException, validateIssueException, validateIssueExceptionChain } = require("./issue-exception.cjs");
const { isList, optionalEntry } = require("./validation.cjs");

/**
 * @import { IssueAttributes, IssueBreadcrumb, IssueExceptionChainEntry, IssueStackFrame } from "./index.cjs"
 * @import { DeepReadonly } from "./validation.cjs"
 * @typedef {Pick<IssueAttributes, "exception" | "exceptionChain" | "breadcrumbs" | "breadcrumbsTruncated" | "evidence">} IssueDiagnostics
 */

/**
 * @param {Readonly<Record<string, unknown>>} attributes
 * @returns {boolean | undefined}
 */
function breadcrumbsTruncated(attributes) {
  const truncated = attributes["breadcrumbsTruncated"];
  if (truncated !== undefined && typeof truncated !== "boolean") {
    throw new SdkError("validation_error", "issue breadcrumbsTruncated must be a boolean");
  }
  return truncated === true ? true : undefined;
}

/**
 * @param {Readonly<Record<string, unknown>>} attributes
 * @returns {IssueDiagnostics}
 */
function validateIssueDiagnostics(attributes) {
  const exception = validateIssueException(attributes["exception"]);
  const exceptionChain = validateIssueExceptionChain(attributes["exceptionChain"], exception, attributes["stackFrames"]);
  const breadcrumbs = validateIssueBreadcrumbs(attributes["breadcrumbs"]);
  const evidence = validateIssueEvidence(attributes["evidence"]);
  return {
    ...optionalEntry("exception", exception),
    ...optionalEntry("exceptionChain", exceptionChain),
    ...optionalEntry("breadcrumbs", breadcrumbs),
    ...optionalEntry("breadcrumbsTruncated", breadcrumbsTruncated(attributes)),
    ...optionalEntry("evidence", evidence)
  };
}

/**
 * @param {DeepReadonly<IssueStackFrame>} frame
 * @returns {DeepReadonly<IssueStackFrame>}
 */
function cloneFrame(frame) {
  return { ...frame };
}

/**
 * @param {DeepReadonly<IssueBreadcrumb>} breadcrumb
 * @returns {DeepReadonly<IssueBreadcrumb>}
 */
function cloneBreadcrumb(breadcrumb) {
  return {
    ...breadcrumb,
    ...optionalEntry("data", breadcrumb.data === undefined ? undefined : { ...breadcrumb.data })
  };
}

/**
 * @param {DeepReadonly<IssueExceptionChainEntry>} entry
 * @returns {DeepReadonly<IssueExceptionChainEntry>}
 */
function cloneChainEntry(entry) {
  const { mechanism, stackFrames } = entry;
  return {
    ...entry,
    ...optionalEntry("mechanism", mechanism === undefined ? undefined : { ...mechanism }),
    ...optionalEntry("stackFrames", stackFrames === undefined ? undefined : stackFrames.map((frame) => cloneFrame(frame)))
  };
}

/**
 * @param {DeepReadonly<IssueDiagnostics>} attributes
 * @returns {DeepReadonly<IssueDiagnostics>}
 */
function cloneIssueDiagnostics(attributes) {
  const { breadcrumbs, evidence, exception, exceptionChain } = attributes;
  return {
    ...optionalEntry("exception", exception === undefined ? undefined : {
      ...exception,
      ...optionalEntry("mechanism", exception.mechanism === undefined ? undefined : { ...exception.mechanism })
    }),
    ...optionalEntry("exceptionChain", exceptionChain === undefined ? undefined : {
      entries: exceptionChain.entries.map((entry) => cloneChainEntry(entry)),
      truncated: exceptionChain.truncated
    }),
    ...optionalEntry("breadcrumbs", isList(breadcrumbs) ? breadcrumbs.map((breadcrumb) => cloneBreadcrumb(breadcrumb)) : undefined),
    ...optionalEntry("breadcrumbsTruncated", attributes.breadcrumbsTruncated === true ? true : undefined),
    ...optionalEntry("evidence", evidence === undefined ? undefined : cloneIssueEvidence(evidence))
  };
}

module.exports = {
  MAX_ISSUE_BREADCRUMBS,
  cloneIssueDiagnostics,
  createIssueException,
  validateIssueBreadcrumb,
  validateIssueDiagnostics,
  validateIssueEvidence
};
