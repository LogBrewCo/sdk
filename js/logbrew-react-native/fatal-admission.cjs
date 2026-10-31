"use strict";

const { isObjectLike, safeFunction } = require("./global-errors-support.cjs");
const { resultStatus } = require("./fatal-record.cjs");

/**
 * @import { UnknownFunction } from "./global-errors-support.cjs"
 * @typedef {"admitted" | "dropped" | "filtered" | "unavailable"} Admission
 * @typedef {Readonly<{
 *   acknowledge: UnknownFunction,
 *   discard: UnknownFunction,
 *   read: UnknownFunction,
 *   write: UnknownFunction
 * }>} FatalStoreMethods
 */

const MAX_ADMITTED_FATAL_IDS = 256;

/** @type {WeakMap<object, Set<string>>} */
const admittedFatalIdsByClient = new WeakMap();

/**
 * @param {() => unknown} operation
 * @returns {unknown}
 */
function attempt(operation) {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

/** @type {(client: unknown, issue: UnknownFunction, ...issueArguments: readonly unknown[]) => Admission} */
function captureIssueWithAdmission(client, issue, ...issueArguments) {
  const [id, timestamp, attributes] = issueArguments;
  const capture = safeFunction(client, "issueWithAdmission");
  if (!capture) {
    issue.call(client, id, timestamp, attributes);
    return "unavailable";
  }
  const status = resultStatus(capture.call(client, id, timestamp, attributes));
  return status === "admitted" || status === "filtered" || status === "dropped"
    ? status
    : "unavailable";
}

/**
 * @param {unknown} client
 * @param {string} recordId
 * @returns {boolean}
 */
function wasAdmittedInRuntime(client, recordId) {
  return isObjectLike(client) && admittedFatalIdsByClient.get(client)?.has(recordId) === true;
}

/**
 * @param {object} client
 * @returns {Set<string>}
 */
function admittedIdsFor(client) {
  const existing = admittedFatalIdsByClient.get(client);
  if (existing) {
    return existing;
  }
  /** @type {Set<string>} */
  const admittedIds = new Set();
  admittedFatalIdsByClient.set(client, admittedIds);
  return admittedIds;
}

/**
 * @param {unknown} client
 * @param {string} recordId
 * @returns {void}
 */
function rememberAdmittedFatalId(client, recordId) {
  if (!isObjectLike(client)) {
    return;
  }
  const admittedIds = admittedIdsFor(client);
  if (admittedIds.has(recordId)) {
    return;
  }
  admittedIds.add(recordId);
  const oldest = admittedIds.values().next().value;
  if (admittedIds.size > MAX_ADMITTED_FATAL_IDS && oldest !== undefined) {
    admittedIds.delete(oldest);
  }
}

/**
 * @param {unknown} fatalStore
 * @returns {FatalStoreMethods | undefined}
 */
function fatalStoreMethods(fatalStore) {
  if (!isObjectLike(fatalStore)) {
    return undefined;
  }
  const acknowledge = safeFunction(fatalStore, "acknowledgeFatalRecord");
  const discard = safeFunction(fatalStore, "discardFatalRecord");
  const read = safeFunction(fatalStore, "readFatalRecord");
  const write = safeFunction(fatalStore, "writeFatalRecord");
  return acknowledge && discard && read && write ? { acknowledge, discard, read, write } : undefined;
}

module.exports = {
  attempt,
  captureIssueWithAdmission,
  fatalStoreMethods,
  rememberAdmittedFatalId,
  wasAdmittedInRuntime
};
