"use strict";

const { Buffer } = require("node:buffer");
const crypto = require("node:crypto");
const fs = require("node:fs");
const nodePath = require("node:path");
const { attempt } = require("./internal.cjs");
const { CLIENT_REPORT_FILE, cloneRecord, encryptRecord, normalizeRecord, recoverRecords } = require("./persistent-store-records.cjs");
const { acquireLock, releaseLock } = require("./persistent-store-lock.cjs");
const {
  assertPinnedDirectory,
  assertPrivateFile,
  atomicWrite,
  errorCode
} = require("./persistent-store-files.cjs");
const {
  configurationHash,
  ensureManifest,
  eventFilename,
  readOrCreateAcceptedMarker,
  removeEventFiles,
  writeAcceptedMarker
} = require("./persistent-store-state.cjs");
const { prepareQueueDirectory, validateDependencies } = require("./persistent-store-setup.cjs");

/**
 * @import { FailFactory, StoreScope } from "./persistent-store-files.cjs"
 * @import { StoredRecord } from "./persistent-store-records.cjs"
 * @import { ErrorConstructor, StoreDependencies } from "./persistent-store-setup.cjs"
 * @import { StoreLimits } from "./persistent-store-state.cjs"
 */

/**
 * @typedef {{
 *   closed: boolean,
 *   nextSequence: number,
 *   pendingBytes: number,
 *   records: StoredRecord[],
 *   sequences: number[],
 *   uncertain: boolean
 * }} StoreState
 * @typedef {Readonly<{ key: Buffer, limits: StoreLimits, ownerLease: string, scope: StoreScope, state: StoreState }>} StoreContext
 * @typedef {{ owned: boolean }} LockProgress
 * @typedef {Readonly<{ key: Buffer, limits: StoreLimits, lock: LockProgress, ownerLease: string, sdkName: string }>} StoreSession
 * @typedef {Readonly<{
 *   acknowledge: (count: unknown) => void,
 *   remove: (indexes: unknown) => void,
 *   append: (record: unknown) => void,
 *   loadClientReport: () => unknown,
 *   saveClientReport: (state: unknown) => void,
 *   close: () => void,
 *   load: () => StoredRecord[],
 *   purge: () => void
 * }>} NodePersistentEventStore
 */

const MAX_CLIENT_REPORT_BYTES = 4096;
const LEASE_BYTES = 16;
const EMPTY = 0;
const NEXT = 1;
const NO_INDEX = -1;
const LAST = -1;

/**
 * @param {StoreContext} context
 * @returns {void}
 */
function assertOpen(context) {
  if (context.state.closed) {
    throw context.scope.fail("persistent queue is closed");
  }
  if (context.state.uncertain) {
    throw context.scope.failCommit("persistent queue durability is uncertain and requires restart");
  }
}

/**
 * @param {StoreContext} context
 * @returns {void}
 */
function assertUsable(context) {
  assertOpen(context);
  assertPinnedDirectory(context.scope);
}

/**
 * @param {StoreContext} context
 * @param {() => void} operation
 * @returns {void}
 */
function commit(context, operation) {
  try {
    operation();
  } catch (error) {
    if (errorCode(error) === "persistence_commit_error") {
      context.state.uncertain = true;
    }
    throw error;
  }
}

/**
 * @param {readonly StoredRecord[]} records
 * @returns {number}
 */
function totalBytes(records) {
  return records.reduce((total, record) => total + record.eventBytes, EMPTY);
}

/**
 * @param {StoreContext} context
 * @param {unknown} count
 * @returns {void}
 */
function acknowledge(context, count) {
  assertUsable(context);
  const { scope, state } = context;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= EMPTY || count > state.records.length) {
    throw scope.fail("persistent acknowledgement count is invalid");
  }
  const acknowledgedThrough = state.sequences[count - NEXT] ?? EMPTY;
  commit(context, () => {
    writeAcceptedMarker(scope, acknowledgedThrough);
    removeEventFiles(scope, state.sequences.slice(EMPTY, count));
  });
  state.pendingBytes -= totalBytes(state.records.slice(EMPTY, count));
  state.records = state.records.slice(count);
  state.sequences = state.sequences.slice(count);
}

/**
 * @param {unknown} indexes
 * @param {number} length
 * @returns {indexes is readonly unknown[]}
 */
function isRemovalList(indexes, length) {
  if (!Array.isArray(indexes)) {
    return false;
  }
  /** @type {readonly unknown[]} */
  const values = indexes;
  return !values.some((index, position) => {
    const previous = position === EMPTY ? NO_INDEX : values[position - NEXT];
    return typeof index !== "number" || !Number.isSafeInteger(index) || index >= length || (typeof previous === "number" && index <= previous);
  });
}

/**
 * @param {readonly StoredRecord[]} records
 * @param {readonly unknown[]} indexes
 * @returns {number}
 */
function removedBytes(records, indexes) {
  let total = EMPTY;
  for (const index of indexes) {
    if (typeof index === "number") {
      total += records[index]?.eventBytes ?? EMPTY;
    }
  }
  return total;
}

/**
 * @param {StoreContext} context
 * @param {unknown} indexes
 * @returns {void}
 */
function remove(context, indexes) {
  assertUsable(context);
  const { scope, state } = context;
  if (!isRemovalList(indexes, state.records.length)) {
    throw scope.fail("persistent removal indexes are invalid");
  }
  commit(context, () => {
    removeEventFiles(scope, indexes.map((index) => (typeof index === "number" ? state.sequences[index] : undefined)));
  });
  const removed = new Set(indexes);
  state.pendingBytes -= removedBytes(state.records, indexes);
  state.records = state.records.filter((_record, index) => !removed.has(index));
  state.sequences = state.sequences.filter((_sequence, index) => !removed.has(index));
}

/**
 * @param {StoreContext} context
 * @param {StoredRecord} normalized
 * @returns {void}
 */
function checkAppend(context, normalized) {
  const { limits, scope, state } = context;
  if (state.records.length >= limits.maxQueueSize || state.pendingBytes + normalized.eventBytes > limits.maxQueueBytes) {
    throw scope.fail("persistent queue limits were exceeded");
  }
  if (!Number.isSafeInteger(state.nextSequence) || state.nextSequence <= EMPTY) {
    throw scope.fail("persistent queue sequence was exhausted");
  }
}

/**
 * @param {StoreContext} context
 * @param {StoredRecord} normalized
 * @param {number} sequence
 * @returns {void}
 */
function writeEvent(context, normalized, sequence) {
  const { key, scope } = context;
  const encrypted = encryptRecord({ fail: scope.fail, key }, normalized, sequence);
  commit(context, () => {
    atomicWrite(scope, { data: encrypted, label: "event", name: eventFilename(sequence) });
  });
}

/**
 * @param {StoreContext} context
 * @param {unknown} record
 * @returns {void}
 */
function append(context, record) {
  assertUsable(context);
  const { scope, state } = context;
  const normalized = normalizeRecord(record, scope.fail);
  checkAppend(context, normalized);
  const sequence = state.nextSequence;
  writeEvent(context, normalized, sequence);
  state.records.push(normalized);
  state.sequences.push(sequence);
  state.pendingBytes += normalized.eventBytes;
  state.nextSequence += NEXT;
}

/**
 * @param {StoreContext} context
 * @returns {unknown}
 */
function loadClientReport(context) {
  assertOpen(context);
  const { scope } = context;
  const reportPath = nodePath.join(scope.directory.path, CLIENT_REPORT_FILE);
  if (!fs.existsSync(reportPath)) {
    return undefined;
  }
  assertPrivateFile(scope, reportPath, "persistent queue client report");
  if (fs.lstatSync(reportPath).size > MAX_CLIENT_REPORT_BYTES) {
    throw scope.fail("persistent queue client report is too large");
  }
  /** @type {unknown} */
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  return report;
}

/**
 * @param {StoreContext} context
 * @param {unknown} report
 * @returns {void}
 */
function saveClientReport(context, report) {
  assertOpen(context);
  const data = Buffer.from(JSON.stringify(report));
  if (data.length > MAX_CLIENT_REPORT_BYTES) {
    throw context.scope.fail("persistent queue client report is too large");
  }
  atomicWrite(context.scope, { data, label: "client report", name: CLIENT_REPORT_FILE });
}

/**
 * @param {StoreContext} context
 * @returns {void}
 */
function seal(context) {
  context.state.closed = true;
  context.key.fill(EMPTY);
}

/**
 * @param {StoreContext} context
 * @returns {void}
 */
function close(context) {
  if (context.state.closed) {
    return;
  }
  assertPinnedDirectory(context.scope);
  try {
    releaseLock(context.scope, context.ownerLease);
  } catch (error) {
    if (errorCode(error) === "persistence_commit_error") {
      seal(context);
    }
    throw error;
  }
  seal(context);
}

/**
 * @param {StoreContext} context
 * @returns {void}
 */
function purge(context) {
  assertUsable(context);
  const { scope, state } = context;
  if (state.sequences.length === EMPTY) {
    return;
  }
  const acknowledgedThrough = state.sequences.at(LAST) ?? EMPTY;
  commit(context, () => {
    writeAcceptedMarker(scope, acknowledgedThrough);
    removeEventFiles(scope, state.sequences);
  });
  state.records = [];
  state.sequences = [];
  state.pendingBytes = EMPTY;
}

/**
 * @param {StoreContext} context
 * @returns {NodePersistentEventStore}
 */
function storeMethods(context) {
  return {
    acknowledge: (count) => {
      acknowledge(context, count);
    },

    remove: (indexes) => {
      remove(context, indexes);
    },

    append: (record) => {
      append(context, record);
    },

    loadClientReport: () => loadClientReport(context),

    saveClientReport: (report) => {
      saveClientReport(context, report);
    },

    close: () => {
      close(context);
    },

    load: () => {
      assertUsable(context);
      return context.state.records.map((record) => cloneRecord(record));
    },

    purge: () => {
      purge(context);
    }
  };
}

/**
 * @param {StoreScope} scope
 * @param {StoreSession} session
 * @returns {NodePersistentEventStore}
 */
function openStore(scope, session) {
  const { key, limits, ownerLease } = session;
  acquireLock(scope, ownerLease);
  session.lock.owned = true;
  ensureManifest(scope, configurationHash(session.sdkName, limits));
  const acceptedThrough = readOrCreateAcceptedMarker(scope);
  const recovered = recoverRecords(scope, { acceptedThrough, cipher: { fail: scope.fail, key }, limits });
  /** @type {StoreState} */
  const state = {
    closed: false,
    nextSequence: Math.max(acceptedThrough, recovered.highestSequence) + NEXT,
    pendingBytes: totalBytes(recovered.records),
    records: recovered.records,
    sequences: recovered.sequences,
    uncertain: false
  };
  return storeMethods({ key, limits, ownerLease, scope, state });
}

/**
 * @param {StoreScope} scope
 * @param {StoreSession} session
 * @returns {NodePersistentEventStore}
 */
function openOrRelease(scope, session) {
  try {
    return openStore(scope, session);
  } catch (error) {
    if (session.lock.owned) {
      attempt(() => {
        releaseLock(scope, session.ownerLease);
      });
    }
    session.key.fill(EMPTY);
    throw error;
  }
}

/**
 * @param {ErrorConstructor} SdkError
 * @returns {Readonly<{ fail: FailFactory, failCommit: FailFactory }>}
 */
function storeErrors(SdkError) {
  return {
    fail: (message) => new SdkError("persistence_error", message),
    failCommit: (message) => new SdkError("persistence_commit_error", message)
  };
}

/**
 * @param {StoreDependencies} dependencies
 * @returns {NodePersistentEventStore}
 */
function buildNodePersistentEventStore({ SdkError, directory, encryptionKey, limits, onWarning, sdkName }) {
  const valid = validateDependencies({ SdkError, directory, encryptionKey, limits, onWarning, sdkName });
  const errors = storeErrors(valid.SdkError);
  const key = Buffer.from(valid.encryptionKey);
  const ownerLease = crypto.randomBytes(LEASE_BYTES).toString("hex");
  const scope = { directory: prepareQueueDirectory(valid.directory, errors.fail), ...errors, onWarning };
  return openOrRelease(scope, { key, limits: valid.limits, lock: { owned: false }, ownerLease, sdkName: valid.sdkName });
}

module.exports = { buildNodePersistentEventStore };
