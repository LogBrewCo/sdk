"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildNodePersistentEventStore } = require("../persistent-event-store.cjs");

class TestSdkError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const limits = Object.freeze({
  maxBatchBytes: 256 * 1024,
  maxBatchEvents: 100,
  maxQueueBytes: 4 * 1024 * 1024,
  maxQueueSize: 1000
});

function storedLog(id, message = "persisted") {
  const event = {
    type: "log",
    id,
    timestamp: "2026-07-14T10:00:00Z",
    attributes: { message, level: "info" }
  };
  const serializedEvent = JSON.stringify(event);
  return {
    event,
    eventBytes: Buffer.byteLength(serializedEvent, "utf8"),
    serializedEvent
  };
}

function tempQueue(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "logbrew-node-store-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return path.join(root, "queue");
}

function createStore(directory, encryptionKey, options = {}) {
  return buildNodePersistentEventStore({
    SdkError: TestSdkError,
    directory,
    encryptionKey,
    limits,
    sdkName: "logbrew-node",
    ...options
  });
}

function readTree(directory) {
  return fs.readdirSync(directory, { recursive: true })
    .map((entry) => path.join(directory, entry))
    .filter((entry) => fs.lstatSync(entry).isFile())
    .map((entry) => fs.readFileSync(entry))
    .reduce((all, value) => Buffer.concat([all, value]), Buffer.alloc(0));
}

function failNextDirectorySync(callback) {
  const original = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = (descriptor) => {
    calls += 1;
    if (calls === 2) {
      const error = new Error("simulated directory sync failure");
      error.code = "EIO";
      throw error;
    }
    return original(descriptor);
  };
  try {
    return callback();
  } finally {
    fs.fsyncSync = original;
  }
}

test("encrypted store recovers ordered records and acknowledges accepted prefixes", (t) => {
  const directory = tempQueue(t);
  const key = crypto.randomBytes(32);
  const first = storedLog("evt_store_001", "first durable message");
  const second = storedLog("evt_store_002", "second durable message");

  const writer = createStore(directory, key);
  assert.deepEqual(writer.load(), []);
  writer.append(first);
  writer.append(second);
  const bytes = readTree(directory);
  assert.equal(bytes.includes(Buffer.from(first.event.id)), false);
  assert.equal(bytes.includes(Buffer.from(first.event.attributes.message)), false);
  writer.close();

  const reader = createStore(directory, key);
  assert.deepEqual(reader.load(), [first, second]);
  reader.acknowledge(1);
  reader.close();

  const finalReader = createStore(directory, key);
  assert.deepEqual(finalReader.load(), [second]);
  finalReader.acknowledge(1);
  assert.deepEqual(finalReader.load(), []);
  finalReader.close();
});

test("encrypted store preserves exact failed records for stable replay", (t) => {
  const directory = tempQueue(t);
  const key = crypto.randomBytes(32);
  const record = storedLog("evt_replay_001", "stable body");
  const first = createStore(directory, key);
  first.append(record);
  first.close();

  const second = createStore(directory, key);
  const recovered = second.load();
  assert.equal(recovered[0].serializedEvent, record.serializedEvent);
  assert.equal(recovered[0].eventBytes, record.eventBytes);
  second.close();
});

test("encrypted store recovers a record near the configured batch byte limit", (t) => {
  const directory = tempQueue(t);
  const key = crypto.randomBytes(32);
  const largeLimits = {
    ...limits,
    maxBatchBytes: 32 * 1024,
    maxQueueBytes: 64 * 1024
  };
  const record = storedLog("evt_near_limit_001", "x".repeat(30 * 1024));
  const first = createStore(directory, key, { limits: largeLimits });
  first.append(record);
  first.close();

  const second = createStore(directory, key, { limits: largeLimits });
  assert.deepEqual(second.load(), [record]);
  second.close();
});

test("encrypted store fails closed for wrong keys and tampered record permissions", (t) => {
  const directory = tempQueue(t);
  const key = crypto.randomBytes(32);
  const writer = createStore(directory, key);
  writer.append(storedLog("evt_private_001"));
  writer.close();

  assert.throws(() => createStore(directory, crypto.randomBytes(32)), /could not decrypt persisted events/);

  const eventFile = fs.readdirSync(directory).find((entry) => entry.endsWith(".lbq"));
  fs.chmodSync(path.join(directory, eventFile), 0o644);
  assert.throws(() => createStore(directory, key), /persisted event file must be private/);
});

test("encrypted store rejects ambiguous paths, symlinks, and non-private directories", (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "logbrew-node-path-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const key = crypto.randomBytes(32);

  assert.throws(() => createStore("relative/queue", key), /absolute normalized path/);

  const publicDirectory = path.join(root, "public");
  fs.mkdirSync(publicDirectory, { mode: 0o755 });
  assert.throws(() => createStore(publicDirectory, key), /queue directory must be private/);

  const target = path.join(root, "target");
  fs.mkdirSync(target, { mode: 0o700 });
  const link = path.join(root, "linked");
  fs.symlinkSync(target, link);
  assert.throws(() => createStore(link, key), /must not contain symbolic links/);
});

test("encrypted store enforces one live owner and recovers a dead owner", (t) => {
  const directory = tempQueue(t);
  const key = crypto.randomBytes(32);
  const first = createStore(directory, key);
  assert.throws(() => createStore(directory, key), /already in use/);
  first.close();

  const lockDirectory = path.join(directory, ".lock");
  fs.mkdirSync(lockDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(lockDirectory, "owner.json"), JSON.stringify({
    lease: "0123456789abcdef0123456789abcdef",
    pid: 2147483647
  }), { mode: 0o600 });
  const warnings = [];
  const recovered = createStore(directory, key, { onWarning: (warning) => warnings.push(warning) });
  assert.deepEqual(warnings, [{ code: "stale_lock_recovered" }]);
  recovered.close();
});

test("encrypted store purge removes every pending record", (t) => {
  const directory = tempQueue(t);
  const key = crypto.randomBytes(32);
  const first = createStore(directory, key);
  first.append(storedLog("evt_purge_001"));
  first.append(storedLog("evt_purge_002"));
  first.purge();
  assert.deepEqual(first.load(), []);
  first.close();

  const second = createStore(directory, key);
  assert.deepEqual(second.load(), []);
  second.close();
});

test("encrypted store completes accepted-prefix removal after an interrupted acknowledgement", (t) => {
  const directory = tempQueue(t);
  const key = crypto.randomBytes(32);
  const first = createStore(directory, key);
  first.append(storedLog("evt_recovery_001"));
  first.close();
  fs.writeFileSync(path.join(directory, ".accepted"), "1\n", { mode: 0o600 });

  const warnings = [];
  const second = createStore(directory, key, { onWarning: (warning) => warnings.push(warning) });
  assert.deepEqual(second.load(), []);
  assert.deepEqual(warnings, [{ code: "accepted_prefix_recovered" }]);
  assert.equal(fs.readdirSync(directory).some((entry) => entry.endsWith(".lbq")), false);
  second.close();
});

test("encrypted store rejects directory replacement after ownership is pinned", (t) => {
  const directory = tempQueue(t);
  const key = crypto.randomBytes(32);
  const store = createStore(directory, key);
  const movedDirectory = `${directory}-moved`;
  fs.renameSync(directory, movedDirectory);
  fs.mkdirSync(directory, { mode: 0o700 });

  assert.throws(() => store.append(storedLog("evt_replaced_001")), /directory identity changed/);
});

test("encrypted store blocks reuse after append durability becomes uncertain", (t) => {
  const directory = tempQueue(t);
  const key = crypto.randomBytes(32);
  const record = storedLog("evt_uncertain_append_001");
  const first = createStore(directory, key);

  assert.throws(
    () => failNextDirectorySync(() => first.append(record)),
    (error) => error.code === "persistence_commit_error"
  );
  assert.throws(() => first.load(), /durability is uncertain and requires restart/);
  first.close();

  const second = createStore(directory, key);
  assert.deepEqual(second.load(), [record]);
  second.close();
});

test("encrypted store resolves an uncertain accepted marker only after restart", (t) => {
  const directory = tempQueue(t);
  const key = crypto.randomBytes(32);
  const first = createStore(directory, key);
  first.append(storedLog("evt_uncertain_ack_001"));

  assert.throws(
    () => failNextDirectorySync(() => first.acknowledge(1)),
    (error) => error.code === "persistence_commit_error"
  );
  assert.throws(() => first.load(), /durability is uncertain and requires restart/);
  first.close();

  const warnings = [];
  const second = createStore(directory, key, { onWarning: (warning) => warnings.push(warning) });
  assert.deepEqual(second.load(), []);
  assert.deepEqual(warnings, [{ code: "accepted_prefix_recovered" }]);
  second.close();
});
