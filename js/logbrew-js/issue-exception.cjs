"use strict";

const { SdkError } = require("./sdk-error.cjs");
const { validateIssueStackFrames } = require("./issue-stack-frames.cjs");
const { boundedIdentity, optionalIdentity, optionalText, requireMachineName } = require("./issue-text.cjs");
const { isAllowedValue, optionalEntry, rejectUnknownKeys, requireObject } = require("./validation.cjs");

/**
 * @import {
 *   IssueException,
 *   IssueExceptionChain,
 *   IssueExceptionChainEntry,
 *   IssueExceptionMechanism,
 *   IssueExceptionMessageState,
 *   IssueExceptionRelationship,
 *   IssueExceptionStackFramesState
 * } from "./index.cjs"
 * @import { DeepReadonly } from "./validation.cjs"
 * @typedef {Pick<IssueExceptionChainEntry, "id" | "parentId" | "relationship">} EntryLineage
 * @typedef {Pick<IssueExceptionChainEntry, "message" | "messageState">} EntryMessage
 * @typedef {Pick<IssueExceptionChainEntry, "stackFrames" | "stackFramesState">} EntryStack
 */

const MAX_ISSUE_EXCEPTIONS = 8;
const MAX_EXCEPTION_TYPE_LENGTH = 256;
const MAX_EXCEPTION_MESSAGE_LENGTH = 1024;
const MAX_EXCEPTION_MODULE_LENGTH = 512;
const ROOT_INDEX = 0;
const NEXT_INDEX = 1;
const EXCEPTION_KEYS = new Set(["type", "mechanism"]);
const MECHANISM_KEYS = new Set(["type", "handled"]);
const CHAIN_KEYS = new Set(["entries", "truncated"]);
const ENTRY_KEYS = new Set([
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
]);
/** @type {ReadonlySet<IssueExceptionRelationship>} */
const CHILD_RELATIONSHIPS = new Set(["cause", "context", "aggregate_member", "suppressed"]);
/** @type {ReadonlySet<IssueExceptionMessageState>} */
const MESSAGE_STATES = new Set(["captured", "truncated", "redacted", "not_captured"]);
/** @type {ReadonlySet<IssueExceptionStackFramesState>} */
const STACK_FRAMES_STATES = new Set(["captured", "truncated", "not_captured"]);

/**
 * @param {unknown} mechanism
 * @returns {IssueExceptionMechanism | undefined}
 */
function validateIssueExceptionMechanism(mechanism) {
  if (mechanism === undefined) {
    return undefined;
  }
  const source = requireObject("issue exception mechanism", mechanism);
  rejectUnknownKeys("issue exception mechanism", source, MECHANISM_KEYS);
  const type = requireMachineName("issue exception mechanism type", source["type"]);
  const { handled } = source;
  if (typeof handled !== "boolean") {
    throw new SdkError("validation_error", "issue exception mechanism handled must be a boolean");
  }
  return {
    type,

    handled
  };
}

/**
 * @param {unknown} exception
 * @returns {IssueException | undefined}
 */
function validateIssueException(exception) {
  if (exception === undefined) {
    return undefined;
  }
  const source = requireObject("issue exception", exception);
  rejectUnknownKeys("issue exception", source, EXCEPTION_KEYS);
  const type = boundedIdentity("issue exception type", source["type"], MAX_EXCEPTION_TYPE_LENGTH);
  const mechanism = validateIssueExceptionMechanism(source["mechanism"]);
  return { type, ...optionalEntry("mechanism", mechanism) };
}

/**
 * @param {string} type
 * @param {string} mechanism
 * @param {boolean} handled
 * @returns {IssueException | undefined}
 */
function createIssueException(type, mechanism, handled) {
  return validateIssueException({ mechanism: { handled, type: mechanism }, type });
}

/**
 * @param {unknown} parentId
 * @param {number} index
 * @returns {parentId is number}
 */
function isParentIndex(parentId, index) {
  return typeof parentId === "number" && Number.isInteger(parentId) && parentId >= ROOT_INDEX && parentId < index;
}

/**
 * @param {Readonly<Record<string, unknown>>} source
 * @param {number} index
 * @returns {EntryLineage}
 */
function entryLineage(source, index) {
  const { id, parentId, relationship } = source;
  if (typeof id !== "number" || !Number.isInteger(id) || id !== index) {
    throw new SdkError("validation_error", `issue exceptionChain entry ${index} id must equal its array index`);
  }
  if (index === ROOT_INDEX) {
    if (relationship !== "reported" || parentId !== undefined) {
      throw new SdkError("validation_error", "issue exceptionChain entry 0 must be the parentless reported exception");
    }
    return { id, relationship };
  }
  if (typeof relationship !== "string" || !isAllowedValue(relationship, CHILD_RELATIONSHIPS) || !isParentIndex(parentId, index)) {
    throw new SdkError("validation_error", `issue exceptionChain entry ${index} parent relationship is invalid`);
  }
  return { id, parentId, relationship };
}

/**
 * @param {Readonly<Record<string, unknown>>} source
 * @param {number} index
 * @returns {EntryMessage}
 */
function entryMessage(source, index) {
  const { messageState } = source;
  if (typeof messageState !== "string" || !isAllowedValue(messageState, MESSAGE_STATES)) {
    throw new SdkError("validation_error", `issue exceptionChain entry ${index} messageState is invalid`);
  }
  const message = optionalText(`issue exceptionChain entry ${index} message`, source["message"], MAX_EXCEPTION_MESSAGE_LENGTH);
  if ((messageState === "captured" || messageState === "truncated") !== (message !== undefined)) {
    throw new SdkError("validation_error", `issue exceptionChain entry ${index} message does not match messageState`);
  }
  return { ...optionalEntry("message", message), messageState };
}

/**
 * @param {Readonly<Record<string, unknown>>} source
 * @param {number} index
 * @returns {EntryStack}
 */
function entryStack(source, index) {
  const { stackFramesState } = source;
  if (typeof stackFramesState !== "string" || !isAllowedValue(stackFramesState, STACK_FRAMES_STATES)) {
    throw new SdkError("validation_error", `issue exceptionChain entry ${index} stackFramesState is invalid`);
  }
  const stackFrames = validateIssueStackFrames(source["stackFrames"]);
  if ((stackFramesState === "captured" || stackFramesState === "truncated") !== (stackFrames !== undefined)) {
    throw new SdkError("validation_error", `issue exceptionChain entry ${index} stackFrames do not match stackFramesState`);
  }
  return { ...optionalEntry("stackFrames", stackFrames), stackFramesState };
}

/**
 * @param {unknown} entry
 * @param {number} index
 * @returns {IssueExceptionChainEntry}
 */
function validateIssueExceptionChainEntry(entry, index) {
  const label = `issue exceptionChain entry ${index}`;
  const source = requireObject(label, entry);
  rejectUnknownKeys(label, source, ENTRY_KEYS);
  const lineage = entryLineage(source, index);
  const type = boundedIdentity(`${label} type`, source["type"], MAX_EXCEPTION_TYPE_LENGTH);
  const message = entryMessage(source, index);
  const moduleName = optionalIdentity(`${label} module`, source["module"], MAX_EXCEPTION_MODULE_LENGTH);
  const mechanism = validateIssueExceptionMechanism(source["mechanism"]);
  const stack = entryStack(source, index);
  return {
    ...lineage,
    type,
    ...message,
    ...optionalEntry("module", moduleName),
    ...optionalEntry("mechanism", mechanism),
    ...stack
  };
}

/**
 * @param {readonly unknown[]} entries
 * @returns {entries is readonly [unknown, ...unknown[]]}
 */
function hasChainEntries(entries) {
  return entries.length >= NEXT_INDEX && entries.length <= MAX_ISSUE_EXCEPTIONS;
}

/**
 * @param {unknown} entries
 * @returns {readonly [unknown, ...unknown[]]}
 */
function requireChainEntries(entries) {
  if (Array.isArray(entries)) {
    /** @type {readonly unknown[]} */
    const list = entries;
    if (hasChainEntries(list)) {
      return list;
    }
  }
  throw new SdkError("validation_error", `issue exceptionChain entries must contain 1-${MAX_ISSUE_EXCEPTIONS} exceptions`);
}

/**
 * @param {unknown} truncated
 * @returns {boolean}
 */
function requireChainTruncated(truncated) {
  if (typeof truncated !== "boolean") {
    throw new SdkError("validation_error", "issue exceptionChain truncated must be a boolean");
  }
  return truncated;
}

/**
 * @param {DeepReadonly<IssueExceptionChainEntry>} reported
 * @param {DeepReadonly<IssueException> | undefined} legacyException
 * @param {unknown} legacyStackFrames
 * @returns {void}
 */
function requireReportedMatch(reported, legacyException, legacyStackFrames) {
  const reportedException = { type: reported.type, ...optionalEntry("mechanism", reported.mechanism) };
  if (legacyException === undefined || JSON.stringify(reportedException) !== JSON.stringify(legacyException)) {
    throw new SdkError("validation_error", "issue exceptionChain reported exception must match exception");
  }
  const canonicalLegacyFrames = validateIssueStackFrames(legacyStackFrames);
  const framesMatch = reported.stackFramesState === "not_captured"
    ? canonicalLegacyFrames === undefined
    : JSON.stringify(reported.stackFrames) === JSON.stringify(canonicalLegacyFrames);
  if (!framesMatch) {
    throw new SdkError("validation_error", "issue exceptionChain reported stack must match stackFrames");
  }
}

/**
 * @param {unknown} chain
 * @param {DeepReadonly<IssueException> | undefined} legacyException
 * @param {unknown} legacyStackFrames
 * @returns {IssueExceptionChain | undefined}
 */
function validateIssueExceptionChain(chain, legacyException, legacyStackFrames) {
  if (chain === undefined) {
    return undefined;
  }
  const source = requireObject("issue exceptionChain", chain);
  rejectUnknownKeys("issue exceptionChain", source, CHAIN_KEYS);
  const [first, ...rest] = requireChainEntries(source["entries"]);
  const truncated = requireChainTruncated(source["truncated"]);
  const reported = validateIssueExceptionChainEntry(first, ROOT_INDEX);
  const entries = [reported, ...rest.map((entry, offset) => validateIssueExceptionChainEntry(entry, offset + NEXT_INDEX))];
  requireReportedMatch(reported, legacyException, legacyStackFrames);
  return { entries, truncated };
}

module.exports = { createIssueException, validateIssueException, validateIssueExceptionChain };
