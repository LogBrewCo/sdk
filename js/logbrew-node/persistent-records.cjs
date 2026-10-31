"use strict";

const { Buffer } = require("node:buffer");
const {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} = require("node:fs");
const nodePath = require("node:path");
const { attempt } = require("./internal.cjs");
const {
  DOUBLE_LINKS,
  FILE_MODE,
  SINGLE_LINKS,
  SINGLE_OR_DOUBLE_LINKS,
  errorCode,
  fixedError,
  fsyncDirectory,
  identityOf,
  lstatOptional,
  noFollowFlag,
  sameIdentity,
  validateOwnedFile
} = require("./persistent-files.cjs");

/**
 * @import { Stats } from "node:fs"
 * @import { FileIdentity } from "./persistent-files.cjs"
 */

/**
 * @typedef {Readonly<{
 *   batchPrefixBytes: number,
 *   batchSuffixBytes: number,
 *   maxBatchBytes: number,
 *   maxQueueBytes: number,
 *   maxQueueSize: number,
 *   restoreEvent: (serialized: string) => unknown
 * }>} RecordLimits
 * @typedef {Readonly<{ byteCount: number, event: unknown, identity: FileIdentity, serialized: string }>} LoadedRecord
 * @typedef {Readonly<{ childPath: string, finalPath: string, temporaryPath: string }>} AdmissionPaths
 * @typedef {{ linked: boolean }} AdmissionProgress
 */

const CLIENT_REPORT_NAME = "client-report.json";
const CLIENT_REPORT_TEMP_NAME = ".client-report.tmp";
const MAX_CLIENT_REPORT_BYTES = 4096;
const TEMP_PATTERN = /^\.event-(?<sequence>[0-9]{16})\.tmp$/u;
const EMPTY = 0;
const START = 0;
const EXTRA_BYTE = 1;
const NO_INDEX = -1;

/**
 * @param {number} descriptor
 * @param {number} size
 * @returns {Buffer}
 */
function readDescriptor(descriptor, size) {
  const buffer = Buffer.alloc(size + EXTRA_BYTE);
  let totalBytes = START;
  while (totalBytes < buffer.length) {
    const bytesRead = readSync(descriptor, buffer, totalBytes, buffer.length - totalBytes, totalBytes);
    if (bytesRead === EMPTY) {
      break;
    }
    totalBytes += bytesRead;
  }
  return buffer.subarray(START, totalBytes);
}

/**
 * @param {number} descriptor
 * @param {Stats} before
 * @param {number} maxRecordBytes
 * @returns {string}
 */
function readOpenRecord(descriptor, before, maxRecordBytes) {
  const opened = fstatSync(descriptor);
  validateOwnedFile(opened, FILE_MODE, SINGLE_LINKS);
  if (!sameIdentity(opened, identityOf(before)) || opened.size !== before.size) {
    throw new Error("record changed");
  }
  const content = readDescriptor(descriptor, opened.size);
  const after = fstatSync(descriptor);
  validateOwnedFile(after, FILE_MODE, SINGLE_LINKS);
  if (
    content.length > maxRecordBytes ||
    content.length !== opened.size ||
    after.size !== opened.size ||
    !sameIdentity(after, identityOf(opened))
  ) {
    throw new Error("record changed");
  }
  return content.toString("utf8");
}

/**
 * @param {string} path
 * @param {Stats} before
 * @param {number} maxRecordBytes
 * @returns {string}
 */
function readRecordText(path, before, maxRecordBytes) {
  try {
    const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
    try {
      return readOpenRecord(descriptor, before, maxRecordBytes);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    throw fixedError("persistent_queue_invalid", "persistent queue record is invalid");
  }
}

/**
 * @param {RecordLimits} config
 * @param {string} serialized
 * @returns {unknown}
 */
function restoreRecordEvent(config, serialized) {
  try {
    return config.restoreEvent(serialized);
  } catch {
    throw fixedError("persistent_queue_invalid", "persistent queue record is invalid");
  }
}

/**
 * @param {string} path
 * @param {RecordLimits} config
 * @returns {LoadedRecord}
 */
function readRecord(path, config) {
  const before = lstatSync(path);
  validateOwnedFile(before, FILE_MODE, SINGLE_LINKS);
  const maxRecordBytes = Math.min(config.maxQueueBytes, config.maxBatchBytes - config.batchPrefixBytes - config.batchSuffixBytes);
  if (before.size <= EMPTY || before.size > maxRecordBytes) {
    throw fixedError("persistent_queue_invalid", "persistent queue record is invalid");
  }
  const serialized = readRecordText(path, before, maxRecordBytes);
  const byteCount = Buffer.byteLength(serialized, "utf8");
  if (byteCount !== before.size || byteCount > maxRecordBytes) {
    throw fixedError("persistent_queue_invalid", "persistent queue record is invalid");
  }
  return { byteCount, event: restoreRecordEvent(config, serialized), identity: identityOf(before), serialized };
}

/**
 * @param {string} temporaryPath
 * @param {string} finalPath
 * @returns {void}
 */
function validatePublication(temporaryPath, finalPath) {
  const temporaryStat = lstatSync(temporaryPath);
  validateOwnedFile(temporaryStat, FILE_MODE, SINGLE_OR_DOUBLE_LINKS);
  const finalStat = lstatOptional(finalPath);
  if (finalStat !== undefined && !sameIdentity(finalStat, identityOf(temporaryStat))) {
    throw fixedError("persistent_queue_invalid", "persistent queue publication is invalid");
  }
  if (finalStat !== undefined) {
    validateOwnedFile(finalStat, FILE_MODE, DOUBLE_LINKS);
  }
}

/**
 * @param {string} childPath
 * @param {string} temporaryName
 * @returns {void}
 */
function reconcileTemporaryRecord(childPath, temporaryName) {
  const sequence = TEMP_PATTERN.exec(temporaryName)?.groups?.["sequence"] ?? "";
  const temporaryPath = nodePath.join(childPath, temporaryName);
  const finalPath = nodePath.join(childPath, `event-${sequence}.json`);
  validatePublication(temporaryPath, finalPath);
  try {
    unlinkSync(temporaryPath);
    fsyncDirectory(childPath);
  } catch {
    throw fixedError("persistent_queue_unavailable", "persistent queue recovery failed");
  }
}

/**
 * @param {string} childPath
 * @returns {void}
 */
function reconcileTemporaryRecords(childPath) {
  const reportTemporaryPath = nodePath.join(childPath, CLIENT_REPORT_TEMP_NAME);
  const reportTemporaryStat = lstatOptional(reportTemporaryPath);
  if (reportTemporaryStat !== undefined) {
    validateOwnedFile(reportTemporaryStat, FILE_MODE, SINGLE_LINKS);
    unlinkSync(reportTemporaryPath);
  }
  for (const temporaryName of readdirSync(childPath).filter((name) => TEMP_PATTERN.test(name))) {
    reconcileTemporaryRecord(childPath, temporaryName);
  }
}

/**
 * @param {string} path
 * @param {Readonly<{ flags: number, links: readonly number[] }>} opening
 * @param {(descriptor: number) => void} write
 * @returns {void}
 */
function writeOwnedFile(path, opening, write) {
  const descriptor = openSync(path, opening.flags, FILE_MODE);
  try {
    if (opening.links.length > EMPTY) {
      validateOwnedFile(fstatSync(descriptor), FILE_MODE, opening.links);
    }
    write(descriptor);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * @param {AdmissionPaths} paths
 * @param {string} serialized
 * @param {AdmissionProgress} progress
 * @returns {FileIdentity}
 */
function publishRecord(paths, serialized, progress) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag();
  writeOwnedFile(paths.temporaryPath, { flags, links: [] }, (descriptor) => {
    writeFileSync(descriptor, serialized, { encoding: "utf8" });
  });
  linkSync(paths.temporaryPath, paths.finalPath);
  progress.linked = true;
  const finalStat = lstatSync(paths.finalPath);
  validateOwnedFile(finalStat, FILE_MODE, DOUBLE_LINKS);
  const identity = identityOf(finalStat);
  fsyncDirectory(paths.childPath);
  return identity;
}

/**
 * @param {AdmissionPaths} paths
 * @param {boolean} linked
 * @returns {void}
 */
function rollbackAdmission(paths, linked) {
  let failed = false;
  for (const path of linked ? [paths.finalPath, paths.temporaryPath] : [paths.temporaryPath]) {
    try {
      unlinkSync(path);
    } catch (error) {
      failed ||= errorCode(error) !== "ENOENT";
    }
  }
  failed = !attempt(() => {
    fsyncDirectory(paths.childPath);
  }) || failed;
  if (failed) {
    throw fixedError("persistent_queue_unavailable", "persistent queue admission rollback failed");
  }
}

/**
 * @param {AdmissionPaths} paths
 * @param {string} serialized
 * @param {() => void} onRollbackFailure
 * @returns {FileIdentity}
 */
function publishOrRollback(paths, serialized, onRollbackFailure) {
  /** @type {AdmissionProgress} */
  const progress = { linked: false };
  try {
    return publishRecord(paths, serialized, progress);
  } catch {
    try {
      rollbackAdmission(paths, progress.linked);
    } catch (rollbackError) {
      onRollbackFailure();
      throw rollbackError;
    }
    throw fixedError("persistent_queue_unavailable", "persistent queue admission failed");
  }
}

/**
 * @param {AdmissionPaths} paths
 * @param {string} serialized
 * @param {() => void} onRollbackFailure
 * @returns {FileIdentity}
 */
function admitRecord(paths, serialized, onRollbackFailure) {
  const identity = publishOrRollback(paths, serialized, onRollbackFailure);
  attempt(() => {
    unlinkSync(paths.temporaryPath);
    fsyncDirectory(paths.childPath);
  });
  return identity;
}

/**
 * @param {string} path
 * @param {FileIdentity} identity
 * @param {string | undefined} temporaryPath
 * @returns {void}
 */
function validateRecordIdentity(path, identity, temporaryPath) {
  const temporaryStat = temporaryPath === undefined ? undefined : lstatOptional(temporaryPath);
  if (temporaryStat !== undefined) {
    validateOwnedFile(temporaryStat, FILE_MODE, DOUBLE_LINKS);
    if (!sameIdentity(temporaryStat, identity)) {
      throw new Error("record changed");
    }
  }
  const stat = lstatSync(path);
  validateOwnedFile(stat, FILE_MODE, temporaryStat === undefined ? SINGLE_LINKS : DOUBLE_LINKS);
  if (!sameIdentity(stat, identity)) {
    throw new Error("record changed");
  }
}

/**
 * @param {unknown} indexes
 * @param {number} length
 * @returns {indexes is readonly (number | undefined)[]}
 */
function isAscendingIndexList(indexes, length) {
  if (!Array.isArray(indexes)) {
    return false;
  }
  /** @type {readonly unknown[]} */
  const values = indexes;
  return values.every((index, position) => {
    const previous = position === START ? NO_INDEX : values[position + NO_INDEX];
    return typeof index === "number" && Number.isInteger(index) && index < length && typeof previous === "number" && index > previous;
  });
}

/**
 * @param {string} path
 * @returns {unknown}
 */
function readReportFile(path) {
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    const buffer = Buffer.alloc(MAX_CLIENT_REPORT_BYTES + EXTRA_BYTE);
    /** @type {unknown} */
    const report = JSON.parse(buffer.subarray(START, readSync(descriptor, buffer, START, buffer.length, START)).toString("utf8"));
    return report;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * @param {string} childPath
 * @returns {unknown}
 */
function readClientReport(childPath) {
  const path = nodePath.join(childPath, CLIENT_REPORT_NAME);
  const stat = lstatOptional(path);
  if (stat === undefined) {
    return undefined;
  }
  validateOwnedFile(stat, FILE_MODE, SINGLE_LINKS);
  if (stat.size > MAX_CLIENT_REPORT_BYTES) {
    throw fixedError("persistent_queue_invalid", "persistent queue client report is invalid");
  }
  return readReportFile(path);
}

/**
 * @param {string} childPath
 * @param {unknown} state
 * @returns {void}
 */
function writeClientReport(childPath, state) {
  /** @type {string} */
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CLIENT_REPORT_BYTES) {
    throw fixedError("persistent_queue_invalid", "persistent queue client report is invalid");
  }
  const temporaryPath = nodePath.join(childPath, CLIENT_REPORT_TEMP_NAME);
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollowFlag();
    writeOwnedFile(temporaryPath, { flags, links: SINGLE_LINKS }, (descriptor) => {
      writeFileSync(descriptor, serialized, { encoding: "utf8" });
    });
    renameSync(temporaryPath, nodePath.join(childPath, CLIENT_REPORT_NAME));
    fsyncDirectory(childPath);
  } catch {
    throw fixedError("persistent_queue_unavailable", "persistent queue client report could not be saved");
  }
}

module.exports = {
  CLIENT_REPORT_NAME,
  admitRecord,
  isAscendingIndexList,
  readClientReport,
  readRecord,
  reconcileTemporaryRecords,
  validateRecordIdentity,
  writeClientReport
};
