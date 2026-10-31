"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const nodePath = require("node:path");
const { attempt, readOptionalMember } = require("./internal.cjs");

/**
 * @typedef {(message: string) => Error} FailFactory
 * @typedef {Readonly<{ dev: number, ino: number, owner: number, path: string }>} QueueDirectory
 * @typedef {Readonly<{
 *   directory: QueueDirectory,
 *   fail: FailFactory,
 *   failCommit: FailFactory,
 *   onWarning: unknown
 * }>} StoreScope
 * @typedef {Readonly<{ data: Buffer, label: string, name: string }>} StoreFile
 * @typedef {{ renamed: boolean }} WriteProgress
 * @typedef {Readonly<{ finalPath: string, progress: WriteProgress, tempPath: string }>} WriteTarget
 */

const MANIFEST_FILE = "manifest.json";
const ACCEPTED_FILE = ".accepted";
const TEMP_FILE_PATTERN = /^\.(?:accepted|event|manifest)\.tmp-[0-9a-f]{32}$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;
const SINGLE_LINK = 1;
const TEMP_ID_BYTES = 16;
const NO_DESCRIPTOR = -1;
const PERSISTENCE_CODES = new Set(["persistence_error", "persistence_commit_error"]);

/**
 * @param {unknown} error
 * @returns {unknown}
 */
function errorCode(error) {
  return readOptionalMember(error, "code");
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isForeignError(error) {
  const code = errorCode(error);
  return Boolean(code) && !(typeof code === "string" && PERSISTENCE_CODES.has(code));
}

/**
 * @param {unknown} onWarning
 * @param {Readonly<{ code: string }>} warning
 * @returns {void}
 */
function notify(onWarning, warning) {
  if (typeof onWarning !== "function") {
    return;
  }
  attempt(() => {
    Reflect.apply(onWarning, undefined, [warning]);
  });
}

/**
 * @param {StoreScope} scope
 * @returns {fs.Stats}
 */
function attemptPinnedStat(scope) {
  try {
    return fs.lstatSync(scope.directory.path);
  } catch {
    throw scope.fail("persistent queue directory identity changed");
  }
}

/**
 * @param {StoreScope} scope
 * @param {string} path
 * @param {string} label
 * @returns {fs.Stats}
 */
function attemptStat(scope, path, label) {
  try {
    return fs.lstatSync(path);
  } catch {
    throw scope.fail(`${label} could not be inspected`);
  }
}

/**
 * @param {StoreScope} scope
 * @param {string} directory
 * @param {string} label
 * @returns {void}
 */
function assertPrivateDirectory(scope, directory, label) {
  const stat = attemptStat(scope, directory, label);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== scope.directory.owner ||
    (stat.mode & PERMISSION_BITS) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw scope.fail(`${label} must be private and owned by the current user`);
  }
}

/**
 * @param {StoreScope} scope
 * @param {string} filename
 * @param {string} label
 * @returns {void}
 */
function assertPrivateFile(scope, filename, label) {
  const stat = attemptStat(scope, filename, label);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.uid !== scope.directory.owner ||
    stat.nlink !== SINGLE_LINK ||
    (stat.mode & PERMISSION_BITS) !== PRIVATE_FILE_MODE
  ) {
    throw scope.fail(`${label} must be private, regular, single-linked, and owned by the current user`);
  }
}

/**
 * @param {StoreScope} scope
 * @param {string} directory
 * @returns {void}
 */
function fsyncDirectory(scope, directory) {
  const descriptor = { value: NO_DESCRIPTOR };
  try {
    descriptor.value = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor.value);
  } catch {
    throw scope.fail("persistent queue directory could not be synchronized");
  } finally {
    if (descriptor.value !== NO_DESCRIPTOR) {
      fs.closeSync(descriptor.value);
    }
  }
}

/**
 * @param {string} filename
 * @returns {string}
 */
function tempPrefix(filename) {
  if (filename === ACCEPTED_FILE) {
    return "accepted";
  }
  return filename === MANIFEST_FILE ? "manifest" : "event";
}

/**
 * @param {string} tempPath
 * @param {Buffer} data
 * @returns {void}
 */
function writeTempFile(tempPath, data) {
  const descriptor = fs.openSync(tempPath, "wx", PRIVATE_FILE_MODE);
  const open = { value: true };
  try {
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    open.value = false;
    fs.closeSync(descriptor);
  } finally {
    if (open.value) {
      attempt(() => {
        fs.closeSync(descriptor);
      });
    }
  }
}

/**
 * @param {StoreScope} scope
 * @param {StoreFile} file
 * @param {WriteTarget} target
 * @returns {void}
 */
function publishFile(scope, file, target) {
  writeTempFile(target.tempPath, file.data);
  assertPrivateFile(scope, target.tempPath, `${file.label} temporary file`);
  fs.renameSync(target.tempPath, target.finalPath);
  target.progress.renamed = true;
  assertPrivateFile(scope, target.finalPath, file.label);
}

/**
 * @param {StoreScope} scope
 * @param {string} directory
 * @param {StoreFile} file
 * @returns {void}
 */
function atomicWriteInDirectory(scope, directory, file) {
  const tempPath = nodePath.join(directory, `.${tempPrefix(file.name)}.tmp-${crypto.randomBytes(TEMP_ID_BYTES).toString("hex")}`);
  /** @type {WriteTarget} */
  const target = { finalPath: nodePath.join(directory, file.name), progress: { renamed: false }, tempPath };
  try {
    publishFile(scope, file, target);
  } catch (error) {
    attempt(() => {
      fs.unlinkSync(tempPath);
    });
    if (target.progress.renamed) {
      throw scope.failCommit(`${file.label} commit could not be confirmed`);
    }
    throw isForeignError(error) ? scope.fail(`${file.label} could not be written`) : error;
  }
}

/**
 * @param {StoreScope} scope
 * @returns {void}
 */
function assertPinnedDirectory(scope) {
  const { directory } = scope;
  const stat = attemptPinnedStat(scope);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== directory.owner ||
    (stat.mode & PERMISSION_BITS) !== PRIVATE_DIRECTORY_MODE ||
    stat.dev !== directory.dev ||
    stat.ino !== directory.ino
  ) {
    throw scope.fail("persistent queue directory identity changed");
  }
}

/**
 * @param {StoreScope} scope
 * @param {StoreFile} file
 * @returns {void}
 */
function atomicWrite(scope, file) {
  assertPinnedDirectory(scope);
  atomicWriteInDirectory(scope, scope.directory.path, file);
  try {
    fsyncDirectory(scope, scope.directory.path);
  } catch {
    throw scope.failCommit(`${file.label} commit could not be confirmed`);
  }
}

module.exports = {
  ACCEPTED_FILE,
  MANIFEST_FILE,
  PERMISSION_BITS,
  PRIVATE_DIRECTORY_MODE,
  TEMP_FILE_PATTERN,
  assertPinnedDirectory,
  assertPrivateDirectory,
  assertPrivateFile,
  atomicWrite,
  atomicWriteInDirectory,
  errorCode,
  fsyncDirectory,
  isForeignError,
  notify
};
