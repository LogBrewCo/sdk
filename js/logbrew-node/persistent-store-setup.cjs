"use strict";

const { Buffer } = require("node:buffer");
const fs = require("node:fs");
const nodePath = require("node:path");
const { readOptionalMember } = require("./internal.cjs");
const { PERMISSION_BITS, PRIVATE_DIRECTORY_MODE, errorCode } = require("./persistent-store-files.cjs");

/**
 * @import { FailFactory, QueueDirectory } from "./persistent-store-files.cjs"
 * @import { StoreLimits } from "./persistent-store-state.cjs"
 */

/**
 * @typedef {new (code: string, message: string) => Error} ErrorConstructor
 * @typedef {Readonly<{
 *   SdkError: unknown,
 *   directory: unknown,
 *   encryptionKey: unknown,
 *   limits: unknown,
 *   onWarning: unknown,
 *   sdkName: unknown
 * }>} StoreDependencies
 * @typedef {Readonly<{
 *   SdkError: ErrorConstructor,
 *   directory: string,
 *   encryptionKey: Uint8Array,
 *   limits: StoreLimits,
 *   sdkName: string
 * }>} ValidDependencies
 */

const KEY_BYTES = 32;
const NO_OWNER = -1;
const LIMIT_NAMES = ["maxBatchBytes", "maxBatchEvents", "maxQueueBytes", "maxQueueSize"];
const NO_LIMIT = 0;

/**
 * @param {unknown} value
 * @returns {value is ErrorConstructor}
 */
function isErrorConstructor(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} directory
 * @returns {boolean}
 */
function isQueuePath(directory) {
  return typeof directory === "string" &&
    directory !== "" &&
    nodePath.isAbsolute(directory) &&
    nodePath.resolve(directory) === directory &&
    nodePath.parse(directory).root !== directory;
}

/**
 * @param {unknown} encryptionKey
 * @returns {encryptionKey is Uint8Array}
 */
function isEncryptionKey(encryptionKey) {
  return (Buffer.isBuffer(encryptionKey) || encryptionKey instanceof Uint8Array) && encryptionKey.byteLength === KEY_BYTES;
}

/**
 * @param {unknown} limits
 * @param {ErrorConstructor} SdkError
 * @returns {asserts limits is StoreLimits}
 */
function validateLimits(limits, SdkError) {
  for (const name of LIMIT_NAMES) {
    const value = readOptionalMember(limits, name);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= NO_LIMIT) {
      throw new SdkError("configuration_error", `persistent queue ${name} is invalid`);
    }
  }
}

/**
 * @param {StoreDependencies} dependencies
 * @param {ErrorConstructor} SdkError
 * @returns {void}
 */
function validateOptions(dependencies, SdkError) {
  const { directory, encryptionKey, onWarning, sdkName } = dependencies;
  if (!isQueuePath(directory)) {
    throw new SdkError("configuration_error", "persistentQueue.directory must be an absolute normalized path below the filesystem root");
  }
  if (!isEncryptionKey(encryptionKey)) {
    throw new SdkError("configuration_error", "persistentQueue.encryptionKey must contain exactly 32 bytes");
  }
  if (onWarning !== undefined && typeof onWarning !== "function") {
    throw new SdkError("configuration_error", "persistentQueue.onWarning must be a function");
  }
  if (typeof sdkName !== "string" || sdkName === "") {
    throw new SdkError("configuration_error", "persistent queue SDK identity is invalid");
  }
}

/**
 * @param {StoreDependencies} dependencies
 * @returns {ValidDependencies}
 */
function validateDependencies(dependencies) {
  const { SdkError, directory, encryptionKey, limits, sdkName } = dependencies;
  if (!isErrorConstructor(SdkError)) {
    throw new TypeError("SdkError must be a constructor");
  }
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    throw new SdkError("configuration_error", "persistentQueue is supported only on POSIX runtimes");
  }
  validateOptions(dependencies, SdkError);
  validateLimits(limits, SdkError);
  if (typeof directory !== "string" || !isEncryptionKey(encryptionKey) || typeof sdkName !== "string") {
    throw new TypeError("persistent queue dependencies are invalid");
  }
  return { SdkError, directory, encryptionKey, limits, sdkName };
}

/**
 * @param {string} current
 * @param {FailFactory} fail
 * @returns {fs.Stats}
 */
function createSegment(current, fail) {
  try {
    fs.mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
    return fs.lstatSync(current);
  } catch (mkdirError) {
    if (errorCode(mkdirError) !== "EEXIST") {
      throw fail("persistent queue directory could not be created");
    }
    return fs.lstatSync(current);
  }
}

/**
 * @param {string} current
 * @param {FailFactory} fail
 * @returns {fs.Stats}
 */
function lstatOrCreate(current, fail) {
  try {
    return fs.lstatSync(current);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw fail("persistent queue path could not be inspected");
    }
    return createSegment(current, fail);
  }
}

/**
 * @param {string} current
 * @param {FailFactory} fail
 * @returns {void}
 */
function ensureSegment(current, fail) {
  const stat = lstatOrCreate(current, fail);
  if (stat.isSymbolicLink()) {
    throw fail("persistent queue path must not contain symbolic links");
  }
  if (!stat.isDirectory()) {
    throw fail("persistent queue path must contain only directories");
  }
}

/**
 * @param {string} directory
 * @param {FailFactory} fail
 * @returns {QueueDirectory}
 */
function prepareQueueDirectory(directory, fail) {
  const owner = typeof process.getuid === "function" ? process.getuid() : NO_OWNER;
  const { root } = nodePath.parse(directory);
  let current = root;
  for (const segment of directory.slice(root.length).split(nodePath.sep).filter(Boolean)) {
    current = nodePath.join(current, segment);
    ensureSegment(current, fail);
  }
  const stat = fs.lstatSync(directory);
  if (stat.uid !== owner || (stat.mode & PERMISSION_BITS) !== PRIVATE_DIRECTORY_MODE) {
    throw fail("persistent queue directory must be private and owned by the current user");
  }
  return { dev: stat.dev, ino: stat.ino, owner, path: directory };
}

module.exports = { prepareQueueDirectory, validateDependencies };
