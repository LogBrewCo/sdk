"use strict";

const { rmdirSync } = require("node:fs");
const nodePath = require("node:path");
const { acquireLease, releaseAfterFailure } = require("./persistent-lease.cjs");
const { fixedError, fsyncDirectory } = require("./persistent-files.cjs");
const { admitRecord, isAscendingIndexList, readClientReport, writeClientReport } = require("./persistent-records.cjs");
const {
  CHILD_NAME,
  asQueueError,
  assertProcess,
  assertUsable,
  loadRecords,
  prepareStorage,
  recordAt,
  removeQueueEntries,
  unlinkRecord
} = require("./persistent-storage.cjs");

/**
 * @import { LeaseOwner } from "./persistent-lease.cjs"
 * @import { AdmissionPaths } from "./persistent-records.cjs"
 * @import {
 *   AppendedRecord,
 *   PersistentQueueConfig,
 *   QueueContext,
 *   QueueRecord,
 *   QueueStorage
 * } from "./persistent-storage.cjs"
 */

/**
 * @typedef {Readonly<{
 *   acknowledge: (count: unknown) => void,
 *   append: (record: AppendedRecord) => void,
 *   byteCount: () => number,
 *   close: () => void,
 *   eventBytesAt: (index: number) => number,
 *   events: () => unknown[],
 *   length: () => number,
 *   loadClientReport: () => unknown,
 *   remove: (indexes: unknown) => void,
 *   saveClientReport: (state: unknown) => void,
 *   serializedAt: (index: number) => string
 * }>} PersistentEventQueue
 * @typedef {{ owner: LeaseOwner | undefined, released: boolean }} LeaseProgress
 */

const MAX_SEQUENCE = 9_999_999_999_999_999n;
const SEQUENCE_STEP = 1n;
const SEQUENCE_DIGITS = 16;
const NO_COUNT = 0;
const LAST_OFFSET = 1;

/**
 * @param {QueueContext} context
 * @returns {Readonly<{ name: string, paths: AdmissionPaths, temporaryName: string }>}
 */
function nextRecordPaths(context) {
  const { state, storage } = context;
  if (state.nextSequence > MAX_SEQUENCE) {
    throw fixedError("persistent_queue_unavailable", "persistent queue sequence is exhausted");
  }
  const sequence = state.nextSequence.toString().padStart(SEQUENCE_DIGITS, "0");
  const name = `event-${sequence}.json`;
  const temporaryName = `.event-${sequence}.tmp`;
  return {
    name,
    paths: {
      childPath: storage.childPath,
      finalPath: nodePath.join(storage.childPath, name),
      temporaryPath: nodePath.join(storage.childPath, temporaryName)
    },
    temporaryName
  };
}

/**
 * @param {QueueContext} context
 * @param {AppendedRecord} record
 * @returns {void}
 */
function appendRecord(context, record) {
  assertUsable(context);
  const { state } = context;
  const { name, paths, temporaryName } = nextRecordPaths(context);
  const identity = admitRecord(paths, record.serialized, () => {
    state.closed = true;
  });
  state.records.push({ ...record, identity, name, temporaryName });
  state.totalBytes += record.byteCount;
  state.nextSequence += SEQUENCE_STEP;
}

/**
 * @param {QueueContext} context
 * @param {QueueRecord} record
 * @returns {void}
 */
function acknowledgeFirst(context, record) {
  const { state, storage } = context;
  try {
    unlinkRecord(context, record);
    fsyncDirectory(storage.childPath);
  } catch {
    throw fixedError("persistent_queue_unavailable", "persistent queue acknowledgement failed");
  }
  state.records.shift();
  state.totalBytes -= record.byteCount;
}

/**
 * @param {QueueContext} context
 * @param {unknown} count
 * @returns {void}
 */
function acknowledgeRecords(context, count) {
  assertUsable(context);
  const { state } = context;
  if (typeof count !== "number" || !Number.isInteger(count) || count < NO_COUNT || count > state.records.length) {
    throw fixedError("persistent_queue_invalid", "persistent queue acknowledgement is invalid");
  }
  for (const record of state.records.slice(NO_COUNT, count)) {
    acknowledgeFirst(context, record);
  }
}

/**
 * @param {QueueContext} context
 * @param {number | undefined} index
 * @returns {void}
 */
function removeRecordAt(context, index) {
  const { state } = context;
  const record = index === undefined ? undefined : state.records[index];
  try {
    if (record === undefined) {
      throw new TypeError("record is missing");
    }
    unlinkRecord(context, record);
  } catch {
    throw fixedError("persistent_queue_unavailable", "persistent queue removal failed");
  }
  state.records.splice(index ?? NO_COUNT, LAST_OFFSET);
  state.totalBytes -= record.byteCount;
}

/**
 * @param {QueueContext} context
 * @param {unknown} indexes
 * @returns {void}
 */
function removeRecords(context, indexes) {
  assertUsable(context);
  if (!isAscendingIndexList(indexes, context.state.records.length)) {
    throw fixedError("persistent_queue_invalid", "persistent queue removal is invalid");
  }
  for (let position = indexes.length - LAST_OFFSET; position >= NO_COUNT; position -= LAST_OFFSET) {
    removeRecordAt(context, indexes[position]);
  }
  try {
    fsyncDirectory(context.storage.childPath);
  } catch {
    throw fixedError("persistent_queue_unavailable", "persistent queue removal failed");
  }
}

/**
 * @param {QueueContext} context
 * @returns {void}
 */
function closeQueue(context) {
  if (context.state.closed) {
    return;
  }
  assertProcess(context);
  context.owner.release();
  context.state.closed = true;
}

/**
 * @param {QueueContext} context
 * @returns {PersistentEventQueue}
 */
function queueMethods(context) {
  const { state, storage } = context;
  return {
    acknowledge: (count) => {
      acknowledgeRecords(context, count);
    },
    append: (record) => {
      appendRecord(context, record);
    },
    byteCount: () => {
      assertUsable(context);
      return state.totalBytes;
    },
    close: () => {
      closeQueue(context);
    },
    eventBytesAt: (index) => recordAt(context, index).byteCount,
    events: () => {
      assertUsable(context);
      return state.records.map((record) => record.event);
    },
    length: () => {
      assertUsable(context);
      return state.records.length;
    },
    loadClientReport: () => {
      assertUsable(context);
      return readClientReport(storage.childPath);
    },
    remove: (indexes) => {
      removeRecords(context, indexes);
    },
    saveClientReport: (report) => {
      assertUsable(context);
      writeClientReport(storage.childPath, report);
    },
    serializedAt: (index) => recordAt(context, index).serialized
  };
}

/**
 * @param {PersistentQueueConfig} config
 * @param {QueueStorage} storage
 * @param {LeaseOwner} owner
 * @returns {PersistentEventQueue}
 */
function openQueue(config, storage, owner) {
  /** @type {QueueContext} */
  const context = {
    config,
    owner,
    ownerPid: process.pid,
    state: { closed: false, nextSequence: SEQUENCE_STEP, records: [], totalBytes: NO_COUNT },
    storage
  };
  loadRecords(context);
  owner.startHeartbeat();
  return queueMethods(context);
}

/**
 * @param {PersistentQueueConfig} config
 * @returns {PersistentEventQueue}
 */
function createPersistentEventQueue(config) {
  /** @type {LeaseProgress} */
  const progress = { owner: undefined, released: false };
  try {
    const storage = prepareStorage(config.persistentQueuePath, true);
    if (storage === undefined) {
      throw new TypeError("persistent queue storage is missing");
    }
    progress.owner = acquireLease(storage.childPath);
    return openQueue(config, storage, progress.owner);
  } catch (error) {
    if (progress.owner !== undefined) {
      releaseAfterFailure(progress.owner);
    }
    throw asQueueError(error, "persistent queue could not be opened");
  }
}

/**
 * @param {QueueStorage} storage
 * @param {LeaseProgress} progress
 * @returns {void}
 */
function purgeStorage(storage, progress) {
  const owner = acquireLease(storage.childPath);
  progress.owner = owner;
  removeQueueEntries(storage);
  owner.release();
  progress.released = true;
  rmdirSync(storage.childPath);
  fsyncDirectory(storage.parentPath);
}

/**
 * @param {Readonly<{ persistentQueuePath?: unknown }>} [options]
 * @returns {boolean}
 */
function purgePersistentEventQueue({ persistentQueuePath } = {}) {
  /** @type {LeaseProgress} */
  const progress = { owner: undefined, released: false };
  try {
    const storage = prepareStorage(persistentQueuePath, false);
    if (storage === undefined) {
      return false;
    }
    purgeStorage(storage, progress);
    return true;
  } catch (error) {
    if (!progress.released && progress.owner !== undefined) {
      releaseAfterFailure(progress.owner);
    }
    throw asQueueError(error, "persistent queue purge failed");
  }
}

module.exports = { CHILD_NAME, createPersistentEventQueue, purgePersistentEventQueue };
