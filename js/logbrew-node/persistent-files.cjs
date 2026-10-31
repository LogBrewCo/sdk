"use strict";

const { closeSync, constants, fsyncSync, lstatSync, openSync } = require("node:fs");
const { SdkError } = require("@logbrew/sdk");
const { attempt, readOptionalMember } = require("./internal.cjs");

/**
 * @import { Stats } from "node:fs"
 */

/**
 * @typedef {Readonly<{ device: number, inode: number }>} FileIdentity
 */

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const PERMISSION_BITS = 0o777;
const NO_FLAG = 0;
const SINGLE_LINK = 1;
const DOUBLE_LINK = 2;
/** @type {readonly number[]} */
const SINGLE_LINKS = [SINGLE_LINK];
/** @type {readonly number[]} */
const DOUBLE_LINKS = [DOUBLE_LINK];
/** @type {readonly number[]} */
const SINGLE_OR_DOUBLE_LINKS = [SINGLE_LINK, DOUBLE_LINK];

/**
 * @param {string} code
 * @param {string} message
 * @returns {SdkError}
 */
function fixedError(code, message) {
  return new SdkError(code, message);
}

/**
 * @param {unknown} error
 * @returns {unknown}
 */
function errorCode(error) {
  return readOptionalMember(error, "code");
}

/**
 * @returns {number}
 */
function noFollowFlag() {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : NO_FLAG;
}

/**
 * @param {string} path
 * @returns {void}
 */
function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * @param {number | undefined} descriptor
 * @returns {void}
 */
function closeQuietly(descriptor) {
  if (descriptor === undefined) {
    return;
  }
  attempt(() => {
    closeSync(descriptor);
  });
}

/**
 * @param {string} path
 * @returns {Stats | undefined}
 */
function lstatOptional(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw fixedError("persistent_queue_unavailable", "persistent queue storage is unavailable");
  }
}

/**
 * @param {Stats} stat
 * @returns {FileIdentity}
 */
function identityOf(stat) {
  return { device: stat.dev, inode: stat.ino };
}

/**
 * @param {Stats} stat
 * @param {FileIdentity} identity
 * @returns {boolean}
 */
function sameIdentity(stat, identity) {
  return stat.dev === identity.device && stat.ino === identity.inode;
}

/**
 * @returns {number | undefined}
 */
function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * @param {Stats} stat
 * @param {number} mode
 * @returns {void}
 */
function validateOwnedMode(stat, mode) {
  if ((stat.mode & PERMISSION_BITS) !== mode || stat.uid !== currentUid()) {
    throw fixedError("persistent_queue_invalid", "persistent queue permissions are invalid");
  }
}

/**
 * @param {Stats} stat
 * @param {number} mode
 * @param {readonly number[]} links
 * @returns {void}
 */
function validateOwnedFile(stat, mode, links) {
  if (!stat.isFile() || stat.isSymbolicLink() || !links.includes(stat.nlink)) {
    throw fixedError("persistent_queue_invalid", "persistent queue file is invalid");
  }
  validateOwnedMode(stat, mode);
}

/**
 * @param {string} path
 * @returns {void}
 */
function validateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw fixedError("persistent_queue_invalid", "persistent queue storage is invalid");
  }
  validateOwnedMode(stat, DIRECTORY_MODE);
}

/**
 * @returns {void}
 */
function requireSupportedPlatform() {
  if (process.platform === "win32" || typeof process.getuid !== "function" || noFollowFlag() === NO_FLAG) {
    throw fixedError("configuration_error", "persistent queue requires owner only storage");
  }
}

module.exports = {
  DIRECTORY_MODE,
  DOUBLE_LINKS,
  FILE_MODE,
  SINGLE_LINKS,
  SINGLE_OR_DOUBLE_LINKS,
  closeQuietly,
  errorCode,
  fixedError,
  fsyncDirectory,
  identityOf,
  lstatOptional,
  noFollowFlag,
  requireSupportedPlatform,
  sameIdentity,
  validateDirectory,
  validateOwnedFile,
  validateOwnedMode
};
