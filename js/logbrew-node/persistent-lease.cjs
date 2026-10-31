"use strict";

const { randomBytes } = require("node:crypto");
const {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  utimesSync
} = require("node:fs");
const nodePath = require("node:path");
const { clearInterval, setInterval } = require("node:timers");
const { attempt } = require("./internal.cjs");
const {
  DIRECTORY_MODE,
  FILE_MODE,
  SINGLE_LINKS,
  errorCode,
  fixedError,
  fsyncDirectory,
  identityOf,
  lstatOptional,
  sameIdentity,
  validateOwnedFile,
  validateOwnedMode
} = require("./persistent-files.cjs");

/**
 * @import { Stats } from "node:fs"
 * @import { FileIdentity } from "./persistent-files.cjs"
 */

/**
 * @typedef {Readonly<{
 *   isCurrent: () => boolean,
 *   release: () => void,
 *   startHeartbeat: () => void
 * }>} LeaseOwner
 * @typedef {Readonly<{ childPath: string, leasePath: string, markerPath: string }>} LeasePaths
 * @typedef {Readonly<{ lease: FileIdentity, marker: FileIdentity }>} LeaseIdentities
 * @typedef {{ heartbeatFailed: boolean, released: boolean, timer: NodeJS.Timeout | undefined }} LeaseState
 */

const OWNER_NAME = ".owner";
const RECLAIM_NAME = ".owner-reclaim";
const LEASE_PATTERN = /^lease-[0-9a-f]{32}$/u;
const STALE_LEASE_MS = 30_000;
const HEARTBEAT_MS = 1000;
const MARKER_BYTES = 16;
const MAX_LEASE_ENTRIES = 1;

/**
 * @param {string} path
 * @returns {string | undefined}
 */
function leaseMarkerName(path) {
  const entries = readdirSync(path);
  if (entries.length > MAX_LEASE_ENTRIES || entries.some((name) => !LEASE_PATTERN.test(name))) {
    throw fixedError("persistent_queue_invalid", "persistent queue ownership is invalid");
  }
  const [marker] = entries;
  return marker;
}

/**
 * @param {string} path
 * @returns {void}
 */
function removeLeaseDirectory(path) {
  const marker = leaseMarkerName(path);
  if (marker !== undefined) {
    const markerPath = nodePath.join(path, marker);
    validateOwnedFile(lstatSync(markerPath), FILE_MODE, SINGLE_LINKS);
    unlinkSync(markerPath);
  }
  rmdirSync(path);
}

/**
 * @param {string} path
 * @param {Stats} stat
 * @returns {void}
 */
function validateLeaseDirectory(path, stat) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw fixedError("persistent_queue_invalid", "persistent queue ownership is invalid");
  }
  validateOwnedMode(stat, DIRECTORY_MODE);
  const marker = leaseMarkerName(path);
  if (marker !== undefined) {
    validateOwnedFile(lstatSync(nodePath.join(path, marker)), FILE_MODE, SINGLE_LINKS);
  }
}

/**
 * @param {string} path
 * @param {Stats} stat
 * @returns {boolean}
 */
function leaseIsStale(path, stat) {
  const entries = readdirSync(path);
  const [marker] = entries;
  const timestamp = entries.length === MAX_LEASE_ENTRIES && marker !== undefined
    ? lstatSync(nodePath.join(path, marker)).mtimeMs
    : stat.mtimeMs;
  return Date.now() - timestamp >= STALE_LEASE_MS;
}

/**
 * @param {LeasePaths} paths
 * @param {LeaseIdentities} identities
 * @returns {boolean}
 */
function leaseMatches(paths, identities) {
  try {
    const current = lstatSync(paths.leasePath);
    const marker = lstatSync(paths.markerPath);
    return (
      sameIdentity(current, identities.lease) &&
      current.isDirectory() &&
      sameIdentity(marker, identities.marker) &&
      marker.isFile() &&
      !marker.isSymbolicLink()
    );
  } catch {
    return false;
  }
}

/**
 * @param {LeaseState} state
 * @param {boolean} failed
 * @returns {void}
 */
function stopHeartbeat(state, failed) {
  state.heartbeatFailed ||= failed;
  if (state.timer !== undefined) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
}

/**
 * @param {LeasePaths} paths
 * @returns {void}
 */
function removeOwnedLease(paths) {
  unlinkSync(paths.markerPath);
  rmdirSync(paths.leasePath);
  fsyncDirectory(paths.childPath);
}

/**
 * @param {LeasePaths} paths
 * @param {LeaseState} state
 * @param {() => boolean} hasIdentity
 * @returns {void}
 */
function releaseLease(paths, state, hasIdentity) {
  if (!hasIdentity()) {
    stopHeartbeat(state, true);
    throw fixedError("persistent_queue_unavailable", "persistent queue ownership was lost");
  }
  try {
    removeOwnedLease(paths);
    state.released = true;
  } catch {
    if (!hasIdentity()) {
      stopHeartbeat(state, true);
    }
    throw fixedError("persistent_queue_unavailable", "persistent queue release failed");
  }
  stopHeartbeat(state, false);
}

/**
 * @param {LeasePaths} paths
 * @param {LeaseIdentities} identities
 * @returns {LeaseOwner}
 */
function createLeaseOwner(paths, identities) {
  const ownerPid = process.pid;
  /** @type {LeaseState} */
  const state = { heartbeatFailed: false, released: false, timer: undefined };
  /**
   * @returns {boolean}
   */
  function hasIdentity() {
    return !state.released && process.pid === ownerPid && leaseMatches(paths, identities);
  }
  return {
    isCurrent: () => !state.heartbeatFailed && hasIdentity(),
    release: () => {
      releaseLease(paths, state, hasIdentity);
    },
    startHeartbeat: () => {
      state.timer = setInterval(() => {
        const renewed = hasIdentity() && attempt(() => {
          const now = new Date();
          utimesSync(paths.markerPath, now, now);
        });
        if (!renewed) {
          stopHeartbeat(state, true);
        }
      }, HEARTBEAT_MS);
      state.timer.unref();
    }
  };
}

/**
 * @param {string} childPath
 * @param {string} leasePath
 * @param {Stats} expectedStat
 * @returns {void}
 */
function reclaimLease(childPath, leasePath, expectedStat) {
  const reclaimPath = nodePath.join(childPath, RECLAIM_NAME);
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

/**
 * @param {string} childPath
 * @param {string} reclaimPath
 * @returns {void}
 */
function removeReclaimed(childPath, reclaimPath) {
  try {
    removeLeaseDirectory(reclaimPath);
    fsyncDirectory(childPath);
  } catch {
    throw fixedError("persistent_queue_unavailable", "persistent queue ownership is unavailable");
  }
}

/**
 * @param {string} childPath
 * @returns {void}
 */
function reconcileReclaim(childPath) {
  const reclaimPath = nodePath.join(childPath, RECLAIM_NAME);
  const reclaimStat = lstatOptional(reclaimPath);
  if (reclaimStat === undefined) {
    return;
  }
  validateLeaseDirectory(reclaimPath, reclaimStat);
  if (!leaseIsStale(reclaimPath, reclaimStat)) {
    throw fixedError("persistent_queue_in_use", "persistent queue ownership is changing");
  }
  removeReclaimed(childPath, reclaimPath);
}

/**
 * @param {string} childPath
 * @param {string} leasePath
 * @returns {void}
 */
function reclaimExistingLease(childPath, leasePath) {
  const leaseStat = lstatOptional(leasePath);
  if (leaseStat === undefined) {
    return;
  }
  validateLeaseDirectory(leasePath, leaseStat);
  if (!leaseIsStale(leasePath, leaseStat)) {
    throw fixedError("persistent_queue_in_use", "persistent queue is already owned");
  }
  reclaimLease(childPath, leasePath, leaseStat);
}

/**
 * @param {string} childPath
 * @param {string} leasePath
 * @returns {void}
 */
function claimLeaseDirectory(childPath, leasePath) {
  reclaimExistingLease(childPath, leasePath);
  try {
    mkdirSync(leasePath, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw fixedError("persistent_queue_in_use", "persistent queue is already owned");
    }
    throw fixedError("persistent_queue_unavailable", "persistent queue ownership is unavailable");
  }
}

/**
 * @param {string} markerPath
 * @returns {void}
 */
function createMarkerFile(markerPath) {
  const descriptor = openSync(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * @param {string} childPath
 * @param {string} leasePath
 * @returns {LeaseOwner}
 */
function createLeaseMarker(childPath, leasePath) {
  const markerPath = nodePath.join(leasePath, `lease-${randomBytes(MARKER_BYTES).toString("hex")}`);
  createMarkerFile(markerPath);
  fsyncDirectory(leasePath);
  fsyncDirectory(childPath);
  const leaseStat = lstatSync(leasePath);
  const markerStat = lstatSync(markerPath);
  validateOwnedFile(markerStat, FILE_MODE, SINGLE_LINKS);
  return createLeaseOwner({ childPath, leasePath, markerPath }, { lease: identityOf(leaseStat), marker: identityOf(markerStat) });
}

/**
 * @param {string} childPath
 * @param {string} leasePath
 * @returns {LeaseOwner}
 */
function writeLeaseMarker(childPath, leasePath) {
  try {
    return createLeaseMarker(childPath, leasePath);
  } catch {
    attempt(() => {
      removeLeaseDirectory(leasePath);
    });
    throw fixedError("persistent_queue_unavailable", "persistent queue ownership is unavailable");
  }
}

/**
 * @param {string} childPath
 * @returns {LeaseOwner}
 */
function acquireLease(childPath) {
  reconcileReclaim(childPath);
  const leasePath = nodePath.join(childPath, OWNER_NAME);
  claimLeaseDirectory(childPath, leasePath);
  return writeLeaseMarker(childPath, leasePath);
}

/**
 * @param {LeaseOwner} owner
 * @returns {void}
 */
function releaseAfterFailure(owner) {
  attempt(() => {
    owner.release();
  });
}

module.exports = { OWNER_NAME, acquireLease, releaseAfterFailure };
