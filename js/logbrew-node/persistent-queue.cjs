"use strict";

const { Buffer } = require("node:buffer");
const { randomBytes } = require("node:crypto");
const {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} = require("node:fs");
const { resolve, join } = require("node:path");
const { clearInterval, setInterval } = require("node:timers");
const { SdkError } = require("@logbrew/sdk");

const CHILD_NAME = "logbrew-node-queue-v1";
const OWNER_NAME = ".owner";
const RECLAIM_NAME = ".owner-reclaim";
const RECORD_PATTERN = /^event-([0-9]{16})\.json$/u;
const TEMP_PATTERN = /^\.event-([0-9]{16})\.tmp$/u;
const LEASE_PATTERN = /^lease-([0-9a-f]{32})$/u;
const STALE_LEASE_MS = 30_000;
const HEARTBEAT_MS = 1_000;
const MAX_SEQUENCE = 9_999_999_999_999_999n;

class PersistentEventQueue {
  constructor(config, storage, owner) {
    this.config = config;
    this.storage = storage;
    this.owner = owner;
    this.ownerPid = process.pid;
    this.records = [];
    this.totalBytes = 0;
    this.nextSequence = 1n;
    this.closed = false;
    this.load();
    this.owner.startHeartbeat();
  }

  length() {
    this.assertUsable();
    return this.records.length;
  }

  byteCount() {
    this.assertUsable();
    return this.totalBytes;
  }

  events() {
    this.assertUsable();
    return this.records.map((record) => record.event);
  }

  serializedAt(index) {
    this.assertUsable();
    return this.recordAt(index).serialized;
  }

  eventBytesAt(index) {
    this.assertUsable();
    return this.recordAt(index).byteCount;
  }

  append(record) {
    this.assertUsable();
    if (this.nextSequence > MAX_SEQUENCE) {
      throw fixedError("persistent_queue_unavailable", "persistent queue sequence is exhausted");
    }
    const sequence = this.nextSequence.toString().padStart(16, "0");
    const name = `event-${sequence}.json`;
    const temporaryName = `.event-${sequence}.tmp`;
    const finalPath = join(this.storage.childPath, name);
    const temporaryPath = join(this.storage.childPath, temporaryName);
    let descriptor;
    let identity;
    let linked = false;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
        0o600
      );
      writeFileSync(descriptor, record.serialized, { encoding: "utf8" });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      linkSync(temporaryPath, finalPath);
      linked = true;
      const finalStat = lstatSync(finalPath);
      validateOwnedFile(finalStat, 0o600, [2]);
      identity = identityOf(finalStat);
      fsyncDirectory(this.storage.childPath);
    } catch {
      closeQuietly(descriptor);
      try {
        rollbackAdmission(this.storage.childPath, temporaryPath, finalPath, linked);
      } catch (rollbackError) {
        this.closed = true;
        throw rollbackError;
      }
      throw fixedError("persistent_queue_unavailable", "persistent queue admission failed");
    }
    finishPublishedAdmission(this.storage.childPath, temporaryPath);
    this.records.push({ ...record, identity, name, temporaryName });
    this.totalBytes += record.byteCount;
    this.nextSequence += 1n;
  }

  acknowledge(count) {
    this.assertUsable();
    if (!Number.isInteger(count) || count < 0 || count > this.records.length) {
      throw fixedError("persistent_queue_invalid", "persistent queue acknowledgement is invalid");
    }
    for (let index = 0; index < count; index += 1) {
      const record = this.records[0];
      try {
        const temporaryPath = record.temporaryName === undefined
          ? undefined
          : join(this.storage.childPath, record.temporaryName);
        validateRecordIdentity(
          join(this.storage.childPath, record.name),
          record.identity,
          temporaryPath
        );
        unlinkSync(join(this.storage.childPath, record.name));
        fsyncDirectory(this.storage.childPath);
      } catch {
        throw fixedError("persistent_queue_unavailable", "persistent queue acknowledgement failed");
      }
      this.records.shift();
      this.totalBytes -= record.byteCount;
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.assertProcess();
    this.owner.release();
    this.closed = true;
  }

  load() {
    reconcileTemporaryRecords(this.storage.childPath);
    const entries = readdirSync(this.storage.childPath).filter((name) => name !== OWNER_NAME);
    const recordNames = entries.filter((name) => RECORD_PATTERN.test(name)).sort();
    if (recordNames.length !== entries.length || recordNames.length > this.config.maxQueueSize) {
      throw fixedError("persistent_queue_invalid", "persistent queue contents are invalid");
    }
    let highestSequence = 0n;
    for (const name of recordNames) {
      const sequence = BigInt(RECORD_PATTERN.exec(name)[1]);
      if (
        sequence < 1n
        || highestSequence !== 0n && sequence !== highestSequence + 1n
      ) {
        throw fixedError("persistent_queue_invalid", "persistent queue order is invalid");
      }
      highestSequence = sequence;
      const loaded = readRecord(join(this.storage.childPath, name), this.config);
      if (this.totalBytes + loaded.byteCount > this.config.maxQueueBytes) {
        throw fixedError("persistent_queue_invalid", "persistent queue bounds are invalid");
      }
      this.records.push({ ...loaded, name });
      this.totalBytes += loaded.byteCount;
    }
    this.nextSequence = highestSequence === 0n ? 1n : highestSequence + 1n;
  }

  recordAt(index) {
    const record = this.records[index];
    if (!record) {
      throw fixedError("persistent_queue_invalid", "persistent queue order is invalid");
    }
    return record;
  }

  assertUsable() {
    this.assertProcess();
    if (this.closed || !this.owner.isCurrent()) {
      throw fixedError("persistent_queue_unavailable", "persistent queue ownership was lost");
    }
  }

  assertProcess() {
    if (process.pid !== this.ownerPid) {
      throw fixedError("persistent_queue_unavailable", "persistent queue process ownership changed");
    }
  }
}

class LeaseOwner {
  constructor(childPath, leasePath, markerPath, identity, markerIdentity) {
    this.childPath = childPath;
    this.leasePath = leasePath;
    this.markerPath = markerPath;
    this.identity = identity;
    this.markerIdentity = markerIdentity;
    this.ownerPid = process.pid;
    this.timer = undefined;
    this.released = false;
    this.heartbeatFailed = false;
  }

  startHeartbeat() {
    this.timer = setInterval(() => {
      if (!this.hasIdentity()) {
        this.heartbeatFailed = true;
        clearInterval(this.timer);
        this.timer = undefined;
        return;
      }
      try {
        const now = new Date();
        utimesSync(this.markerPath, now, now);
      } catch {
        this.heartbeatFailed = true;
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }, HEARTBEAT_MS);
    this.timer.unref();
  }

  isCurrent() {
    return !this.heartbeatFailed && this.hasIdentity();
  }

  hasIdentity() {
    if (this.released || process.pid !== this.ownerPid) {
      return false;
    }
    try {
      const current = lstatSync(this.leasePath);
      const marker = lstatSync(this.markerPath);
      return (
        sameIdentity(current, this.identity)
        && current.isDirectory()
        && sameIdentity(marker, this.markerIdentity)
        && marker.isFile()
        && !marker.isSymbolicLink()
      );
    } catch {
      return false;
    }
  }

  release() {
    if (!this.hasIdentity()) {
      this.stopHeartbeat(true);
      throw fixedError("persistent_queue_unavailable", "persistent queue ownership was lost");
    }
    try {
      unlinkSync(this.markerPath);
      rmdirSync(this.leasePath);
      fsyncDirectory(this.childPath);
      this.released = true;
    } catch {
      if (!this.hasIdentity()) {
        this.stopHeartbeat(true);
      }
      throw fixedError("persistent_queue_unavailable", "persistent queue release failed");
    }
    this.stopHeartbeat(false);
  }

  stopHeartbeat(failed) {
    this.heartbeatFailed ||= failed;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

function createPersistentEventQueue(config) {
  let owner;
  try {
    const storage = prepareStorage(config.persistentQueuePath, true);
    owner = acquireLease(storage.childPath);
    return new PersistentEventQueue(config, storage, owner);
  } catch (error) {
    if (owner !== undefined) {
      releaseAfterFailure(owner);
    }
    if (error instanceof SdkError) {
      throw error;
    }
    throw fixedError("persistent_queue_unavailable", "persistent queue could not be opened");
  }
}

function purgePersistentEventQueue({ persistentQueuePath } = {}) {
  let owner;
  let released = false;
  try {
    const storage = prepareStorage(persistentQueuePath, false);
    if (storage === undefined) {
      return false;
    }
    owner = acquireLease(storage.childPath);
    reconcileTemporaryRecords(storage.childPath);
    const entries = readdirSync(storage.childPath).filter((name) => name !== OWNER_NAME);
    if (entries.some((name) => !RECORD_PATTERN.test(name))) {
      throw fixedError("persistent_queue_invalid", "persistent queue contents are invalid");
    }
    for (const name of entries) {
      const path = join(storage.childPath, name);
      validatePurgeRecord(path);
      unlinkSync(path);
    }
    fsyncDirectory(storage.childPath);
    owner.release();
    released = true;
    rmdirSync(storage.childPath);
    fsyncDirectory(storage.parentPath);
    return true;
  } catch (error) {
    if (!released && owner !== undefined) {
      releaseAfterFailure(owner);
    }
    if (error instanceof SdkError) {
      throw error;
    }
    throw fixedError("persistent_queue_unavailable", "persistent queue purge failed");
  }
}

function prepareStorage(persistentQueuePath, createChild) {
  requireSupportedPlatform();
  if (typeof persistentQueuePath !== "string" || persistentQueuePath.trim() === "") {
    throw fixedError("configuration_error", "persistent queue path is required");
  }
  const requested = resolve(persistentQueuePath);
  let parentPath;
  let parentStat;
  try {
    parentPath = realpathSync(requested);
    parentStat = lstatSync(requested);
  } catch {
    throw fixedError("persistent_queue_unavailable", "persistent queue parent is unavailable");
  }
  if (parentPath !== requested || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw fixedError("persistent_queue_invalid", "persistent queue parent is invalid");
  }
  validateOwnedMode(parentStat, 0o700);
  const childPath = join(parentPath, CHILD_NAME);
  const existing = lstatOptional(childPath);
  if (existing === undefined && !createChild) {
    return undefined;
  }
  if (existing === undefined) {
    try {
      mkdirSync(childPath, { mode: 0o700 });
      fsyncDirectory(parentPath);
    } catch {
      throw fixedError("persistent_queue_unavailable", "persistent queue storage is unavailable");
    }
  }
  validateDirectory(childPath);
  return { childPath, parentPath };
}

function acquireLease(childPath) {
  reconcileReclaim(childPath);
  const leasePath = join(childPath, OWNER_NAME);
  let leaseStat = lstatOptional(leasePath);
  if (leaseStat !== undefined) {
    validateLeaseDirectory(leasePath, leaseStat);
    if (!leaseIsStale(leasePath, leaseStat)) {
      throw fixedError("persistent_queue_in_use", "persistent queue is already owned");
    }
    reclaimLease(childPath, leasePath, leaseStat);
  }
  try {
    mkdirSync(leasePath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw fixedError("persistent_queue_in_use", "persistent queue is already owned");
    }
    throw fixedError("persistent_queue_unavailable", "persistent queue ownership is unavailable");
  }
  let descriptor;
  try {
    const markerName = `lease-${randomBytes(16).toString("hex")}`;
    const markerPath = join(leasePath, markerName);
    descriptor = openSync(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(leasePath);
    fsyncDirectory(childPath);
    leaseStat = lstatSync(leasePath);
    const markerStat = lstatSync(markerPath);
    validateOwnedFile(markerStat, 0o600, [1]);
    return new LeaseOwner(
      childPath,
      leasePath,
      markerPath,
      identityOf(leaseStat),
      identityOf(markerStat)
    );
  } catch {
    closeQuietly(descriptor);
    rollbackNewLease(leasePath);
    throw fixedError("persistent_queue_unavailable", "persistent queue ownership is unavailable");
  }
}

function rollbackNewLease(leasePath) {
  try {
    removeLeaseDirectory(leasePath);
  } catch {
    // The incomplete lease remains fail-closed until its stale deadline.
  }
}

function reclaimLease(childPath, leasePath, expectedStat) {
  const reclaimPath = join(childPath, RECLAIM_NAME);
  try {
    const current = lstatSync(leasePath);
    if (!sameIdentity(current, identityOf(expectedStat)) || !leaseIsStale(leasePath, current)) {
      throw new Error("lease changed");
    }
    renameSync(leasePath, reclaimPath);
    removeLeaseDirectory(reclaimPath);
    fsyncDirectory(childPath);
  } catch {
    throw fixedError("persistent_queue_in_use", "persistent queue is already owned");
  }
}

function reconcileReclaim(childPath) {
  const reclaimPath = join(childPath, RECLAIM_NAME);
  const reclaimStat = lstatOptional(reclaimPath);
  if (reclaimStat === undefined) {
    return;
  }
  validateLeaseDirectory(reclaimPath, reclaimStat);
  if (!leaseIsStale(reclaimPath, reclaimStat)) {
    throw fixedError("persistent_queue_in_use", "persistent queue ownership is changing");
  }
  try {
    removeLeaseDirectory(reclaimPath);
    fsyncDirectory(childPath);
  } catch {
    throw fixedError("persistent_queue_unavailable", "persistent queue ownership is unavailable");
  }
}

function removeLeaseDirectory(path) {
  const entries = readdirSync(path);
  if (entries.length > 1 || entries.some((name) => !LEASE_PATTERN.test(name))) {
    throw fixedError("persistent_queue_invalid", "persistent queue ownership is invalid");
  }
  if (entries.length === 1) {
    const markerPath = join(path, entries[0]);
    validateOwnedFile(lstatSync(markerPath), 0o600, [1]);
    unlinkSync(markerPath);
  }
  rmdirSync(path);
}

function validateLeaseDirectory(path, stat) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw fixedError("persistent_queue_invalid", "persistent queue ownership is invalid");
  }
  validateOwnedMode(stat, 0o700);
  const entries = readdirSync(path);
  if (entries.length > 1 || entries.some((name) => !LEASE_PATTERN.test(name))) {
    throw fixedError("persistent_queue_invalid", "persistent queue ownership is invalid");
  }
  if (entries.length === 1) {
    validateOwnedFile(lstatSync(join(path, entries[0])), 0o600, [1]);
  }
}

function leaseIsStale(path, stat) {
  const entries = readdirSync(path);
  const timestamp = entries.length === 1 ? lstatSync(join(path, entries[0])).mtimeMs : stat.mtimeMs;
  return Date.now() - timestamp >= STALE_LEASE_MS;
}

function reconcileTemporaryRecords(childPath) {
  const names = readdirSync(childPath).filter((name) => TEMP_PATTERN.test(name));
  for (const temporaryName of names) {
    const sequence = TEMP_PATTERN.exec(temporaryName)[1];
    const finalName = `event-${sequence}.json`;
    const temporaryPath = join(childPath, temporaryName);
    const finalPath = join(childPath, finalName);
    const temporaryStat = lstatSync(temporaryPath);
    validateOwnedFile(temporaryStat, 0o600, [1, 2]);
    const finalStat = lstatOptional(finalPath);
    if (finalStat !== undefined && !sameIdentity(finalStat, identityOf(temporaryStat))) {
      throw fixedError("persistent_queue_invalid", "persistent queue publication is invalid");
    }
    if (finalStat !== undefined) {
      validateOwnedFile(finalStat, 0o600, [2]);
    }
    try {
      unlinkSync(temporaryPath);
      fsyncDirectory(childPath);
    } catch {
      throw fixedError("persistent_queue_unavailable", "persistent queue recovery failed");
    }
  }
}

function readRecord(path, config) {
  const before = lstatSync(path);
  validateOwnedFile(before, 0o600, [1]);
  const maxRecordBytes = Math.min(
    config.maxQueueBytes,
    config.maxBatchBytes - config.batchPrefixBytes - config.batchSuffixBytes
  );
  if (before.size <= 0 || before.size > maxRecordBytes) {
    throw fixedError("persistent_queue_invalid", "persistent queue record is invalid");
  }
  let descriptor;
  let serialized;
  let opened;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
    opened = fstatSync(descriptor);
    validateOwnedFile(opened, 0o600, [1]);
    if (!sameIdentity(opened, identityOf(before)) || opened.size !== before.size) {
      throw new Error("record changed");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, totalBytes, buffer.length - totalBytes, null);
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
    }
    const after = fstatSync(descriptor);
    validateOwnedFile(after, 0o600, [1]);
    if (
      totalBytes > maxRecordBytes
      || totalBytes !== opened.size
      || after.size !== opened.size
      || !sameIdentity(after, identityOf(opened))
    ) {
      throw new Error("record changed");
    }
    serialized = buffer.subarray(0, totalBytes).toString("utf8");
    closeSync(descriptor);
    descriptor = undefined;
  } catch {
    closeQuietly(descriptor);
    throw fixedError("persistent_queue_invalid", "persistent queue record is invalid");
  }
  const byteCount = Buffer.byteLength(serialized, "utf8");
  if (
    byteCount !== opened.size
    || byteCount > maxRecordBytes
  ) {
    throw fixedError("persistent_queue_invalid", "persistent queue record is invalid");
  }
  let event;
  try {
    event = config.restoreEvent(serialized);
  } catch {
    throw fixedError("persistent_queue_invalid", "persistent queue record is invalid");
  }
  return { byteCount, event, identity: identityOf(before), serialized };
}

function validatePurgeRecord(path) {
  validateOwnedFile(lstatSync(path), 0o600, [1]);
}

function validateRecordIdentity(path, identity, temporaryPath) {
  const temporaryStat = temporaryPath === undefined ? undefined : lstatOptional(temporaryPath);
  if (temporaryStat !== undefined) {
    validateOwnedFile(temporaryStat, 0o600, [2]);
    if (!sameIdentity(temporaryStat, identity)) {
      throw new Error("record changed");
    }
  }
  const stat = lstatSync(path);
  validateOwnedFile(stat, 0o600, temporaryStat === undefined ? [1] : [2]);
  if (!sameIdentity(stat, identity)) {
    throw new Error("record changed");
  }
}

function validateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw fixedError("persistent_queue_invalid", "persistent queue storage is invalid");
  }
  validateOwnedMode(stat, 0o700);
}

function validateOwnedFile(stat, mode, links) {
  if (!stat.isFile() || stat.isSymbolicLink() || !links.includes(stat.nlink)) {
    throw fixedError("persistent_queue_invalid", "persistent queue file is invalid");
  }
  validateOwnedMode(stat, mode);
}

function validateOwnedMode(stat, mode) {
  if ((stat.mode & 0o777) !== mode || stat.uid !== process.getuid()) {
    throw fixedError("persistent_queue_invalid", "persistent queue permissions are invalid");
  }
}

function requireSupportedPlatform() {
  if (process.platform === "win32" || typeof process.getuid !== "function" || noFollowFlag() === 0) {
    throw fixedError("configuration_error", "persistent queue requires owner only storage");
  }
}

function noFollowFlag() {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function rollbackAdmission(childPath, temporaryPath, finalPath, linked) {
  let failed = false;
  for (const path of linked ? [finalPath, temporaryPath] : [temporaryPath]) {
    try {
      unlinkSync(path);
    } catch (error) {
      failed ||= error?.code !== "ENOENT";
    }
  }
  try {
    fsyncDirectory(childPath);
  } catch {
    failed = true;
  }
  if (failed) {
    throw fixedError("persistent_queue_unavailable", "persistent queue admission rollback failed");
  }
}

function finishPublishedAdmission(childPath, temporaryPath) {
  try {
    unlinkSync(temporaryPath);
    fsyncDirectory(childPath);
  } catch {
    // The synced final link is admitted; recovery removes any remaining temporary link.
  }
}

function releaseAfterFailure(owner) {
  try {
    owner.release();
  } catch {
    // The lease remains fail-closed until its bounded stale deadline.
  }
}

function closeQuietly(descriptor) {
  if (descriptor === undefined) {
    return;
  }
  try {
    closeSync(descriptor);
  } catch {
    // The original fixed storage failure remains authoritative.
  }
}

function lstatOptional(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw fixedError("persistent_queue_unavailable", "persistent queue storage is unavailable");
  }
}

function identityOf(stat) {
  return { device: stat.dev, inode: stat.ino };
}

function sameIdentity(stat, identity) {
  return stat.dev === identity.device && stat.ino === identity.inode;
}

function fixedError(code, message) {
  return new SdkError(code, message);
}

module.exports = {
  CHILD_NAME,
  createPersistentEventQueue,
  purgePersistentEventQueue
};
