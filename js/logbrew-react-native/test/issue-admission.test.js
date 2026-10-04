import assert from "node:assert/strict";
import test from "node:test";
import { createErrorUtils, withInstalledPackage } from "./global-errors-test-support.js";

function canonicalClient(LogBrewClient, overrides = {}) {
  return LogBrewClient.create({
    apiKey: "LOGBREW_CLIENT_KEY", sdkName: "admission-test", sdkVersion: "0.1.0",
    automaticDelivery: false, ...overrides
  });
}

function fatalStore() {
  let pending = {
    corruptRecords: 0, droppedRecords: 0, errorName: "TypeError", id: "evt_rn_fatal_pending",
    schemaVersion: 1, stackFrames: [], timestamp: "2026-07-31T08:30:00.000Z"
  };
  let acknowledged = 0;
  return {
    acknowledged() { return acknowledged; },
    pending() { return pending; },
    readFatalRecord() { return pending ? { status: "pending", record: pending } : { status: "empty" }; },
    writeFatalRecord() { return { status: "storage_error" }; },
    discardFatalRecord() { return { status: "empty" }; },
    acknowledgeFatalRecord(id) {
      acknowledged += 1;
      pending = undefined;
      return { status: "acknowledged", recordId: id };
    }
  };
}

test("global error filtering with a reentrant log cannot suppress later permitted capture", async () => {
  await withInstalledPackage(async (runtime, _directory, { LogBrewClient }) => {
    let filterIssues = true;
    const client = canonicalClient(LogBrewClient, {
      eventFilter(event) {
        if (filterIssues && event.type === "issue") {
          client.log("evt_filter_notice", "2026-07-31T08:30:00.000Z", { level: "info", message: "issue filtered" });
          return false;
        }
        return true;
      }
    });
    const errorUtils = createErrorUtils();
    const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({ client, errorUtils });
    const error = new Error("private application detail");
    errorUtils.currentHandler()(error, false);
    assert.equal(installation.health().capturedEvents, 0);
    filterIssues = false;
    errorUtils.currentHandler()(error, false);
    const events = JSON.parse(client.previewJson()).events;
    assert.equal(events.filter((event) => event.type === "issue").length, 1);
    assert.equal(installation.health().capturedEvents, 1);
    assert.equal(JSON.stringify(events).includes("private application detail"), false);
    installation.remove();
  });
});

test("a filtered rejection cannot track an unrelated reentrant issue as its own capture", async () => {
  await withInstalledPackage(async (runtime, _directory, { LogBrewClient }) => {
    let filterRejections = true;
    const client = canonicalClient(LogBrewClient, {
      eventFilter(event) {
        if (filterRejections && event.attributes.metadata?.source === "react-native.promise_rejection") {
          client.issue("evt_unrelated", "2026-07-31T08:30:00.000Z", {
            level: "error", title: "Unrelated issue", message: "Unrelated issue"
          });
          return false;
        }
        return true;
      }
    });
    const handlers = runtime.createLogBrewReactNativePromiseRejectionHandlers({ client });
    handlers.onUnhandled(1);
    assert.equal(handlers.health().trackedRejections, 0);
    assert.equal(handlers.health().capturedEvents, 0);
    filterRejections = false;
    handlers.onUnhandled(1);
    handlers.onUnhandled(1);
    assert.equal(handlers.health().capturedEvents, 1);
    assert.equal(handlers.health().suppressedEvents, 1);
    assert.equal(JSON.parse(client.previewJson()).events.length, 2);
  });
});

test("fatal replay does not acknowledge a filtered issue when an unrelated log is admitted", async () => {
  await withInstalledPackage(async (runtime, _directory, { LogBrewClient }) => {
    const client = canonicalClient(LogBrewClient, {
      eventFilter(event) {
        if (event.type === "issue") {
          client.log("evt_filter_notice", "2026-07-31T08:30:00.000Z", { level: "info", message: "issue filtered" });
          return false;
        }
        return true;
      }
    });
    const store = fatalStore();
    const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
      client, errorUtils: createErrorUtils(), fatalStore: store
    });
    assert.equal(store.acknowledged(), 0);
    assert.ok(store.pending());
    assert.equal(installation.fatalHealth().replayedRecords, 0);
    assert.equal(JSON.parse(client.previewJson()).events[0].type, "log");
    installation.remove();
  });
});

test("fatal replay acknowledges its admitted issue despite unrelated reentrant capture", async () => {
  await withInstalledPackage(async (runtime, _directory, { LogBrewClient }) => {
    const client = canonicalClient(LogBrewClient, {
      eventFilter(event) {
        if (event.type === "issue") {
          client.log("evt_nested_log", "2026-07-31T08:30:00.000Z", { level: "info", message: "nested log" });
        }
        return true;
      }
    });
    const store = fatalStore();
    const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
      client, errorUtils: createErrorUtils(), fatalStore: store
    });
    assert.equal(store.acknowledged(), 1);
    assert.equal(store.pending(), undefined);
    assert.equal(installation.fatalHealth().replayedRecords, 1);
    assert.equal(JSON.parse(client.previewJson()).events.length, 2);
    installation.remove();
  });
});

test("old issue-only clients run once per report without guessed capture or duplicate suppression", async () => {
  await withInstalledPackage(async (runtime) => {
    let calls = 0;
    let counterReads = 0;
    const client = {
      issue() { calls += 1; },
      get pendingEvents() { counterReads += 1; throw new Error("counter unavailable"); }
    };
    const diagnostics = [];
    const errorUtils = createErrorUtils();
    const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
      client, errorUtils, onDiagnostic: (value) => diagnostics.push(value)
    });
    const error = new Error("application failed");
    errorUtils.currentHandler()(error, false);
    errorUtils.currentHandler()(error, false);
    assert.equal(calls, 2);
    assert.equal(counterReads, 0);
    assert.equal(installation.health().capturedEvents, 0);
    assert.equal(installation.health().lastOutcome, "admission_unavailable");
    assert.deepEqual(diagnostics, [
      { code: "capture_admission_unavailable" }, { code: "capture_admission_unavailable" }
    ]);
    const handlers = runtime.createLogBrewReactNativePromiseRejectionHandlers({ client });
    handlers.onUnhandled(1);
    handlers.onUnhandled(1);
    assert.equal(calls, 4);
    assert.equal(handlers.health().trackedRejections, 0);
    assert.equal(handlers.health().lastOutcome, "admission_unavailable");
    installation.remove();
  });
});

test("an issue override runs once and cannot authorize fatal acknowledgement", async () => {
  await withInstalledPackage(async (runtime, _directory, { LogBrewClient }) => {
    const client = canonicalClient(LogBrewClient);
    const issue = client.issue;
    let calls = 0;
    client.issue = (...args) => { calls += 1; issue.apply(client, args); };
    const store = fatalStore();
    const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
      client, errorUtils: createErrorUtils(), fatalStore: store
    });
    assert.equal(calls, 1);
    assert.equal(client.pendingEvents(), 1);
    assert.equal(store.acknowledged(), 0);
    assert.ok(store.pending());
    assert.equal(installation.fatalHealth().lastOutcome, "admission_unavailable");
    installation.remove();
  });
});

test("direct durable fatal admission uses its receipt despite reentrant queue changes", async () => {
  await withInstalledPackage(async (runtime, _directory, { LogBrewClient }) => {
    for (const admitted of [false, true]) {
      const client = canonicalClient(LogBrewClient, {
        eventFilter(event) {
          if (event.type === "issue") {
            client.log("evt_nested_log", "2026-07-31T08:30:00.000Z", { level: "info", message: "nested log" });
            return admitted;
          }
          return true;
        }
      });
      Object.defineProperty(client, Symbol.for("co.logbrew.react-native.durable-event-queue"), { value: true });
      const errorUtils = createErrorUtils();
      const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({ client, errorUtils });
      errorUtils.currentHandler()(new Error("private fatal detail"), true);
      assert.equal(installation.fatalHealth().storedRecords, admitted ? 1 : 0);
      assert.equal(installation.health().lastOutcome, admitted ? "fatal_stored" : "fatal_store_failed");
      assert.equal(JSON.parse(client.previewJson()).events.length, admitted ? 2 : 1);
      installation.remove();
    }
  });
});

test("a legacy direct durable client reports uncertainty and retries each fatal report", async () => {
  await withInstalledPackage(async (runtime) => {
    let calls = 0;
    const client = {
      issue() { calls += 1; },
      [Symbol.for("co.logbrew.react-native.durable-event-queue")]: true
    };
    const diagnostics = [];
    const errorUtils = createErrorUtils();
    const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
      client, errorUtils, onDiagnostic: (value) => diagnostics.push(value)
    });
    const error = new Error("private fatal detail");
    errorUtils.currentHandler()(error, true);
    errorUtils.currentHandler()(error, true);
    assert.equal(calls, 2);
    assert.equal(installation.fatalHealth().storedRecords, 0);
    assert.equal(installation.fatalHealth().lastOutcome, "admission_unavailable");
    assert.equal(installation.health().lastOutcome, "admission_unavailable");
    assert.deepEqual(diagnostics, [
      { code: "fatal_admission_unavailable" }, { code: "fatal_admission_unavailable" }
    ]);
    installation.remove();
  });
});

for (const [name, receipt] of [
  ["missing", () => undefined],
  ["unknown", () => ({ status: "private receipt detail" })],
  ["asynchronous", () => Promise.resolve({ status: "admitted" })],
  ["hostile", () => ({ get status() { throw new Error("private receipt detail"); } })]
]) {
  test(`${name} admission receipts cannot authorize tracking or fatal acknowledgement`, async () => {
    await withInstalledPackage(async (runtime) => {
      let calls = 0;
      const client = {
        issue() { throw new Error("issue must not be called twice"); },
        issueWithAdmission() { calls += 1; return receipt(); },
        get pendingEvents() { throw new Error("aggregate counter must not be read"); },
        get droppedEvents() { throw new Error("aggregate counter must not be read"); }
      };
      const diagnostics = [];
      const errorUtils = createErrorUtils();
      const store = fatalStore();
      const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
        client, errorUtils, fatalStore: store, onDiagnostic: (value) => diagnostics.push(value)
      });
      const error = new Error("private application detail");
      errorUtils.currentHandler()(error, false);
      errorUtils.currentHandler()(error, false);
      const handlers = runtime.createLogBrewReactNativePromiseRejectionHandlers({
        client, onDiagnostic: (value) => diagnostics.push(value)
      });
      handlers.onUnhandled(1);
      handlers.onUnhandled(1);
      assert.equal(calls, 5);
      assert.equal(installation.health().capturedEvents, 0);
      assert.equal(handlers.health().trackedRejections, 0);
      assert.equal(store.acknowledged(), 0);
      assert.ok(store.pending());
      assert.equal(installation.fatalHealth().lastOutcome, "admission_unavailable");
      assert.deepEqual(diagnostics, [
        { code: "fatal_replay_admission_unavailable" },
        { code: "capture_admission_unavailable" },
        { code: "capture_admission_unavailable" },
        { code: "promise_rejection_admission_unavailable" },
        { code: "promise_rejection_admission_unavailable" }
      ]);
      installation.remove();
    });
  });
}
