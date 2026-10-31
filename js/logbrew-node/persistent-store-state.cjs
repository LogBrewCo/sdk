"use strict";

const { Buffer } = require("node:buffer");
const crypto = require("node:crypto");
const fs = require("node:fs");
const nodePath = require("node:path");
const { isObjectLike } = require("./internal.cjs");
const {
  ACCEPTED_FILE,
  MANIFEST_FILE,
  assertPrivateFile,
  atomicWrite,
  fsyncDirectory
} = require("./persistent-store-files.cjs");

/**
 * @import { StoreScope } from "./persistent-store-files.cjs"
 */

/**
 * @typedef {Readonly<{
 *   maxBatchBytes: number,
 *   maxBatchEvents: number,
 *   maxQueueBytes: number,
 *   maxQueueSize: number
 * }>} StoreLimits
 * @typedef {{ removed: boolean }} RemovalProgress
 */

const STORE_SCHEMA = 1;
const SEQUENCE_DIGITS = 16;
const ACCEPTED_PATTERN = /^(?:0|[1-9][0-9]{0,15})\n$/u;

/**
 * @param {string} sdkName
 * @param {StoreLimits} limits
 * @returns {string}
 */
function configurationHash(sdkName, limits) {
  return crypto.createHash("sha256").update(JSON.stringify({
    limits: {
      maxBatchBytes: limits.maxBatchBytes,
      maxBatchEvents: limits.maxBatchEvents,
      maxQueueBytes: limits.maxQueueBytes,
      maxQueueSize: limits.maxQueueSize
    },
    sdkName
  })).digest("hex");
}

/**
 * @param {string} content
 * @param {string} expectedHash
 * @returns {void}
 */
function checkManifest(content, expectedHash) {
  /** @type {unknown} */
  const manifest = JSON.parse(content);
  if (!isObjectLike(manifest)) {
    throw new Error("invalid manifest");
  }
  const keys = Object.keys(manifest);
  keys.sort();
  if (
    keys.join(",") !== "configurationHash,schema" ||
    Reflect.get(manifest, "schema") !== STORE_SCHEMA ||
    Reflect.get(manifest, "configurationHash") !== expectedHash
  ) {
    throw new Error("invalid manifest");
  }
}

/**
 * @param {StoreScope} scope
 * @param {string} expectedHash
 * @returns {void}
 */
function ensureManifest(scope, expectedHash) {
  const manifestPath = nodePath.join(scope.directory.path, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    atomicWrite(scope, {
      data: Buffer.from(JSON.stringify({
        configurationHash: expectedHash,
        schema: STORE_SCHEMA
      })),
      label: "manifest",
      name: MANIFEST_FILE
    });
  }
  assertPrivateFile(scope, manifestPath, "persistent queue manifest");
  try {
    checkManifest(fs.readFileSync(manifestPath, "utf8"), expectedHash);
  } catch {
    throw scope.fail("persistent queue configuration does not match its manifest");
  }
}

/**
 * @param {StoreScope} scope
 * @param {number} sequence
 * @returns {void}
 */
function writeAcceptedMarker(scope, sequence) {
  atomicWrite(scope, { data: Buffer.from(`${String(sequence)}\n`), label: "accepted", name: ACCEPTED_FILE });
}

/**
 * @param {StoreScope} scope
 * @param {string} raw
 * @returns {number}
 */
function parseAcceptedMarker(scope, raw) {
  if (!ACCEPTED_PATTERN.test(raw)) {
    throw scope.fail("persistent queue accepted marker is invalid");
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) {
    throw scope.fail("persistent queue accepted marker is invalid");
  }
  return value;
}

/**
 * @param {StoreScope} scope
 * @returns {number}
 */
function readOrCreateAcceptedMarker(scope) {
  const markerPath = nodePath.join(scope.directory.path, ACCEPTED_FILE);
  if (!fs.existsSync(markerPath)) {
    atomicWrite(scope, { data: Buffer.from("0\n"), label: "accepted", name: ACCEPTED_FILE });
  }
  assertPrivateFile(scope, markerPath, "persistent queue accepted marker");
  return parseAcceptedMarker(scope, fs.readFileSync(markerPath, "utf8"));
}

/**
 * @param {number | undefined} sequence
 * @returns {string}
 */
function eventFilename(sequence) {
  return `event-${String(sequence).padStart(SEQUENCE_DIGITS, "0")}.lbq`;
}

/**
 * @param {StoreScope} scope
 * @param {string} filename
 * @param {RemovalProgress} progress
 * @returns {void}
 */
function removeEventFile(scope, filename, progress) {
  const fullPath = nodePath.join(scope.directory.path, filename);
  assertPrivateFile(scope, fullPath, "persisted event file");
  try {
    fs.unlinkSync(fullPath);
    progress.removed = true;
  } catch {
    throw progress.removed
      ? scope.failCommit("persisted event removal could not be confirmed")
      : scope.fail("acknowledged persisted event could not be removed");
  }
}

/**
 * @param {StoreScope} scope
 * @param {readonly (number | undefined)[]} sequences
 * @returns {void}
 */
function removeEventFiles(scope, sequences) {
  /** @type {RemovalProgress} */
  const progress = { removed: false };
  for (const sequence of sequences) {
    removeEventFile(scope, eventFilename(sequence), progress);
  }
  try {
    fsyncDirectory(scope, scope.directory.path);
  } catch {
    throw scope.failCommit("persisted event removal could not be confirmed");
  }
}

module.exports = {
  configurationHash,
  ensureManifest,
  eventFilename,
  readOrCreateAcceptedMarker,
  removeEventFiles,
  writeAcceptedMarker
};
