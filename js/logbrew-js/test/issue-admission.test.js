import { CLIENT_IDENTITY, createClient, field, fieldOfEach, memoryEventStore, parseJson, pick, previewEvents, previewIds, recordAt } from "./capture-helpers.js";
import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { DroppedEvent, IssueAdmission, IssueAttributes } from "@logbrew/sdk"
 * @import { ClientOptions } from "./capture-helpers.js"
 */

const TIMESTAMP = "2026-06-02T10:00:03Z";
/** @type {IssueAttributes} */
const ATTRIBUTES = { level: "error", title: "Checkout failed" };
const NO_EVENTS = 0;
const ONE_EVENT = 1;
const ONE_BYTE = 1;

/**
 * @param {LogBrewClient} client
 * @param {string} id
 * @returns {unknown}
 */
function issueReturnValue(client, id) {
  /** @type {unknown} */
  const issue = Reflect.get(client, "issue");
  assert.ok(typeof issue === "function");
  /** @type {unknown} */
  const returned = Reflect.apply(issue, client, [id, TIMESTAMP, ATTRIBUTES]);
  return returned;
}

/**
 * @param {LogBrewClient} client
 * @returns {Promise<readonly unknown[]>}
 */
async function flushedIds(client) {
  const transport = RecordingTransport.alwaysAccept();
  await client.flush(transport);
  const body = transport.lastBody();
  assert.ok(typeof body === "string");
  return fieldOfEach(field(parseJson(body), "events"), "id");
}

/**
 * @param {ClientOptions} bounds
 * @param {DroppedEvent["reason"]} reason
 * @returns {Promise<void>}
 */
async function testDroppedAdmission(bounds, reason) {
  await test(`issue admission records ${reason} without exposing event contents`, () => {
    const client = createClient(bounds);
    assert.deepEqual(client.issueWithAdmission("evt_issue_001", TIMESTAMP, ATTRIBUTES), {
      reason, status: "dropped"
    });
    assert.equal(client.pendingEvents(), NO_EVENTS);
    assert.equal(client.droppedEvents(), ONE_EVENT);
  });
}

await test("issue admission reports only a frozen queue outcome and keeps issue void", async () => {
  const client = createClient();
  const result = client.issueWithAdmission("evt_issue_001", TIMESTAMP, ATTRIBUTES);
  assert.deepEqual(result, { status: "admitted" });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(issueReturnValue(client, "evt_issue_002"), undefined);
  assert.deepEqual(await flushedIds(client), [
    "evt_issue_001", "evt_issue_002"
  ]);
  assert.deepEqual(result, { status: "admitted" });
});

await test("a filter's unrelated log cannot make its rejected issue admitted", () => {
  const client = createClient({
    /**
     * @param {unknown} event
     * @returns {boolean}
     */
    eventFilter(event) {
      if (field(event, "type") === "issue") {
        client.log("evt_filter_notice", TIMESTAMP, { level: "info", message: "Issue filtered" });
        recordAt(event, "attributes")["title"] = "Filter copy changed";
        return false;
      }
      return true;
    }
  });
  const result = client.issueWithAdmission("evt_issue_001", TIMESTAMP, ATTRIBUTES);
  assert.deepEqual(result, { status: "filtered" });
  assert.equal(client.pendingEvents(), ONE_EVENT);
  assert.deepEqual(fieldOfEach(previewEvents(client), "type"), ["log"]);
  assert.deepEqual(ATTRIBUTES, { level: "error", title: "Checkout failed" });
});

await test("nested issue capture has an independent admission result", () => {
  /** @type {IssueAdmission[]} */
  const nested = [];
  const client = createClient({
    /**
     * @param {unknown} event
     * @returns {boolean}
     */
    eventFilter(event) {
      if (field(event, "id") === "evt_issue_outer") {
        nested.push(client.issueWithAdmission("evt_issue_inner", TIMESTAMP, ATTRIBUTES));
        return false;
      }
      return true;
    }
  });
  const outer = client.issueWithAdmission("evt_issue_outer", TIMESTAMP, ATTRIBUTES);
  assert.deepEqual(outer, { status: "filtered" });
  const [nestedResult] = nested;
  assert.deepEqual(nestedResult, { status: "admitted" });
  assert.deepEqual(previewIds(client), ["evt_issue_inner"]);
});

await testDroppedAdmission({ maxBatchBytes: ONE_BYTE }, "event_too_large");
await testDroppedAdmission({ maxQueueBytes: ONE_BYTE }, "queue_bytes_overflow");

await test("drop callback reentry cannot replace the dropped issue's result", () => {
  /** @type {IssueAdmission[]} */
  const nested = [];
  const client = createClient({
    maxQueueSize: ONE_EVENT,
    onEventDropped() {
      client.purgePendingEvents();
      nested.push(client.issueWithAdmission("evt_issue_inner", TIMESTAMP, ATTRIBUTES));
    }
  });
  client.log("evt_log_001", TIMESTAMP, { level: "info", message: "Queue occupied" });
  const outer = client.issueWithAdmission("evt_issue_outer", TIMESTAMP, ATTRIBUTES);
  assert.deepEqual(outer, { reason: "queue_overflow", status: "dropped" });
  const [nestedResult] = nested;
  assert.deepEqual(nestedResult, { status: "admitted" });
  assert.deepEqual(previewIds(client), ["evt_issue_inner"]);
});

await test("admission preserves event-store failure and leaves no in-memory issue", () => {
  const failure = new Error("Store append failed");
  const client = createClient({
    eventStore: {
      ...memoryEventStore(),
      append() {
        throw failure;
      }
    }
  });
  assert.throws(() => client.issueWithAdmission("evt_issue_001", TIMESTAMP, ATTRIBUTES), (reason) => reason === failure);
  assert.equal(client.pendingEvents(), NO_EVENTS);
});

await test("admission preserves issue breadcrumbs and explicit trace context", () => {
  const client = LogBrewClient.create({
    ...CLIENT_IDENTITY,
    context: { schemaVersion: 1, trace: { spanId: "2222222222222222", traceId: "11111111111111111111111111111111" } }
  });
  client.addBreadcrumb({ category: "navigation", message: "Checkout opened" }, TIMESTAMP);
  assert.deepEqual(client.issueWithAdmission("evt_issue_001", TIMESTAMP, ATTRIBUTES), { status: "admitted" });
  const [event] = previewEvents(client);
  assert.equal(pick(event, "attributes.breadcrumbs.0.message"), "Checkout opened");
  assert.equal(pick(event, "attributes.context.trace.spanId"), "2222222222222222");
});

await test("filter exceptions preserve the original failure and do not enqueue an issue", () => {
  const failure = new Error("Filter failed");
  const client = createClient({
    eventFilter() {
      throw failure;
    }
  });
  assert.throws(() => client.issueWithAdmission("evt_issue_001", TIMESTAMP, ATTRIBUTES), (reason) => reason === failure);
  assert.equal(client.pendingEvents(), NO_EVENTS);
});

await test("admission rejects invalid and closed-client capture without a success result", async () => {
  const client = createClient();
  assert.throws(() => client.issueWithAdmission("", TIMESTAMP, ATTRIBUTES), /event id/u);
  await client.shutdown(RecordingTransport.alwaysAccept());
  assert.throws(() => client.issueWithAdmission("evt_issue_001", TIMESTAMP, ATTRIBUTES), /shut down/u);
});
