const { errorCauseType, errorDetails, isObjectLike, safeProperty } = require("./error-details.cjs");
const { javascriptStackEvidence } = require("./issue-stack.cjs");
const { optionalEntry } = require("./validation.cjs");

/**
 * @import {
 *   IssueException,
 *   IssueExceptionChain,
 *   IssueExceptionChainEntry,
 *   IssueExceptionMechanism,
 *   IssueExceptionMessageState,
 *   IssueExceptionRelationship
 * } from "./index.cjs"
 * @import { ErrorDetails } from "./error-details.cjs"
 * @import { StackEvidence } from "./issue-stack.cjs"
 * @import { DeepReadonly } from "./validation.cjs"
 * @typedef {DeepReadonly<{
 *   details: ErrorDetails,
 *   exception: IssueException | undefined,
 *   stackEvidence: StackEvidence,
 *   debugIdMap: unknown
 * }>} ReportedException
 * @typedef {Readonly<{ parentId?: number, relationship: IssueExceptionRelationship }>} ChainLink
 */

const MAX_CHAIN_ENTRIES = 8;
const ROOT_ID = 0;
const NO_FRAMES = 0;
const WHITESPACE_PATTERN = /\s+/gu;

/**
 * @param {unknown} value
 * @returns {{ messageState: IssueExceptionMessageState }}
 */
function exceptionMessageEvidence(value) {
  if (typeof value !== "string" || value.replaceAll(WHITESPACE_PATTERN, " ").trim() === "") {
    return { messageState: "not_captured" };
  }
  return { messageState: "redacted" };
}

/**
 * @param {IssueExceptionRelationship} relationship
 * @returns {IssueExceptionMechanism}
 */
function childMechanism(relationship) {
  return {
    type: relationship === "aggregate_member" ? "javascript.aggregate_member" : "javascript.cause",

    handled: true
  };
}

/**
 * @param {number} frameCount
 * @param {boolean} truncated
 * @returns {IssueExceptionChainEntry["stackFramesState"]}
 */
function stackFramesState(frameCount, truncated) {
  if (frameCount === NO_FRAMES) {
    return "not_captured";
  }
  return truncated ? "truncated" : "captured";
}

class ExceptionChainCollector {
  /**
   * @param {unknown} debugIdMap
   */
  constructor(debugIdMap) {
    /** @type {DeepReadonly<IssueExceptionChainEntry>[]} */
    this.entries = [];
    /** @type {Set<object>} */
    this.seen = new Set();
    this.truncated = false;
    this.debugIdMap = debugIdMap;
  }

  /**
   * @param {unknown} value
   * @param {ChainLink} link
   * @param {ReportedException} [known]
   * @returns {number | undefined}
   */
  appendNode(value, link, known) {
    if (this.entries.length >= MAX_CHAIN_ENTRIES) {
      this.truncated = true;
      return undefined;
    }
    const details = known?.details ?? errorDetails(value);
    const stackEvidence = known?.stackEvidence ?? javascriptStackEvidence(details.stack, this.debugIdMap);
    const mechanism = known?.exception?.mechanism ?? childMechanism(link.relationship);
    const messageEvidence = exceptionMessageEvidence(details.message);
    const id = this.entries.length;
    this.entries.push({
      id,
      ...optionalEntry("parentId", link.parentId),
      relationship: link.relationship,
      type: known?.exception?.type ?? errorCauseType(value),
      ...messageEvidence,
      mechanism,
      ...optionalEntry("stackFrames", stackEvidence.frames.length === NO_FRAMES ? undefined : stackEvidence.frames),
      stackFramesState: stackFramesState(stackEvidence.frames.length, stackEvidence.truncated)
    });
    return id;
  }

  /**
   * @param {unknown} value
   * @returns {boolean}
   */
  markSeen(value) {
    if (!isObjectLike(value)) {
      return true;
    }
    if (this.seen.has(value)) {
      this.truncated = true;
      return false;
    }
    this.seen.add(value);
    return true;
  }

  /**
   * @param {unknown} value
   * @param {number} parentId
   * @param {IssueExceptionRelationship} relationship
   * @returns {void}
   */
  collectChild(value, parentId, relationship) {
    if (this.entries.length >= MAX_CHAIN_ENTRIES) {
      this.truncated = true;
      return;
    }
    if (!this.markSeen(value)) {
      return;
    }
    const id = this.appendNode(value, { parentId, relationship });
    if (id !== undefined) {
      this.collectChildren(value, id);
    }
  }

  /**
   * @param {unknown} value
   * @param {number} parentId
   * @returns {void}
   */
  collectChildren(value, parentId) {
    if (!isObjectLike(value)) {
      return;
    }
    this.collectCause(value, parentId);
    this.collectAggregateMembers(value, parentId);
  }

  /**
   * @param {object} value
   * @param {number} parentId
   * @returns {void}
   */
  collectCause(value, parentId) {
    const cause = safeProperty(value, "cause");
    if (cause.available && cause.value !== undefined && cause.value !== null) {
      this.collectChild(cause.value, parentId, "cause");
    } else if (!cause.available) {
      this.truncated = true;
    }
  }

  /**
   * @param {object} value
   * @param {number} parentId
   * @returns {void}
   */
  collectAggregateMembers(value, parentId) {
    const errors = safeProperty(value, "errors");
    if (!errors.available) {
      this.truncated = true;
    } else if (Array.isArray(errors.value)) {
      /** @type {readonly unknown[]} */
      const children = errors.value;
      for (const child of children) {
        this.collectChild(child, parentId, "aggregate_member");
      }
    }
  }
}

/**
 * @param {unknown} error
 * @param {ReportedException} reported
 * @returns {DeepReadonly<IssueExceptionChain>}
 */
function createJavaScriptExceptionChain(error, reported) {
  const collector = new ExceptionChainCollector(reported.debugIdMap);
  if (isObjectLike(error)) {
    collector.seen.add(error);
  }
  collector.appendNode(error, { relationship: "reported" }, reported);
  collector.collectChildren(error, ROOT_ID);
  return { entries: collector.entries, truncated: collector.truncated };
}

module.exports = { createJavaScriptExceptionChain };
