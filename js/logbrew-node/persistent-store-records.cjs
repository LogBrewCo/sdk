"use strict";

const { Buffer } = require("node:buffer");
const crypto = require("node:crypto");
const fs = require("node:fs");
const nodePath = require("node:path");
const { TextDecoder } = require("node:util");
const { isObjectLike } = require("./internal.cjs");
const {
  ACCEPTED_FILE,
  MANIFEST_FILE,
  TEMP_FILE_PATTERN,
  assertPrivateFile,
  notify
} = require("./persistent-store-files.cjs");
const { LOCK_DIRECTORY } = require("./persistent-store-lock.cjs");
const { removeEventFiles } = require("./persistent-store-state.cjs");

/**
 * @import { FailFactory, StoreScope } from "./persistent-store-files.cjs"
 * @import { StoreLimits } from "./persistent-store-state.cjs"
 */

/**
 * @typedef {Readonly<{ event: unknown, eventBytes: number, serializedEvent: string }>} StoredRecord
 * @typedef {Readonly<{ fail: FailFactory, key: Buffer }>} RecordCipher
 * @typedef {{
 *   acceptedFiles: number[],
 *   highestSequence: number,
 *   pendingBytes: number,
 *   records: StoredRecord[],
 *   sequences: number[]
 * }} RecoveryProgress
 * @typedef {Readonly<{
 *   acceptedThrough: number,
 *   cipher: RecordCipher,
 *   limits: StoreLimits,
 *   progress: RecoveryProgress
 * }>} Recovery
 */

const RECORD_SCHEMA = 1;
const CLIENT_REPORT_FILE = "client-report.json";
const EVENT_FILE_PATTERN = /^event-(?<sequence>[0-9]{16})\.lbq$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const BASE64_GROUP_BYTES = 3;
const BASE64_GROUP_CHARS = 4;
const ENVELOPE_OVERHEAD_BYTES = 4096;
const EMPTY = 0;
const NEXT = 1;
const SKIPPED_ENTRIES = new Set([ACCEPTED_FILE, CLIENT_REPORT_FILE, LOCK_DIRECTORY, MANIFEST_FILE]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * @param {Readonly<{ event: unknown, eventBytes: number, serializedEvent: string }>} record
 * @returns {StoredRecord}
 */
function cloneRecord(record) {
  /** @type {unknown} */
  const event = JSON.parse(record.serializedEvent);
  return {
    event,
    eventBytes: record.eventBytes,
    serializedEvent: record.serializedEvent
  };
}

/**
 * @param {unknown} record
 * @returns {record is StoredRecord}
 */
function isValidRecord(record) {
  if (!isObjectLike(record) || Array.isArray(record)) {
    return false;
  }
  /** @type {unknown} */
  const event = Reflect.get(record, "event");
  /** @type {unknown} */
  const serializedEvent = Reflect.get(record, "serializedEvent");
  /** @type {unknown} */
  const eventBytes = Reflect.get(record, "eventBytes");
  return typeof record === "object" &&
    isObjectLike(event) && typeof event === "object" && !Array.isArray(event) &&
    typeof serializedEvent === "string" &&
    typeof eventBytes === "number" && Number.isSafeInteger(eventBytes) && eventBytes > EMPTY &&
    Buffer.byteLength(serializedEvent, "utf8") === eventBytes &&
    JSON.stringify(event) === serializedEvent;
}

/**
 * @param {unknown} record
 * @param {FailFactory} fail
 * @returns {StoredRecord}
 */
function normalizeRecord(record, fail) {
  if (!isValidRecord(record)) {
    throw fail("persistent event record is invalid");
  }
  return cloneRecord(record);
}

/**
 * @param {number} sequence
 * @returns {Buffer}
 */
function recordAad(sequence) {
  return Buffer.from(`logbrew-node-event-v${String(RECORD_SCHEMA)}:${String(sequence)}`);
}

/**
 * @param {Buffer} first
 * @param {Buffer} second
 * @returns {Buffer}
 */
function joinBuffers(first, second) {
  const joined = Buffer.alloc(first.length + second.length);
  first.copy(joined, EMPTY);
  second.copy(joined, first.length);
  return joined;
}

/**
 * @param {Buffer} key
 * @param {Buffer} plaintext
 * @param {number} sequence
 * @returns {Buffer}
 */
function sealRecord(key, plaintext, sequence) {
  const iv = crypto.randomBytes(AES_GCM_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(recordAad(sequence));
  const ciphertext = joinBuffers(cipher.update(plaintext), cipher.final());
  return Buffer.from(JSON.stringify({
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    schema: RECORD_SCHEMA,
    sequence,
    tag: cipher.getAuthTag().toString("base64")
  }));
}

/**
 * @param {RecordCipher} recordCipher
 * @param {StoredRecord} record
 * @param {number} sequence
 * @returns {Buffer}
 */
function encryptRecord(recordCipher, record, sequence) {
  const plaintext = Buffer.from(record.serializedEvent);
  try {
    return sealRecord(recordCipher.key, plaintext, sequence);
  } catch {
    throw recordCipher.fail("persisted event could not be encrypted");
  } finally {
    plaintext.fill(EMPTY);
  }
}

/**
 * @param {unknown} value
 * @returns {Buffer}
 */
function decodeBase64(value) {
  if (typeof value !== "string" || value === "" || !BASE64_PATTERN.test(value)) {
    throw new Error("invalid base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("non-canonical base64");
  }
  return decoded;
}

/**
 * @param {unknown} envelope
 * @param {number} expectedSequence
 * @returns {envelope is object}
 */
function isEnvelope(envelope, expectedSequence) {
  if (!isObjectLike(envelope)) {
    return false;
  }
  const keys = Object.keys(envelope);
  keys.sort();
  return keys.join(",") === "ciphertext,iv,schema,sequence,tag" &&
    Reflect.get(envelope, "schema") === RECORD_SCHEMA &&
    Reflect.get(envelope, "sequence") === expectedSequence;
}

/**
 * @param {Buffer} payload
 * @param {number} expectedSequence
 * @returns {Readonly<{ ciphertext: Buffer, iv: Buffer, tag: Buffer }>}
 */
function openEnvelope(payload, expectedSequence) {
  /** @type {unknown} */
  const envelope = JSON.parse(utf8Decoder.decode(payload));
  if (!isEnvelope(envelope, expectedSequence)) {
    throw new Error("invalid envelope");
  }
  const iv = decodeBase64(Reflect.get(envelope, "iv"));
  const tag = decodeBase64(Reflect.get(envelope, "tag"));
  const ciphertext = decodeBase64(Reflect.get(envelope, "ciphertext"));
  if (iv.length !== AES_GCM_IV_BYTES || tag.length !== AES_GCM_TAG_BYTES || ciphertext.length === EMPTY) {
    throw new Error("invalid encryption fields");
  }
  return { ciphertext, iv, tag };
}

/**
 * @param {Buffer} plaintext
 * @param {FailFactory} fail
 * @returns {StoredRecord}
 */
function restoreRecord(plaintext, fail) {
  const serializedEvent = utf8Decoder.decode(plaintext);
  /** @type {unknown} */
  const event = JSON.parse(serializedEvent);
  return normalizeRecord({ event, eventBytes: plaintext.length, serializedEvent }, fail);
}

/**
 * @param {RecordCipher} recordCipher
 * @param {Buffer} payload
 * @param {number} expectedSequence
 * @returns {StoredRecord}
 */
function decryptRecord(recordCipher, payload, expectedSequence) {
  /** @type {{ plaintext: Buffer }} */
  const holder = { plaintext: Buffer.alloc(EMPTY) };
  try {
    const sealed = openEnvelope(payload, expectedSequence);
    const decipher = crypto.createDecipheriv("aes-256-gcm", recordCipher.key, sealed.iv);
    decipher.setAAD(recordAad(expectedSequence));
    decipher.setAuthTag(sealed.tag);
    holder.plaintext = joinBuffers(decipher.update(sealed.ciphertext), decipher.final());
    return restoreRecord(holder.plaintext, recordCipher.fail);
  } catch {
    throw recordCipher.fail("could not decrypt persisted events");
  } finally {
    holder.plaintext.fill(EMPTY);
  }
}

/**
 * @param {StoreScope} scope
 * @param {string} fullPath
 * @param {StoreLimits} limits
 * @returns {void}
 */
function checkEventSize(scope, fullPath, limits) {
  const stat = fs.lstatSync(fullPath);
  const maximumEncryptedBytes = Math.ceil(limits.maxBatchBytes * BASE64_GROUP_CHARS / BASE64_GROUP_BYTES) + ENVELOPE_OVERHEAD_BYTES;
  if (stat.size <= EMPTY || stat.size > maximumEncryptedBytes) {
    throw scope.fail("persisted event file size is invalid");
  }
}

/**
 * @param {StoreScope} scope
 * @param {Recovery} recovery
 * @param {Readonly<{ fullPath: string, sequence: number }>} entry
 * @returns {void}
 */
function recoverEventFile(scope, recovery, entry) {
  const { limits, progress } = recovery;
  checkEventSize(scope, entry.fullPath, limits);
  const record = decryptRecord(recovery.cipher, fs.readFileSync(entry.fullPath), entry.sequence);
  progress.pendingBytes += record.eventBytes;
  if (progress.records.length + NEXT > limits.maxQueueSize || progress.pendingBytes > limits.maxQueueBytes) {
    throw scope.fail("recovered persistent queue exceeds configured limits");
  }
  progress.records.push(record);
  progress.sequences.push(entry.sequence);
}

/**
 * @param {StoreScope} scope
 * @param {string} fullPath
 * @returns {number}
 */
function entrySequence(scope, fullPath) {
  const digits = EVENT_FILE_PATTERN.exec(nodePath.basename(fullPath))?.groups?.["sequence"];
  if (digits === undefined) {
    throw scope.fail("persistent queue contains an unexpected entry");
  }
  const sequence = Number(digits);
  if (!Number.isSafeInteger(sequence) || sequence <= EMPTY) {
    throw scope.fail("persisted event sequence is invalid");
  }
  return sequence;
}

/**
 * @param {StoreScope} scope
 * @param {Recovery} recovery
 * @param {string} fullPath
 * @returns {void}
 */
function recoverEventEntry(scope, recovery, fullPath) {
  const sequence = entrySequence(scope, fullPath);
  const { progress } = recovery;
  progress.highestSequence = Math.max(progress.highestSequence, sequence);
  assertPrivateFile(scope, fullPath, "persisted event file");
  if (sequence <= recovery.acceptedThrough) {
    progress.acceptedFiles.push(sequence);
    return;
  }
  recoverEventFile(scope, recovery, { fullPath, sequence });
}

/**
 * @param {StoreScope} scope
 * @param {Recovery} recovery
 * @param {string} entry
 * @returns {void}
 */
function recoverEntry(scope, recovery, entry) {
  if (SKIPPED_ENTRIES.has(entry)) {
    return;
  }
  const fullPath = nodePath.join(scope.directory.path, entry);
  if (TEMP_FILE_PATTERN.test(entry)) {
    assertPrivateFile(scope, fullPath, "persistent queue temporary file");
    fs.unlinkSync(fullPath);
    notify(scope.onWarning, { code: "orphaned_temp_removed" });
    return;
  }
  recoverEventEntry(scope, recovery, fullPath);
}

/**
 * @param {StoreScope} scope
 * @param {Omit<Recovery, "progress">} options
 * @returns {Readonly<{ highestSequence: number, records: StoredRecord[], sequences: number[] }>}
 */
function recoverRecords(scope, options) {
  /** @type {RecoveryProgress} */
  const progress = { acceptedFiles: [], highestSequence: options.acceptedThrough, pendingBytes: EMPTY, records: [], sequences: [] };
  const recovery = { ...options, progress };
  const entries = fs.readdirSync(scope.directory.path);
  entries.sort();
  for (const entry of entries) {
    recoverEntry(scope, recovery, entry);
  }
  if (progress.acceptedFiles.length > EMPTY) {
    removeEventFiles({ ...scope, failCommit: scope.fail }, progress.acceptedFiles);
    notify(scope.onWarning, { code: "accepted_prefix_recovered" });
  }
  return { highestSequence: progress.highestSequence, records: progress.records, sequences: progress.sequences };
}

module.exports = { CLIENT_REPORT_FILE, cloneRecord, encryptRecord, normalizeRecord, recoverRecords };
