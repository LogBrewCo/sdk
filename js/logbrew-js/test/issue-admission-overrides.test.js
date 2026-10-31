import { CLIENT_IDENTITY, createClient, field } from "./capture-helpers.js";
import { LogBrewClient } from "@logbrew/sdk";
import { LogBrewClient as MobileClient } from "../react-native.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

/**
 * @import { IssueAttributes } from "@logbrew/sdk"
 */

const TIMESTAMP = "2026-06-02T10:00:03Z";
/** @type {IssueAttributes} */
const ATTRIBUTES = { level: "error", title: "Checkout failed" };
const NO_EVENTS = 0;
const ONE_EVENT = 1;
const ONCE = 1;
const INCREMENT = 1;
const requireFromTest = createRequire(import.meta.url);

/**
 * @this {LogBrewClient}
 * @param {string} id
 * @param {string} time
 * @param {unknown} value
 * @returns {void}
 */
function forwardIssue(id, time, value) {
  /** @type {unknown} */
  const prototypeIssue = Object.getOwnPropertyDescriptor(LogBrewClient.prototype, "issue")?.value;
  assert.ok(typeof prototypeIssue === "function");
  Reflect.apply(prototypeIssue, this, [id, time, value]);
}

await test("custom issue overrides run once and produce unavailable admission", () => {
  const client = createClient();
  /** @type {unknown[][]} */
  const calls = [];

  /**
   * @this {LogBrewClient}
   * @param {string} id
   * @param {string} time
   * @param {unknown} value
   * @returns {void}
   */
  function customIssue(id, time, value) {
    assert.equal(this, client);
    assert.equal(id, "evt_issue_001");
    assert.equal(time, TIMESTAMP);
    assert.equal(value, ATTRIBUTES);
    calls.push([id, time, value]);
  }

  client.issue = customIssue;
  assert.deepEqual(client.issueWithAdmission("evt_issue_001", TIMESTAMP, ATTRIBUTES), { status: "unavailable" });
  assert.equal(calls.length, ONCE);
  assert.equal(client.pendingEvents(), NO_EVENTS);
});

await test("forwarding issue overrides are preserved without guessing their admission", () => {
  const client = createClient();
  client.issue = forwardIssue;
  assert.deepEqual(client.issueWithAdmission("evt_issue_001", TIMESTAMP, ATTRIBUTES), { status: "unavailable" });
  assert.equal(client.pendingEvents(), ONE_EVENT);
  const failure = new Error("Custom issue failed");
  client.issue = () => {
    throw failure;
  };
  assert.throws(() => client.issueWithAdmission("evt_issue_002", TIMESTAMP, ATTRIBUTES), (reason) => reason === failure);
});

await test("prototype issue overrides retain their custom dispatch", () => {
  const original = Object.getOwnPropertyDescriptor(LogBrewClient.prototype, "issue");
  assert.ok(original);
  let calls = 0;
  try {
    LogBrewClient.prototype.issue = () => {
      calls += INCREMENT;
    };
    const client = createClient();
    assert.deepEqual(client.issueWithAdmission("evt_issue_001", TIMESTAMP, ATTRIBUTES), { status: "unavailable" });
    assert.equal(calls, ONCE);
    assert.equal(client.pendingEvents(), NO_EVENTS);
  } finally {
    Object.defineProperty(LogBrewClient.prototype, "issue", original);
  }
});

await test("custom issue accessors are read once before capture", () => {
  const client = createClient();
  let reads = 0;
  let calls = 0;
  Object.defineProperty(client, "issue", {
    get() {
      reads += INCREMENT;
      assert.equal(reads, ONCE);
      return () => {
        calls += INCREMENT;
      };
    }
  });
  assert.deepEqual(client.issueWithAdmission("evt_issue_001", TIMESTAMP, ATTRIBUTES), { status: "unavailable" });
  assert.equal(reads, ONCE);
  assert.equal(calls, ONCE);
});

await test("ESM, CommonJS and mobile entry points expose the same admission method", () => {
  /** @type {unknown} */
  const commonJsEntry = requireFromTest("@logbrew/sdk");
  assert.equal(field(commonJsEntry, "LogBrewClient"), LogBrewClient);
  assert.equal(MobileClient, LogBrewClient);
  const client = MobileClient.create({ ...CLIENT_IDENTITY });
  assert.deepEqual(client.issueWithAdmission("evt_issue_001", TIMESTAMP, ATTRIBUTES), { status: "admitted" });
});
