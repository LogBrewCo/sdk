import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createClient,
  createErrorUtils,
  packageRoot,
  withInstalledPackage
} from "./global-errors-test-support.js";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createFatalStore({
  acknowledgeFailures = 0,
  onWrite,
  readResult,
  record
} = {}) {
  let pending = clone(record);
  let remainingAcknowledgeFailures = acknowledgeFailures;
  return {
    acknowledgeFatalRecord(id) {
      if (remainingAcknowledgeFailures > 0) {
        remainingAcknowledgeFailures -= 1;
        return { status: "storage_error" };
      }
      if (!pending) {
        return { status: "empty" };
      }
      if (pending.id !== id) {
        return { recordId: pending.id, status: "id_mismatch" };
      }
      pending = undefined;
      return { recordId: id, status: "acknowledged" };
    },
    currentRecord() {
      return clone(pending);
    },
    discardFatalRecord() {
      if (!pending) {
        return { status: "empty" };
      }
      const recordId = pending.id;
      pending = undefined;
      return { recordId, status: "discarded" };
    },
    readFatalRecord() {
      if (readResult) {
        return clone(readResult);
      }
      return pending
        ? { record: clone(pending), status: "pending" }
        : { status: "empty" };
    },
    writeFatalRecord(nextRecord) {
      onWrite?.(clone(nextRecord));
      if (pending) {
        pending.droppedRecords += 1;
        return {
          droppedRecords: pending.droppedRecords,
          recordId: pending.id,
          status: "dropped_pending"
        };
      }
      pending = {
        ...clone(nextRecord),
        corruptRecords: 0,
        droppedRecords: 0
      };
      return { recordId: pending.id, status: "stored" };
    }
  };
}

const pendingFatalRecord = Object.freeze({
  corruptRecords: 0,
  droppedRecords: 0,
  errorName: "TypeError",
  id: "evt_rn_fatal_fixed",
  schemaVersion: 1,
  stackFrames: [
    {
      column: 34,
      filename: "index.android.bundle",
      line: 12
    }
  ],
  timestamp: "2026-07-25T12:00:00.000Z"
});

function createCanonicalClient(LogBrewClient, overrides = {}) {
  return LogBrewClient.create({
    apiKey: "LOGBREW_CLIENT_KEY",
    sdkName: "react-native-fatal-test",
    sdkVersion: "0.1.0",
    ...overrides
  });
}

function addExistingIssue(client) {
  client.issue("evt_existing", "2026-07-25T11:59:59.000Z", {
    level: "warning",
    message: "Existing bounded issue",
    title: "Existing bounded issue"
  });
}

test("stores a privacy-bounded fatal record synchronously before chaining", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const order = [];
    const fatalStore = createFatalStore({
      onWrite() {
        order.push("write");
      }
    });
    const errorUtils = createErrorUtils(() => {
      order.push("previous");
    });
    const client = createClient();
    const installation = installLogBrewReactNativeGlobalErrorHandler({
      client,
      errorUtils,
      fatalStore
    });
    const sensitiveKey = ["to", "ken"].join("");
    const sensitivePair = `${sensitiveKey}=hidden`;
    const error = new TypeError(`${sensitivePair} hidden@example.test`);
    error.stack = [
      `TypeError: ${sensitivePair} hidden@example.test`,
      `    at private (https://private.example.test/index.android.bundle?${sensitivePair}:12:34)`,
      "    at local (/home/example/source.js:56:78)"
    ].join("\n");

    errorUtils.currentHandler()(error, true);

    assert.deepEqual(order, ["write", "previous"]);
    assert.equal(client.issues.length, 0);
    const record = fatalStore.currentRecord();
    assert.match(record.id, /^evt_rn_fatal_[a-z0-9]+_[a-z0-9]+$/u);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.errorName, "TypeError");
    assert.deepEqual(record.stackFrames, [
      {
        column: 34,
        filename: "index.android.bundle",
        line: 12
      }
    ]);
    const serialized = JSON.stringify(record);
    for (const forbidden of [
      sensitivePair,
      "hidden@example.test",
      "private.example.test",
      "/home/",
      "example/source.js"
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    assert.deepEqual(installation.fatalHealth(), {
      acknowledgedRecords: 0,
      available: true,
      corruptRecords: 0,
      droppedRecords: 0,
      lastOutcome: "stored",
      replayedRecords: 0,
      storedRecords: 1
    });
  });
});

test("normalizes a single-segment URL bundle pathname before persistence", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const fatalStore = createFatalStore();
    const errorUtils = createErrorUtils();
    installLogBrewReactNativeGlobalErrorHandler({
      client: createClient(),
      errorUtils,
      fatalStore
    });
    const error = new Error("private");
    error.stack = [
      "Error: private",
      "    at entry (https://mobile.example.test/index.android.bundle?ignored:12:34)"
    ].join("\n");

    errorUtils.currentHandler()(error, true);

    assert.deepEqual(fatalStore.currentRecord().stackFrames, [
      {
        column: 34,
        filename: "index.android.bundle",
        line: 12
      }
    ]);
  });
});

test("rejects hostile replay records containing Unix or Windows absolute paths", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    for (const filename of [
      "/home/example/source.js",
      "D:/account-data/source.js"
    ]) {
      const diagnostics = [];
      const fatalStore = createFatalStore({
        record: {
          ...pendingFatalRecord,
          stackFrames: [{ column: 34, filename, line: 12 }]
        }
      });
      const client = createClient();

      const installation = installLogBrewReactNativeGlobalErrorHandler({
        client,
        errorUtils: createErrorUtils(),
        fatalStore,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
      });

      assert.equal(client.issues.length, 0);
      assert.equal(fatalStore.currentRecord().stackFrames[0].filename, filename);
      assert.equal(installation.fatalHealth().lastOutcome, "replay_failed");
      assert.deepEqual(diagnostics, [{ code: "fatal_replay_failed" }]);
    }
  });
});

test("replays one pending fatal with its stored identity and acknowledges after admission", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const fatalStore = createFatalStore({ record: pendingFatalRecord });
    const client = createClient();
    const errorUtils = createErrorUtils();

    const installation = installLogBrewReactNativeGlobalErrorHandler({
      client,
      errorUtils,
      fatalStore
    });

    assert.equal(client.issues.length, 1);
    assert.deepEqual(client.issues[0], {
      attributes: {
        exception: {
          type: "TypeError",
          mechanism: {
            type: "react_native_error_utils",
            handled: false
          }
        },
        level: "fatal",
        message: "React Native global JavaScript report",
        metadata: {
          automatic: true,
          fatal: true,
          handled: false,
          mechanism: "react_native_error_utils",
          nativeCorruptRecords: 0,
          nativeDroppedRecords: 0,
          replayed: true,
          source: "react-native.global_error"
        },
        stackFrames: [
          {
            column: 34,
            filename: "index.android.bundle",
            line: 12
          }
        ],
        title: "React Native global JavaScript report"
      },
      id: "evt_rn_fatal_fixed",
      timestamp: "2026-07-25T12:00:00.000Z"
    });
    assert.equal(fatalStore.currentRecord(), undefined);
    assert.deepEqual(installation.fatalHealth(), {
      acknowledgedRecords: 1,
      available: true,
      corruptRecords: 0,
      droppedRecords: 0,
      lastOutcome: "acknowledged",
      replayedRecords: 1,
      storedRecords: 0
    });

    assert.equal(installation.remove(), true);
    installLogBrewReactNativeGlobalErrorHandler({ client, errorUtils, fatalStore });
    assert.equal(client.issues.length, 1);
  });
});

test("retains a replay until the client queue admits it", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const diagnostics = [];
    const fatalStore = createFatalStore({ record: pendingFatalRecord });
    const installation = installLogBrewReactNativeGlobalErrorHandler({
      client: createClient({ drop: true }),
      errorUtils: createErrorUtils(),
      fatalStore,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    assert.equal(fatalStore.currentRecord().id, pendingFatalRecord.id);
    assert.equal(installation.fatalHealth().lastOutcome, "replay_not_admitted");
    assert.deepEqual(diagnostics, [{ code: "fatal_replay_not_admitted" }]);
  });
});

test("observes canonical admission with pre-existing queue entries before acknowledging", async () => {
  await withInstalledPackage(async (
    { installLogBrewReactNativeGlobalErrorHandler },
    _packageDir,
    { LogBrewClient }
  ) => {
    const fatalStore = createFatalStore({ record: pendingFatalRecord });
    const client = createCanonicalClient(LogBrewClient);
    addExistingIssue(client);
    assert.equal(client.pendingEvents(), 1);
    assert.equal(client.droppedEvents(), 0);

    installLogBrewReactNativeGlobalErrorHandler({
      client,
      errorUtils: createErrorUtils(),
      fatalStore
    });

    assert.equal(client.pendingEvents(), 2);
    assert.equal(client.droppedEvents(), 0);
    assert.equal(fatalStore.currentRecord(), undefined);
    const events = JSON.parse(client.previewJson()).events;
    assert.deepEqual(events.map(({ id }) => id), ["evt_existing", pendingFatalRecord.id]);
  });
});

test("retains a fatal replay when the canonical event filter silently rejects it", async () => {
  await withInstalledPackage(async (
    { installLogBrewReactNativeGlobalErrorHandler },
    _packageDir,
    { LogBrewClient }
  ) => {
    const diagnostics = [];
    const fatalStore = createFatalStore({ record: pendingFatalRecord });
    const client = createCanonicalClient(LogBrewClient, {
      eventFilter: (event) => event.id !== pendingFatalRecord.id
    });

    const installation = installLogBrewReactNativeGlobalErrorHandler({
      client,
      errorUtils: createErrorUtils(),
      fatalStore,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    assert.equal(client.pendingEvents(), 0);
    assert.equal(client.droppedEvents(), 0);
    assert.equal(fatalStore.currentRecord().id, pendingFatalRecord.id);
    assert.equal(installation.fatalHealth().lastOutcome, "replay_not_admitted");
    assert.deepEqual(diagnostics, [{ code: "fatal_replay_not_admitted" }]);
  });
});

test("retains a fatal replay when the canonical bounded queue drops it", async () => {
  await withInstalledPackage(async (
    { installLogBrewReactNativeGlobalErrorHandler },
    _packageDir,
    { LogBrewClient }
  ) => {
    const diagnostics = [];
    const fatalStore = createFatalStore({ record: pendingFatalRecord });
    const client = createCanonicalClient(LogBrewClient, { maxQueueSize: 1 });
    addExistingIssue(client);

    const installation = installLogBrewReactNativeGlobalErrorHandler({
      client,
      errorUtils: createErrorUtils(),
      fatalStore,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    assert.equal(client.pendingEvents(), 1);
    assert.equal(client.droppedEvents(), 1);
    assert.equal(fatalStore.currentRecord().id, pendingFatalRecord.id);
    assert.equal(installation.fatalHealth().lastOutcome, "replay_not_admitted");
    assert.deepEqual(diagnostics, [{ code: "fatal_replay_not_admitted" }]);
  });
});

test("retains a fatal replay when canonical persistence append throws", async () => {
  await withInstalledPackage(async (
    { installLogBrewReactNativeGlobalErrorHandler },
    _packageDir,
    { LogBrewClient }
  ) => {
    const diagnostics = [];
    const fatalStore = createFatalStore({ record: pendingFatalRecord });
    const eventStore = {
      acknowledge() {},
      append() {
        throw new Error("private append failure");
      },
      close() {},
      load() {
        return [];
      },
      purge() {}
    };
    const client = createCanonicalClient(LogBrewClient, { eventStore });

    const installation = installLogBrewReactNativeGlobalErrorHandler({
      client,
      errorUtils: createErrorUtils(),
      fatalStore,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    assert.equal(client.pendingEvents(), 0);
    assert.equal(client.droppedEvents(), 0);
    assert.equal(fatalStore.currentRecord().id, pendingFatalRecord.id);
    assert.equal(installation.fatalHealth().lastOutcome, "replay_failed");
    assert.deepEqual(diagnostics, [{ code: "fatal_replay_failed" }]);
  });
});

test("retries a failed acknowledgement without admitting the same id twice in one runtime", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const diagnostics = [];
    const fatalStore = createFatalStore({
      acknowledgeFailures: 1,
      record: pendingFatalRecord
    });
    const client = createClient();
    const errorUtils = createErrorUtils();
    const first = installLogBrewReactNativeGlobalErrorHandler({
      client,
      errorUtils,
      fatalStore,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    assert.equal(client.issues.length, 1);
    assert.equal(fatalStore.currentRecord().id, pendingFatalRecord.id);
    assert.equal(first.fatalHealth().lastOutcome, "acknowledge_failed");
    assert.equal(first.remove(), true);

    const second = installLogBrewReactNativeGlobalErrorHandler({
      client,
      errorUtils,
      fatalStore,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    assert.equal(client.issues.length, 1);
    assert.equal(fatalStore.currentRecord(), undefined);
    assert.equal(second.fatalHealth().lastOutcome, "acknowledged");
    assert.deepEqual(diagnostics, [{ code: "fatal_acknowledge_failed" }]);
  });
});

test("surfaces corruption and single-slot drops without replacing the older record", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const corruptionDiagnostics = [];
    const corruptInstallation = installLogBrewReactNativeGlobalErrorHandler({
      client: createClient(),
      errorUtils: createErrorUtils(),
      fatalStore: createFatalStore({
        readResult: {
          corruptRecords: 1,
          status: "corrupt_discarded"
        }
      }),
      onDiagnostic: (diagnostic) => corruptionDiagnostics.push(diagnostic)
    });
    assert.equal(corruptInstallation.fatalHealth().corruptRecords, 1);
    assert.equal(corruptInstallation.fatalHealth().lastOutcome, "corrupt_discarded");
    assert.deepEqual(corruptionDiagnostics, [{ code: "fatal_corrupt_record_discarded" }]);

    const dropDiagnostics = [];
    const fatalStore = createFatalStore({ record: pendingFatalRecord });
    const errorUtils = createErrorUtils();
    const installation = installLogBrewReactNativeGlobalErrorHandler({
      client: createClient({ drop: true }),
      errorUtils,
      fatalStore,
      onDiagnostic: (diagnostic) => dropDiagnostics.push(diagnostic)
    });
    errorUtils.currentHandler()(new Error("new fatal private value"), true);

    assert.equal(fatalStore.currentRecord().id, pendingFatalRecord.id);
    assert.equal(fatalStore.currentRecord().droppedRecords, 1);
    assert.equal(installation.fatalHealth().droppedRecords, 1);
    assert.equal(installation.fatalHealth().lastOutcome, "dropped_pending");
    assert.deepEqual(dropDiagnostics, [
      { code: "fatal_replay_not_admitted" },
      { code: "fatal_record_dropped" }
    ]);
  });
});

test("handler removal retains the record and explicit rollback discard clears it", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const fatalStore = createFatalStore({ record: pendingFatalRecord });
    const errorUtils = createErrorUtils();
    const installation = installLogBrewReactNativeGlobalErrorHandler({
      client: { issue() {} },
      errorUtils,
      fatalStore
    });

    assert.equal(installation.remove(), true);
    assert.equal(fatalStore.currentRecord().id, pendingFatalRecord.id);
    assert.equal(installation.discardPendingFatalRecord(), true);
    assert.equal(fatalStore.currentRecord(), undefined);
    assert.equal(installation.discardPendingFatalRecord(), false);
  });
});

test("public documentation states stable-id replay and excludes adjacent ownership", () => {
  const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8");
  assert.match(readme, /createLogBrewReactNativePromiseRejectionHandlers/u);
  assert.match(readme, /installLogBrewReactNativePromiseRejectionTracker/u);
  assert.match(readme, /takeOwnership: true/u);
  assert.match(readme, /one Promise rejection tracker slot/u);
  assert.match(readme, /cannot reinstate an earlier tracker/u);
  assert.match(readme, /LogBrew does not install, replace, or patch Promise/u);
  assert.match(readme, /stable-ID at-least-once replay/u);
  assert.match(readme, /acknowledgement happens only after local queue admission/u);
  assert.match(readme, /does not claim mathematically exactly-once delivery/u);
  assert.match(readme, /native crash capture/u);
  assert.match(readme, /ANR or hang detection/u);
  assert.match(readme, /general offline queueing/u);
  assert.match(readme, /symbolication/u);
});
