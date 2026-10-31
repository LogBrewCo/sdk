"use strict";

const { Buffer } = require("node:buffer");
const fs = require("node:fs");
const nodePath = require("node:path");
const { attempt, isObjectLike } = require("./internal.cjs");
const {
  PRIVATE_DIRECTORY_MODE,
  TEMP_FILE_PATTERN,
  assertPinnedDirectory,
  assertPrivateDirectory,
  assertPrivateFile,
  atomicWriteInDirectory,
  errorCode,
  fsyncDirectory,
  isForeignError,
  notify
} = require("./persistent-store-files.cjs");

/**
 * @import { StoreScope } from "./persistent-store-files.cjs"
 */

/**
 * @typedef {Readonly<{ lease: unknown, pid: number }>} LockOwner
 */

const LOCK_DIRECTORY = ".lock";
const LOCK_OWNER_FILE = "owner.json";
const LOCK_LEASE_PATTERN = /^[0-9a-f]{32}$/u;
const LOCK_ATTEMPTS = 2;
const NO_PROCESS = 0;
const SIGNAL_PROBE = 0;
const SINGLE_ENTRY = 1;
/** @type {(value: unknown) => string} */
const text = String;

/**
 * @param {string} lockPath
 * @returns {void}
 */
function removeIncompleteLease(lockPath) {
  attempt(() => {
    for (const entry of fs.readdirSync(lockPath)) {
      if (entry === LOCK_OWNER_FILE || TEMP_FILE_PATTERN.test(entry)) {
        fs.unlinkSync(nodePath.join(lockPath, entry));
      }
    }
    fs.rmdirSync(lockPath);
  });
}

/**
 * @param {StoreScope} scope
 * @param {string} lockPath
 * @param {string} ownerLease
 * @returns {void}
 */
function writeLock(scope, lockPath, ownerLease) {
  atomicWriteInDirectory(scope, lockPath, {
    data: Buffer.from(JSON.stringify({
      lease: ownerLease,
      pid: process.pid
    })),
    label: "lock owner",
    name: LOCK_OWNER_FILE
  });
  fsyncDirectory(scope, lockPath);
  fsyncDirectory(scope, scope.directory.path);
}

/**
 * @param {StoreScope} scope
 * @param {unknown} error
 * @returns {false}
 */
function lockExists(scope, error) {
  if (errorCode(error) !== "EEXIST") {
    throw isForeignError(error) ? scope.fail("persistent queue lock could not be acquired") : error;
  }
  return false;
}

/**
 * @param {StoreScope} scope
 * @param {string} lockPath
 * @param {string} ownerLease
 * @returns {boolean}
 */
function tryCreateLock(scope, lockPath, ownerLease) {
  assertPinnedDirectory(scope);
  const progress = { created: false };
  try {
    fs.mkdirSync(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
    progress.created = true;
    writeLock(scope, lockPath, ownerLease);
    return true;
  } catch (error) {
    if (progress.created) {
      removeIncompleteLease(lockPath);
    }
    return lockExists(scope, error);
  }
}

/**
 * @param {string} content
 * @returns {LockOwner}
 */
function parseLockOwner(content) {
  /** @type {unknown} */
  const value = JSON.parse(content);
  if (!isObjectLike(value)) {
    throw new Error("invalid owner");
  }
  const keys = Object.keys(value);
  keys.sort();
  /** @type {unknown} */
  const pid = Reflect.get(value, "pid");
  if (keys.join(",") !== "lease,pid" || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= NO_PROCESS || !LOCK_LEASE_PATTERN.test(text(Reflect.get(value, "lease")))) {
    throw new Error("invalid owner");
  }
  return { lease: Reflect.get(value, "lease"), pid };
}

/**
 * @param {StoreScope} scope
 * @param {string} lockPath
 * @returns {LockOwner}
 */
function readLockOwner(scope, lockPath) {
  assertPrivateDirectory(scope, lockPath, "persistent queue lock");
  const entries = fs.readdirSync(lockPath);
  const [entry] = entries;
  if (entries.length !== SINGLE_ENTRY || entry !== LOCK_OWNER_FILE) {
    throw scope.fail("persistent queue lock state is invalid");
  }
  const ownerPath = nodePath.join(lockPath, LOCK_OWNER_FILE);
  assertPrivateFile(scope, ownerPath, "persistent queue lock owner");
  try {
    return parseLockOwner(fs.readFileSync(ownerPath, "utf8"));
  } catch {
    throw scope.fail("persistent queue lock state is invalid");
  }
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function processIsAlive(pid) {
  try {
    process.kill(pid, SIGNAL_PROBE);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

/**
 * @param {StoreScope} scope
 * @param {string} lockPath
 * @returns {void}
 */
function removeStaleLock(scope, lockPath) {
  const ownerPath = nodePath.join(lockPath, LOCK_OWNER_FILE);
  assertPrivateFile(scope, ownerPath, "persistent queue lock owner");
  try {
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockPath);
  } catch {
    throw scope.fail("stale persistent queue lock could not be removed");
  }
}

/**
 * @param {StoreScope} scope
 * @param {string} ownerLease
 * @returns {void}
 */
function acquireLock(scope, ownerLease) {
  const lockPath = nodePath.join(scope.directory.path, LOCK_DIRECTORY);
  for (let round = 0; round < LOCK_ATTEMPTS; round += SINGLE_ENTRY) {
    if (tryCreateLock(scope, lockPath, ownerLease)) {
      return;
    }
    const owner = readLockOwner(scope, lockPath);
    if (processIsAlive(owner.pid)) {
      throw scope.fail("persistent queue is already in use");
    }
    removeStaleLock(scope, lockPath);
    notify(scope.onWarning, { code: "stale_lock_recovered" });
  }
  throw scope.fail("persistent queue lock could not be acquired");
}

/**
 * @param {StoreScope} scope
 * @param {string} lockPath
 * @returns {void}
 */
function removeOwnLock(scope, lockPath) {
  try {
    fs.unlinkSync(nodePath.join(lockPath, LOCK_OWNER_FILE));
    fs.rmdirSync(lockPath);
  } catch {
    throw scope.fail("persistent queue lock could not be released");
  }
}

/**
 * @param {StoreScope} scope
 * @param {string} ownerLease
 * @returns {void}
 */
function releaseLock(scope, ownerLease) {
  const lockPath = nodePath.join(scope.directory.path, LOCK_DIRECTORY);
  const owner = readLockOwner(scope, lockPath);
  if (owner.pid !== process.pid || owner.lease !== ownerLease) {
    throw scope.fail("persistent queue lock ownership changed");
  }
  removeOwnLock(scope, lockPath);
  try {
    fsyncDirectory(scope, scope.directory.path);
  } catch {
    throw scope.failCommit("persistent queue lock release could not be confirmed");
  }
}

module.exports = { LOCK_DIRECTORY, acquireLock, releaseLock };
