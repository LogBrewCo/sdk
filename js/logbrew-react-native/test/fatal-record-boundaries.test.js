import assert from "node:assert/strict";
import test from "node:test";
import { createClient, createErrorUtils, withInstalledPackage } from "./global-errors-test-support.js";

function record(overrides = {}) {
  return {
    corruptRecords: 0, droppedRecords: 0, errorName: "TypeError", id: "evt_rn_fatal_boundary",
    schemaVersion: 1, stackFrames: [], timestamp: "2026-07-31T08:30:00.000Z", ...overrides
  };
}

function store(value) {
  let acknowledgements = 0;
  return {
    acknowledgements() { return acknowledgements; },
    readFatalRecord() { return { status: "pending", record: value }; },
    writeFatalRecord() { return { status: "storage_error" }; },
    discardFatalRecord() { return { status: "empty" }; },
    acknowledgeFatalRecord(id) { acknowledgements += 1; return { status: "acknowledged", recordId: id }; }
  };
}

for (const [name, value] of [
  ["oversized identifier", record({ id: `evt_rn_fatal_${"a".repeat(16384)}` })],
  ["sparse frames", record({ stackFrames: Array(1) })],
  ["text frame coordinates", record({ stackFrames: [{ filename: "index.bundle", column: "1", line: "2" }] })],
  ["oversized encoded record", record({ stackFrames: Array.from({ length: 24 }, () => ({ filename: '"'.repeat(512), column: 1, line: 2 })) })]
]) {
  test(`fatal replay rejects ${name} without acknowledging storage`, async () => {
    await withInstalledPackage(async (runtime) => {
      const client = createClient();
      const fatalStore = store(value);
      const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
        client, fatalStore, errorUtils: createErrorUtils()
      });
      assert.equal(client.issues.length, 0);
      assert.equal(fatalStore.acknowledgements(), 0);
      assert.equal(installation.fatalHealth().lastOutcome, "replay_failed");
      installation.remove();
    });
  });
}

test("fatal replay snapshots stored fields once before validating and capturing them", async () => {
  await withInstalledPackage(async (runtime) => {
    let reads = 0;
    const value = record();
    Object.defineProperty(value, "errorName", {
      enumerable: true,
      get() { reads += 1; return reads === 1 ? "TypeError" : "private application detail"; }
    });
    const client = createClient();
    const fatalStore = store(value);
    const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
      client, fatalStore, errorUtils: createErrorUtils()
    });
    assert.equal(reads, 1);
    assert.equal(client.issues[0].attributes.exception.type, "TypeError");
    assert.equal(JSON.stringify(client.issues).includes("private application detail"), false);
    assert.equal(fatalStore.acknowledgements(), 1);
    installation.remove();
  });
});

test("an unavailable admission getter cannot change into an acknowledgement on a second read", async () => {
  await withInstalledPackage(async (runtime) => {
    let reads = 0;
    const client = {
      issue() {},
      issueWithAdmission() {
        return { get status() { reads += 1; return reads === 1 ? "unavailable" : "admitted"; } };
      }
    };
    const fatalStore = store(record());
    const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
      client, fatalStore, errorUtils: createErrorUtils()
    });
    assert.equal(reads, 1);
    assert.equal(fatalStore.acknowledgements(), 0);
    assert.equal(installation.fatalHealth().lastOutcome, "admission_unavailable");
    installation.remove();
  });
});

test("generated fatal records stay within their replay byte limit", async () => {
  await withInstalledPackage(async (runtime) => {
    let pending;
    const fatalStore = store();
    fatalStore.readFatalRecord = () => pending ? { status: "pending", record: pending } : { status: "empty" };
    fatalStore.writeFatalRecord = (value) => { pending = value; return { status: "stored" }; };
    const errorUtils = createErrorUtils();
    const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
      client: createClient(), fatalStore, errorUtils
    });
    const error = new Error("application failed");
    error.stack = Array.from({ length: 24 }, () => `at entry (${'"'.repeat(512)}:1:2)`).join("\n");
    errorUtils.currentHandler()(error, true);
    assert.ok(Buffer.byteLength(JSON.stringify(pending), "utf8") <= 16384);
    const id = pending.id;
    installation.remove();
    const client = createClient();
    const replay = runtime.installLogBrewReactNativeGlobalErrorHandler({ client, fatalStore, errorUtils });
    assert.equal(client.issues[0].id, id);
    assert.equal(replay.fatalHealth().replayedRecords, 1);
    replay.remove();
  });
});

test("malformed storage results and throwing record getters retain the fatal slot", async () => {
  await withInstalledPackage(async (runtime) => {
    const throwingRecord = record();
    Object.defineProperty(throwingRecord, "id", { enumerable: true, get() { throw new Error("private storage detail"); } });
    for (const readResult of [
      undefined, null, [], "x".repeat(32768), {}, { status: "pending" },
      { status: "pending", record: record({ schemaVersion: 2 }) },
      { status: "pending", record: throwingRecord }
    ]) {
      const client = createClient();
      const fatalStore = store();
      fatalStore.readFatalRecord = () => readResult;
      const diagnostics = [];
      const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
        client, fatalStore, errorUtils: createErrorUtils(), onDiagnostic: (value) => diagnostics.push(value)
      });
      assert.equal(client.issues.length, 0);
      assert.equal(fatalStore.acknowledgements(), 0);
      assert.deepEqual(diagnostics, [{ code: "fatal_replay_failed" }]);
      installation.remove();
    }
  });
});

test("read and write storage failures remain content-free and preserve previous-handler delegation", async () => {
  await withInstalledPackage(async (runtime) => {
    const fatalStore = store();
    fatalStore.readFatalRecord = () => { throw new Error("private storage detail"); };
    fatalStore.writeFatalRecord = () => { throw new Error("private storage detail"); };
    let delegated = 0;
    const errorUtils = createErrorUtils(() => { delegated += 1; });
    const diagnostics = [];
    const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
      client: createClient(), fatalStore, errorUtils, onDiagnostic: (value) => diagnostics.push(value)
    });
    errorUtils.currentHandler()(new Error("private application detail"), true);
    assert.equal(delegated, 1);
    assert.equal(fatalStore.acknowledgements(), 0);
    assert.equal(installation.fatalHealth().lastOutcome, "storage_error");
    assert.deepEqual(diagnostics, [{ code: "fatal_replay_failed" }, { code: "fatal_store_failed" }]);
    installation.remove();
  });
});

test("throwing storage capability getters leave fatal capture unavailable without escaping startup", async () => {
  await withInstalledPackage(async (runtime) => {
    const fatalStore = store(record());
    Object.defineProperty(fatalStore, "readFatalRecord", { get() { throw new Error("private storage detail"); } });
    let delegated = 0;
    const errorUtils = createErrorUtils(() => { delegated += 1; });
    const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
      client: createClient(), fatalStore, errorUtils
    });
    assert.equal(installation.fatalHealth().available, false);
    errorUtils.currentHandler()(new Error("application failed"), true);
    assert.equal(delegated, 1);
    assert.equal(fatalStore.acknowledgements(), 0);
    installation.remove();
  });
});
