"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const STORE_SCHEMA = 1;
const RECORD_SCHEMA = 1;
const MANIFEST_FILE = "manifest.json";
const ACCEPTED_FILE = ".accepted";
const LOCK_DIRECTORY = ".lock";
const LOCK_OWNER_FILE = "owner.json";
const EVENT_FILE_PATTERN = /^event-([0-9]{16})\.lbq$/u;
const TEMP_FILE_PATTERN = /^\.(?:accepted|event|manifest)\.tmp-[0-9a-f]{32}$/u;
const LOCK_LEASE_PATTERN = /^[0-9a-f]{32}$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function buildNodePersistentEventStore({
  SdkError,
  directory,
  encryptionKey,
  limits,
  onWarning,
  sdkName
}) {
  validateDependencies({ SdkError, directory, encryptionKey, limits, onWarning, sdkName });
  const fail = (message) => new SdkError("persistence_error", message);
  const failCommit = (message) => new SdkError("persistence_commit_error", message);
  const key = Buffer.from(encryptionKey);
  const ownerLease = crypto.randomBytes(16).toString("hex");
  const queueDirectory = prepareQueueDirectory(directory, fail);
  let lockOwned = false;
  let closed = false;
  let uncertain = false;

  try {
    acquireLock(queueDirectory, ownerLease, fail, failCommit, onWarning);
    lockOwned = true;
    ensureManifest(queueDirectory, configurationHash(sdkName, limits), fail, failCommit);
    const acceptedThrough = readOrCreateAcceptedMarker(queueDirectory, fail, failCommit);
    const recovered = recoverRecords({
      acceptedThrough,
      directory: queueDirectory.path,
      fail,
      key,
      limits,
      onWarning,
      owner: queueDirectory.owner
    });
    let records = recovered.records;
    let sequences = recovered.sequences;
    let pendingBytes = records.reduce((total, record) => total + record.eventBytes, 0);
    let nextSequence = Math.max(acceptedThrough, recovered.highestSequence) + 1;

    return {
      acknowledge(count) {
        assertOpen();
        assertPinnedDirectory(queueDirectory, fail);
        if (!Number.isSafeInteger(count) || count <= 0 || count > records.length) {
          throw fail("persistent acknowledgement count is invalid");
        }
        const acknowledgedThrough = sequences[count - 1];
        try {
          writeAcceptedMarker(queueDirectory, acknowledgedThrough, fail, failCommit);
          removeEventFiles(queueDirectory, sequences.slice(0, count), fail, failCommit);
        } catch (error) {
          markCommitUncertain(error);
          throw error;
        }
        pendingBytes -= records.slice(0, count).reduce((total, record) => total + record.eventBytes, 0);
        records = records.slice(count);
        sequences = sequences.slice(count);
      },

      append(record) {
        assertOpen();
        assertPinnedDirectory(queueDirectory, fail);
        const normalized = normalizeRecord(record, fail);
        if (records.length >= limits.maxQueueSize || pendingBytes + normalized.eventBytes > limits.maxQueueBytes) {
          throw fail("persistent queue limits were exceeded");
        }
        if (!Number.isSafeInteger(nextSequence) || nextSequence <= 0 || nextSequence > 9999999999999999) {
          throw fail("persistent queue sequence was exhausted");
        }
        const sequence = nextSequence;
        const filename = eventFilename(sequence);
        const encrypted = encryptRecord(normalized, sequence, key, fail);
        try {
          atomicWrite(queueDirectory, filename, encrypted, fail, failCommit, "event");
        } catch (error) {
          markCommitUncertain(error);
          throw error;
        }
        records.push(normalized);
        sequences.push(sequence);
        pendingBytes += normalized.eventBytes;
        nextSequence += 1;
      },

      close() {
        if (closed) {
          return;
        }
        assertPinnedDirectory(queueDirectory, fail);
        try {
          releaseLock(queueDirectory, ownerLease, fail, failCommit);
        } catch (error) {
          if (error?.code === "persistence_commit_error") {
            lockOwned = false;
            closed = true;
            key.fill(0);
          }
          throw error;
        }
        lockOwned = false;
        closed = true;
        key.fill(0);
      },

      load() {
        assertOpen();
        assertPinnedDirectory(queueDirectory, fail);
        return records.map(cloneRecord);
      },

      purge() {
        assertOpen();
        assertPinnedDirectory(queueDirectory, fail);
        if (sequences.length === 0) {
          return;
        }
        const acknowledgedThrough = sequences.at(-1);
        try {
          writeAcceptedMarker(queueDirectory, acknowledgedThrough, fail, failCommit);
          removeEventFiles(queueDirectory, sequences, fail, failCommit);
        } catch (error) {
          markCommitUncertain(error);
          throw error;
        }
        records = [];
        sequences = [];
        pendingBytes = 0;
      }
    };

    function assertOpen() {
      if (closed) {
        throw fail("persistent queue is closed");
      }
      if (uncertain) {
        throw failCommit("persistent queue durability is uncertain and requires restart");
      }
    }

    function markCommitUncertain(error) {
      if (error?.code === "persistence_commit_error") {
        uncertain = true;
      }
    }
  } catch (error) {
    if (lockOwned) {
      try {
        releaseLock(queueDirectory, ownerLease, fail, failCommit);
      } catch {
        // Preserve the original initialization failure.
      }
    }
    key.fill(0);
    throw error;
  }
}

function validateDependencies({ SdkError, directory, encryptionKey, limits, onWarning, sdkName }) {
  if (typeof SdkError !== "function") {
    throw new TypeError("SdkError must be a constructor");
  }
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    throw new SdkError("configuration_error", "persistentQueue is supported only on POSIX runtimes");
  }
  if (typeof directory !== "string" || directory === "" || !path.isAbsolute(directory) || path.resolve(directory) !== directory || path.parse(directory).root === directory) {
    throw new SdkError("configuration_error", "persistentQueue.directory must be an absolute normalized path below the filesystem root");
  }
  if (!(Buffer.isBuffer(encryptionKey) || encryptionKey instanceof Uint8Array) || encryptionKey.byteLength !== 32) {
    throw new SdkError("configuration_error", "persistentQueue.encryptionKey must contain exactly 32 bytes");
  }
  if (onWarning !== undefined && typeof onWarning !== "function") {
    throw new SdkError("configuration_error", "persistentQueue.onWarning must be a function");
  }
  if (typeof sdkName !== "string" || sdkName === "") {
    throw new SdkError("configuration_error", "persistent queue SDK identity is invalid");
  }
  for (const name of ["maxBatchBytes", "maxBatchEvents", "maxQueueBytes", "maxQueueSize"]) {
    if (!Number.isSafeInteger(limits?.[name]) || limits[name] <= 0) {
      throw new SdkError("configuration_error", `persistent queue ${name} is invalid`);
    }
  }
}

function prepareQueueDirectory(directory, fail) {
  const owner = process.getuid();
  const root = path.parse(directory).root;
  const segments = directory.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw fail("persistent queue path could not be inspected");
      }
      try {
        fs.mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
        stat = fs.lstatSync(current);
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") {
          throw fail("persistent queue directory could not be created");
        }
        stat = fs.lstatSync(current);
      }
    }
    if (stat.isSymbolicLink()) {
      throw fail("persistent queue path must not contain symbolic links");
    }
    if (!stat.isDirectory()) {
      throw fail("persistent queue path must contain only directories");
    }
  }

  const stat = fs.lstatSync(directory);
  if (stat.uid !== owner || (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw fail("persistent queue directory must be private and owned by the current user");
  }
  return { dev: stat.dev, ino: stat.ino, owner, path: directory };
}

function assertPinnedDirectory(queueDirectory, fail) {
  let stat;
  try {
    stat = fs.lstatSync(queueDirectory.path);
  } catch {
    throw fail("persistent queue directory identity changed");
  }
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.uid !== queueDirectory.owner
    || (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    || stat.dev !== queueDirectory.dev
    || stat.ino !== queueDirectory.ino
  ) {
    throw fail("persistent queue directory identity changed");
  }
}

function acquireLock(queueDirectory, ownerLease, fail, failCommit, onWarning) {
  const lockPath = path.join(queueDirectory.path, LOCK_DIRECTORY);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertPinnedDirectory(queueDirectory, fail);
    let created = false;
    try {
      fs.mkdirSync(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
      created = true;
      atomicWriteInDirectory(lockPath, LOCK_OWNER_FILE, Buffer.from(JSON.stringify({
        lease: ownerLease,
        pid: process.pid
      })), queueDirectory.owner, fail, failCommit, "lock owner");
      fsyncDirectory(lockPath, fail);
      fsyncDirectory(queueDirectory.path, fail);
      return;
    } catch (error) {
      if (created) {
        removeIncompleteLease(lockPath);
      }
      if (error?.code !== "EEXIST") {
        if (error?.code && !["persistence_error", "persistence_commit_error"].includes(error.code)) {
          throw fail("persistent queue lock could not be acquired");
        }
        throw error;
      }
    }

    const owner = readLockOwner(lockPath, queueDirectory.owner, fail);
    if (processIsAlive(owner.pid)) {
      throw fail("persistent queue is already in use");
    }
    removeStaleLock(lockPath, queueDirectory.owner, fail);
    notify(onWarning, { code: "stale_lock_recovered" });
  }
  throw fail("persistent queue lock could not be acquired");
}

function removeIncompleteLease(lockPath) {
  try {
    for (const entry of fs.readdirSync(lockPath)) {
      if (entry === LOCK_OWNER_FILE || TEMP_FILE_PATTERN.test(entry)) {
        fs.unlinkSync(path.join(lockPath, entry));
      }
    }
    fs.rmdirSync(lockPath);
  } catch {
    // Initialization remains failed closed if lease removal cannot be completed.
  }
}

function readLockOwner(lockPath, owner, fail) {
  assertPrivateDirectory(lockPath, owner, fail, "persistent queue lock");
  const entries = fs.readdirSync(lockPath);
  if (entries.length !== 1 || entries[0] !== LOCK_OWNER_FILE) {
    throw fail("persistent queue lock state is invalid");
  }
  const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
  assertPrivateFile(ownerPath, owner, fail, "persistent queue lock owner");
  try {
    const value = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (
      !value
      || Object.keys(value).sort().join(",") !== "lease,pid"
      || !Number.isSafeInteger(value.pid)
      || value.pid <= 0
      || !LOCK_LEASE_PATTERN.test(value.lease)
    ) {
      throw new Error("invalid owner");
    }
    return value;
  } catch {
    throw fail("persistent queue lock state is invalid");
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function removeStaleLock(lockPath, owner, fail) {
  const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
  assertPrivateFile(ownerPath, owner, fail, "persistent queue lock owner");
  try {
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockPath);
  } catch {
    throw fail("stale persistent queue lock could not be removed");
  }
}

function releaseLock(queueDirectory, ownerLease, fail, failCommit) {
  const lockPath = path.join(queueDirectory.path, LOCK_DIRECTORY);
  const owner = readLockOwner(lockPath, queueDirectory.owner, fail);
  if (owner.pid !== process.pid || owner.lease !== ownerLease) {
    throw fail("persistent queue lock ownership changed");
  }
  try {
    fs.unlinkSync(path.join(lockPath, LOCK_OWNER_FILE));
    fs.rmdirSync(lockPath);
  } catch {
    throw fail("persistent queue lock could not be released");
  }
  try {
    fsyncDirectory(queueDirectory.path, fail);
  } catch {
    throw failCommit("persistent queue lock release could not be confirmed");
  }
}

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

function ensureManifest(queueDirectory, expectedHash, fail, failCommit) {
  const manifestPath = path.join(queueDirectory.path, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    atomicWrite(queueDirectory, MANIFEST_FILE, Buffer.from(JSON.stringify({
      configurationHash: expectedHash,
      schema: STORE_SCHEMA
    })), fail, failCommit, "manifest");
  }
  assertPrivateFile(manifestPath, queueDirectory.owner, fail, "persistent queue manifest");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (
      !manifest
      || Object.keys(manifest).sort().join(",") !== "configurationHash,schema"
      || manifest.schema !== STORE_SCHEMA
      || manifest.configurationHash !== expectedHash
    ) {
      throw new Error("invalid manifest");
    }
  } catch {
    throw fail("persistent queue configuration does not match its manifest");
  }
}

function readOrCreateAcceptedMarker(queueDirectory, fail, failCommit) {
  const markerPath = path.join(queueDirectory.path, ACCEPTED_FILE);
  if (!fs.existsSync(markerPath)) {
    atomicWrite(queueDirectory, ACCEPTED_FILE, Buffer.from("0\n"), fail, failCommit, "accepted");
  }
  assertPrivateFile(markerPath, queueDirectory.owner, fail, "persistent queue accepted marker");
  const raw = fs.readFileSync(markerPath, "utf8");
  if (!/^(?:0|[1-9][0-9]{0,15})\n$/u.test(raw)) {
    throw fail("persistent queue accepted marker is invalid");
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) {
    throw fail("persistent queue accepted marker is invalid");
  }
  return value;
}

function writeAcceptedMarker(queueDirectory, sequence, fail, failCommit) {
  atomicWrite(queueDirectory, ACCEPTED_FILE, Buffer.from(`${sequence}\n`), fail, failCommit, "accepted");
}

function recoverRecords({ acceptedThrough, directory, fail, key, limits, onWarning, owner }) {
  const records = [];
  const sequences = [];
  let highestSequence = acceptedThrough;
  let pendingBytes = 0;
  const acceptedFiles = [];
  const entries = fs.readdirSync(directory).sort();
  for (const entry of entries) {
    if ([ACCEPTED_FILE, LOCK_DIRECTORY, MANIFEST_FILE].includes(entry)) {
      continue;
    }
    const fullPath = path.join(directory, entry);
    if (TEMP_FILE_PATTERN.test(entry)) {
      assertPrivateFile(fullPath, owner, fail, "persistent queue temporary file");
      fs.unlinkSync(fullPath);
      notify(onWarning, { code: "orphaned_temp_removed" });
      continue;
    }
    const match = EVENT_FILE_PATTERN.exec(entry);
    if (!match) {
      throw fail("persistent queue contains an unexpected entry");
    }
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw fail("persisted event sequence is invalid");
    }
    highestSequence = Math.max(highestSequence, sequence);
    assertPrivateFile(fullPath, owner, fail, "persisted event file");
    if (sequence <= acceptedThrough) {
      acceptedFiles.push(sequence);
      continue;
    }
    const stat = fs.lstatSync(fullPath);
    const maximumEncryptedBytes = Math.ceil(limits.maxBatchBytes * 4 / 3) + 4096;
    if (stat.size <= 0 || stat.size > maximumEncryptedBytes) {
      throw fail("persisted event file size is invalid");
    }
    const record = decryptRecord(fs.readFileSync(fullPath), sequence, key, fail);
    pendingBytes += record.eventBytes;
    if (records.length + 1 > limits.maxQueueSize || pendingBytes > limits.maxQueueBytes) {
      throw fail("recovered persistent queue exceeds configured limits");
    }
    records.push(record);
    sequences.push(sequence);
  }
  if (acceptedFiles.length > 0) {
    removeEventFiles({ owner, path: directory }, acceptedFiles, fail, (message) => fail(message));
    notify(onWarning, { code: "accepted_prefix_recovered" });
  }
  return { highestSequence, records, sequences };
}

function normalizeRecord(record, fail) {
  if (
    !record
    || Array.isArray(record)
    || typeof record !== "object"
    || !record.event
    || Array.isArray(record.event)
    || typeof record.event !== "object"
    || typeof record.serializedEvent !== "string"
    || !Number.isSafeInteger(record.eventBytes)
    || record.eventBytes <= 0
    || Buffer.byteLength(record.serializedEvent, "utf8") !== record.eventBytes
    || JSON.stringify(record.event) !== record.serializedEvent
  ) {
    throw fail("persistent event record is invalid");
  }
  return cloneRecord(record);
}

function cloneRecord(record) {
  return {
    event: JSON.parse(record.serializedEvent),
    eventBytes: record.eventBytes,
    serializedEvent: record.serializedEvent
  };
}

function encryptRecord(record, sequence, key, fail) {
  const plaintext = Buffer.from(record.serializedEvent);
  try {
    const iv = crypto.randomBytes(AES_GCM_IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`logbrew-node-event-v${RECORD_SCHEMA}:${sequence}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      schema: RECORD_SCHEMA,
      sequence,
      tag: cipher.getAuthTag().toString("base64")
    }));
  } catch {
    throw fail("persisted event could not be encrypted");
  } finally {
    plaintext.fill(0);
  }
}

function decryptRecord(payload, expectedSequence, key, fail) {
  let plaintext;
  try {
    const envelope = JSON.parse(utf8Decoder.decode(payload));
    if (
      !envelope
      || Object.keys(envelope).sort().join(",") !== "ciphertext,iv,schema,sequence,tag"
      || envelope.schema !== RECORD_SCHEMA
      || envelope.sequence !== expectedSequence
    ) {
      throw new Error("invalid envelope");
    }
    const iv = decodeBase64(envelope.iv);
    const tag = decodeBase64(envelope.tag);
    const ciphertext = decodeBase64(envelope.ciphertext);
    if (iv.length !== AES_GCM_IV_BYTES || tag.length !== AES_GCM_TAG_BYTES || ciphertext.length === 0) {
      throw new Error("invalid encryption fields");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`logbrew-node-event-v${RECORD_SCHEMA}:${expectedSequence}`));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const serializedEvent = utf8Decoder.decode(plaintext);
    return normalizeRecord({
      event: JSON.parse(serializedEvent),
      eventBytes: plaintext.length,
      serializedEvent
    }, fail);
  } catch {
    throw fail("could not decrypt persisted events");
  } finally {
    plaintext?.fill(0);
  }
}

function decodeBase64(value) {
  if (typeof value !== "string" || value === "" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error("invalid base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("non-canonical base64");
  }
  return decoded;
}

function eventFilename(sequence) {
  return `event-${String(sequence).padStart(16, "0")}.lbq`;
}

function removeEventFiles(queueDirectory, sequences, fail, failCommit) {
  let removed = false;
  for (const sequence of sequences) {
    const fullPath = path.join(queueDirectory.path, eventFilename(sequence));
    assertPrivateFile(fullPath, queueDirectory.owner, fail, "persisted event file");
    try {
      fs.unlinkSync(fullPath);
      removed = true;
    } catch {
      throw removed
        ? failCommit("persisted event removal could not be confirmed")
        : fail("acknowledged persisted event could not be removed");
    }
  }
  try {
    fsyncDirectory(queueDirectory.path, fail);
  } catch {
    throw failCommit("persisted event removal could not be confirmed");
  }
}

function atomicWrite(queueDirectory, filename, data, fail, failCommit, label) {
  assertPinnedDirectory(queueDirectory, fail);
  atomicWriteInDirectory(queueDirectory.path, filename, data, queueDirectory.owner, fail, failCommit, label);
  try {
    fsyncDirectory(queueDirectory.path, fail);
  } catch {
    throw failCommit(`${label} commit could not be confirmed`);
  }
}

function atomicWriteInDirectory(directory, filename, data, owner, fail, failCommit, label) {
  const tempPrefix = filename === ACCEPTED_FILE ? "accepted" : filename === MANIFEST_FILE ? "manifest" : "event";
  const tempPath = path.join(directory, `.${tempPrefix}.tmp-${crypto.randomBytes(16).toString("hex")}`);
  const finalPath = path.join(directory, filename);
  let descriptor;
  let renamed = false;
  try {
    descriptor = fs.openSync(tempPath, "wx", PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertPrivateFile(tempPath, owner, fail, `${label} temporary file`);
    fs.renameSync(tempPath, finalPath);
    renamed = true;
    assertPrivateFile(finalPath, owner, fail, label);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the write failure.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The temporary file may already have been renamed or absent.
    }
    if (renamed) {
      throw failCommit(`${label} commit could not be confirmed`);
    }
    if (error?.code && !["persistence_error", "persistence_commit_error"].includes(error.code)) {
      throw fail(`${label} could not be written`);
    }
    throw error;
  }
}

function assertPrivateDirectory(directory, owner, fail, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw fail(`${label} could not be inspected`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== owner || (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw fail(`${label} must be private and owned by the current user`);
  }
}

function assertPrivateFile(filename, owner, fail, label) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    throw fail(`${label} could not be inspected`);
  }
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.uid !== owner
    || stat.nlink !== 1
    || (stat.mode & 0o777) !== PRIVATE_FILE_MODE
  ) {
    throw fail(`${label} must be private, regular, single-linked, and owned by the current user`);
  }
}

function fsyncDirectory(directory, fail) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    throw fail("persistent queue directory could not be synchronized");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function notify(onWarning, warning) {
  if (!onWarning) {
    return;
  }
  try {
    onWarning(warning);
  } catch {
    // Warning callbacks are advisory and cannot change persistence behavior.
  }
}

module.exports = { buildNodePersistentEventStore };
