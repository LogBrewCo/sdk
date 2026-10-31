"use strict";

const { lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync } = require("node:fs");
const nodePath = require("node:path");
const { SdkError } = require("@logbrew/sdk");
const { OWNER_NAME } = require("./persistent-lease.cjs");
const {
  DIRECTORY_MODE,
  FILE_MODE,
  SINGLE_LINKS,
  fixedError,
  fsyncDirectory,
  lstatOptional,
  requireSupportedPlatform,
  validateDirectory,
  validateOwnedFile,
  validateOwnedMode
} = require("./persistent-files.cjs");
const {
  CLIENT_REPORT_NAME,
  readRecord,
  reconcileTemporaryRecords,
  validateRecordIdentity
} = require("./persistent-records.cjs");

/**
 * @import { Stats } from "node:fs"
 * @import { LeaseOwner } from "./persistent-lease.cjs"
 * @import { FileIdentity } from "./persistent-files.cjs"
 * @import { RecordLimits } from "./persistent-records.cjs"
 */

/**
 * @typedef {RecordLimits & Readonly<{ persistentQueuePath: unknown }>} PersistentQueueConfig
 * @typedef {Readonly<{ childPath: string, parentPath: string }>} QueueStorage
 * @typedef {Readonly<{ byteCount: number, event: unknown, serialized: string }>} AppendedRecord
 * @typedef {AppendedRecord & Readonly<{ identity: FileIdentity, name: string, temporaryName?: string }>} QueueRecord
 * @typedef {{ closed: boolean, nextSequence: bigint, records: QueueRecord[], totalBytes: number }} QueueState
 * @typedef {Readonly<{
 *   config: PersistentQueueConfig,
 *   owner: LeaseOwner,
 *   ownerPid: number,
 *   state: QueueState,
 *   storage: QueueStorage
 * }>} QueueContext
 */

const CHILD_NAME = "logbrew-node-queue-v1";
const RECORD_PATTERN = /^event-(?<sequence>[0-9]{16})\.json$/u;
const NON_RECORD_NAMES = new Set([OWNER_NAME, CLIENT_REPORT_NAME]);
const NO_SEQUENCE = 0n;
const SEQUENCE_STEP = 1n;

/**
 * @param {unknown} error
 * @param {string} message
 * @returns {SdkError}
 */
function asQueueError(error, message) {
  return error instanceof SdkError ? error : fixedError("persistent_queue_unavailable", message);
}

/**
 * @param {string} requested
 * @returns {Readonly<{ path: string, stat: Stats }>}
 */
function inspectParent(requested) {
  try {
    const path = realpathSync(requested);
    return { path, stat: lstatSync(requested) };
  } catch {
    throw fixedError("persistent_queue_unavailable", "persistent queue parent is unavailable");
  }
}

/**
 * @param {unknown} persistentQueuePath
 * @returns {string}
 */
function resolveParent(persistentQueuePath) {
  requireSupportedPlatform();
  if (typeof persistentQueuePath !== "string" || persistentQueuePath.trim() === "") {
    throw fixedError("configuration_error", "persistent queue path is required");
  }
  const requested = nodePath.resolve(persistentQueuePath);
  const parent = inspectParent(requested);
  if (parent.path !== requested || !parent.stat.isDirectory() || parent.stat.isSymbolicLink()) {
    throw fixedError("persistent_queue_invalid", "persistent queue parent is invalid");
  }
  validateOwnedMode(parent.stat, DIRECTORY_MODE);
  return parent.path;
}

/**
 * @param {string} parentPath
 * @param {string} childPath
 * @returns {void}
 */
function createChildDirectory(parentPath, childPath) {
  try {
    mkdirSync(childPath, { mode: DIRECTORY_MODE });
    fsyncDirectory(parentPath);
  } catch {
    throw fixedError("persistent_queue_unavailable", "persistent queue storage is unavailable");
  }
}

/**
 * @param {unknown} persistentQueuePath
 * @param {boolean} createChild
 * @returns {QueueStorage | undefined}
 */
function prepareStorage(persistentQueuePath, createChild) {
  const parentPath = resolveParent(persistentQueuePath);
  const childPath = nodePath.join(parentPath, CHILD_NAME);
  const existing = lstatOptional(childPath);
  if (existing === undefined && !createChild) {
    return undefined;
  }
  if (existing === undefined) {
    createChildDirectory(parentPath, childPath);
  }
  validateDirectory(childPath);
  return { childPath, parentPath };
}

/**
 * @param {QueueContext} context
 * @returns {void}
 */
function assertProcess(context) {
  if (process.pid !== context.ownerPid) {
    throw fixedError("persistent_queue_unavailable", "persistent queue process ownership changed");
  }
}

/**
 * @param {QueueContext} context
 * @returns {void}
 */
function assertUsable(context) {
  assertProcess(context);
  if (context.state.closed || !context.owner.isCurrent()) {
    throw fixedError("persistent_queue_unavailable", "persistent queue ownership was lost");
  }
}

/**
 * @param {QueueContext} context
 * @param {number} index
 * @returns {QueueRecord}
 */
function recordAt(context, index) {
  assertUsable(context);
  const record = context.state.records[index];
  if (!record) {
    throw fixedError("persistent_queue_invalid", "persistent queue order is invalid");
  }
  return record;
}

/**
 * @param {string} name
 * @returns {bigint}
 */
function recordSequence(name) {
  return BigInt(RECORD_PATTERN.exec(name)?.groups?.["sequence"] ?? "");
}

/**
 * @param {QueueContext} context
 * @returns {string[]}
 */
function listRecordNames(context) {
  const entries = readdirSync(context.storage.childPath).filter((name) => !NON_RECORD_NAMES.has(name));
  const recordNames = entries.filter((name) => RECORD_PATTERN.test(name));
  recordNames.sort();
  if (recordNames.length !== entries.length || recordNames.length > context.config.maxQueueSize) {
    throw fixedError("persistent_queue_invalid", "persistent queue contents are invalid");
  }
  return recordNames;
}

/**
 * @param {QueueContext} context
 * @param {string} name
 * @param {bigint} highestSequence
 * @returns {bigint}
 */
function loadRecord(context, name, highestSequence) {
  const { config, state, storage } = context;
  const sequence = recordSequence(name);
  if (sequence <= highestSequence) {
    throw fixedError("persistent_queue_invalid", "persistent queue order is invalid");
  }
  const loaded = readRecord(nodePath.join(storage.childPath, name), config);
  if (state.totalBytes + loaded.byteCount > config.maxQueueBytes) {
    throw fixedError("persistent_queue_invalid", "persistent queue bounds are invalid");
  }
  state.records.push({ ...loaded, name });
  state.totalBytes += loaded.byteCount;
  return sequence;
}

/**
 * @param {QueueContext} context
 * @returns {void}
 */
function loadRecords(context) {
  reconcileTemporaryRecords(context.storage.childPath);
  let highestSequence = NO_SEQUENCE;
  for (const name of listRecordNames(context)) {
    highestSequence = loadRecord(context, name, highestSequence);
  }
  context.state.nextSequence = highestSequence + SEQUENCE_STEP;
}

/**
 * @param {QueueContext} context
 * @param {QueueRecord} record
 * @returns {void}
 */
function unlinkRecord(context, record) {
  const { childPath } = context.storage;
  const path = nodePath.join(childPath, record.name);
  const temporaryPath = record.temporaryName === undefined ? undefined : nodePath.join(childPath, record.temporaryName);
  validateRecordIdentity(path, record.identity, temporaryPath);
  unlinkSync(path);
}

/**
 * @param {QueueStorage} storage
 * @returns {void}
 */
function removeQueueEntries(storage) {
  reconcileTemporaryRecords(storage.childPath);
  const entries = readdirSync(storage.childPath).filter((name) => name !== OWNER_NAME);
  if (entries.some((name) => !RECORD_PATTERN.test(name) && name !== CLIENT_REPORT_NAME)) {
    throw fixedError("persistent_queue_invalid", "persistent queue contents are invalid");
  }
  for (const name of entries) {
    const path = nodePath.join(storage.childPath, name);
    validateOwnedFile(lstatSync(path), FILE_MODE, SINGLE_LINKS);
    unlinkSync(path);
  }
  fsyncDirectory(storage.childPath);
}

module.exports = {
  CHILD_NAME,
  asQueueError,
  assertProcess,
  assertUsable,
  loadRecords,
  prepareStorage,
  recordAt,
  removeQueueEntries,
  unlinkRecord
};
