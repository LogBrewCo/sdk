import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { LogBrewClient, RecordingTransport } from "../index.js";
import { LogBrewClient as MobileClient } from "../react-native.js";

const timestamp = "2026-06-02T10:00:03Z";
const attributes = { title: "Checkout failed", level: "error" };

function createClient(options = {}) {
  return LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-js",
    sdkVersion: "0.1.0",
    ...options
  });
}

test("issue admission reports only a frozen queue outcome and keeps issue void", async () => {
  const client = createClient();
  const result = client.issueWithAdmission("evt_issue_001", timestamp, attributes);
  assert.deepEqual(result, { status: "admitted" });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(client.issue("evt_issue_002", timestamp, attributes), undefined);
  const transport = RecordingTransport.alwaysAccept();
  await client.flush(transport);
  assert.deepEqual(JSON.parse(transport.lastBody()).events.map((event) => event.id), [
    "evt_issue_001", "evt_issue_002"
  ]);
  assert.deepEqual(result, { status: "admitted" });
});

test("a filter's unrelated log cannot make its rejected issue admitted", () => {
  const client = createClient({
    eventFilter(event) {
      if (event.type === "issue") {
        client.log("evt_filter_notice", timestamp, { message: "Issue filtered", level: "info" });
        event.attributes.title = "Filter copy changed";
        return false;
      }
      return true;
    }
  });
  const result = client.issueWithAdmission("evt_issue_001", timestamp, attributes);
  assert.deepEqual(result, { status: "filtered" });
  assert.equal(client.pendingEvents(), 1);
  assert.deepEqual(JSON.parse(client.previewJson()).events.map((event) => event.type), ["log"]);
  assert.deepEqual(attributes, { title: "Checkout failed", level: "error" });
});

test("nested issue capture has an independent admission result", () => {
  let nested;
  const client = createClient({
    eventFilter(event) {
      if (event.id === "evt_issue_outer") {
        nested = client.issueWithAdmission("evt_issue_inner", timestamp, attributes);
        return false;
      }
      return true;
    }
  });
  const outer = client.issueWithAdmission("evt_issue_outer", timestamp, attributes);
  assert.deepEqual(outer, { status: "filtered" });
  assert.deepEqual(nested, { status: "admitted" });
  assert.deepEqual(JSON.parse(client.previewJson()).events.map((event) => event.id), ["evt_issue_inner"]);
});

for (const [bounds, reason] of [
  [{ maxBatchBytes: 1 }, "event_too_large"],
  [{ maxQueueBytes: 1 }, "queue_bytes_overflow"]
]) {
  test(`issue admission records ${reason} without exposing event contents`, () => {
    const client = createClient(bounds);
    assert.deepEqual(client.issueWithAdmission("evt_issue_001", timestamp, attributes), {
      status: "dropped", reason
    });
    assert.equal(client.pendingEvents(), 0);
    assert.equal(client.droppedEvents(), 1);
  });
}

test("drop callback reentry cannot replace the dropped issue's result", () => {
  let nested;
  const client = createClient({
    maxQueueSize: 1,
    onEventDropped() {
      client.purgePendingEvents();
      nested = client.issueWithAdmission("evt_issue_inner", timestamp, attributes);
    }
  });
  client.log("evt_log_001", timestamp, { message: "Queue occupied", level: "info" });
  const outer = client.issueWithAdmission("evt_issue_outer", timestamp, attributes);
  assert.deepEqual(outer, { status: "dropped", reason: "queue_overflow" });
  assert.deepEqual(nested, { status: "admitted" });
  assert.deepEqual(JSON.parse(client.previewJson()).events.map((event) => event.id), ["evt_issue_inner"]);
});

test("admission preserves event-store failure and leaves no in-memory issue", () => {
  const failure = new Error("Store append failed");
  const client = createClient({
    eventStore: {
      load() { return []; },
      append() { throw failure; },
      acknowledge() {},
      purge() {},
      close() {}
    }
  });
  assert.throws(() => client.issueWithAdmission("evt_issue_001", timestamp, attributes), (error) => error === failure);
  assert.equal(client.pendingEvents(), 0);
});

test("admission preserves issue breadcrumbs and explicit trace context", () => {
  const client = createClient({
    context: { schemaVersion: 1, trace: { traceId: "11111111111111111111111111111111", spanId: "2222222222222222" } }
  });
  client.addBreadcrumb({ category: "navigation", message: "Checkout opened" }, timestamp);
  assert.deepEqual(client.issueWithAdmission("evt_issue_001", timestamp, attributes), { status: "admitted" });
  const event = JSON.parse(client.previewJson()).events[0];
  assert.equal(event.attributes.breadcrumbs[0].message, "Checkout opened");
  assert.equal(event.attributes.context.trace.spanId, "2222222222222222");
});

test("custom issue overrides run once and produce unavailable admission", () => {
  const client = createClient();
  let calls = 0;
  client.issue = function (id, time, value) {
    assert.equal(this, client);
    assert.equal(id, "evt_issue_001");
    assert.equal(time, timestamp);
    assert.equal(value, attributes);
    calls += 1;
  };
  assert.deepEqual(client.issueWithAdmission("evt_issue_001", timestamp, attributes), { status: "unavailable" });
  assert.equal(calls, 1);
  assert.equal(client.pendingEvents(), 0);
});

test("forwarding issue overrides are preserved without guessing their admission", () => {
  const client = createClient();
  client.issue = function (id, time, value) {
    LogBrewClient.prototype.issue.call(this, id, time, value);
  };
  assert.deepEqual(client.issueWithAdmission("evt_issue_001", timestamp, attributes), { status: "unavailable" });
  assert.equal(client.pendingEvents(), 1);
  const failure = new Error("Custom issue failed");
  client.issue = () => { throw failure; };
  assert.throws(() => client.issueWithAdmission("evt_issue_002", timestamp, attributes), (error) => error === failure);
});

test("prototype issue overrides retain their custom dispatch", () => {
  const original = LogBrewClient.prototype.issue;
  let calls = 0;
  try {
    LogBrewClient.prototype.issue = () => { calls += 1; };
    const client = createClient();
    assert.deepEqual(client.issueWithAdmission("evt_issue_001", timestamp, attributes), { status: "unavailable" });
    assert.equal(calls, 1);
    assert.equal(client.pendingEvents(), 0);
  } finally {
    LogBrewClient.prototype.issue = original;
  }
});

test("custom issue accessors are read once before capture", () => {
  const client = createClient();
  let reads = 0;
  let calls = 0;
  Object.defineProperty(client, "issue", {
    get() {
      reads += 1;
      assert.equal(reads, 1);
      return () => { calls += 1; };
    }
  });
  assert.deepEqual(client.issueWithAdmission("evt_issue_001", timestamp, attributes), { status: "unavailable" });
  assert.equal(reads, 1);
  assert.equal(calls, 1);
});

test("filter exceptions preserve the original failure and do not enqueue an issue", () => {
  const failure = new Error("Filter failed");
  const client = createClient({ eventFilter() { throw failure; } });
  assert.throws(() => client.issueWithAdmission("evt_issue_001", timestamp, attributes), (error) => error === failure);
  assert.equal(client.pendingEvents(), 0);
});

test("admission rejects invalid and closed-client capture without a success result", async () => {
  const client = createClient();
  assert.throws(() => client.issueWithAdmission("", timestamp, attributes), /event id/);
  await client.shutdown(RecordingTransport.alwaysAccept());
  assert.throws(() => client.issueWithAdmission("evt_issue_001", timestamp, attributes), /shut down/);
});

test("ESM, CommonJS and mobile entry points expose the same admission method", () => {
  const require = createRequire(import.meta.url);
  const { LogBrewClient: CommonJsClient } = require("../index.cjs");
  assert.equal(CommonJsClient, LogBrewClient);
  assert.equal(MobileClient, LogBrewClient);
  const client = MobileClient.create({ apiKey: "LOGBREW_API_KEY", sdkName: "logbrew-js", sdkVersion: "0.1.0" });
  assert.deepEqual(client.issueWithAdmission("evt_issue_001", timestamp, attributes), { status: "admitted" });
});
