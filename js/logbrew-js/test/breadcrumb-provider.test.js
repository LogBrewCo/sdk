import { CLIENT_IDENTITY, fieldOfEach, lastEventAttributes } from "./capture-helpers.js";
import { LogBrewClient } from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { IssueAttributes } from "@logbrew/sdk"
 */

const PROVIDER = Symbol.for("@logbrew/sdk.breadcrumbProvider");
const PROVIDED_BREADCRUMBS = 70;
const MAX_BREADCRUMBS = 64;
const SECONDS_PER_MINUTE = 60;
const SECOND_DIGITS = 2;
/** @type {IssueAttributes} */
const issue = { level: "error", title: "Checkout failed" };

/**
 * @param {unknown} provider
 * @returns {LogBrewClient}
 */
function createClient(provider) {
  const config = { ...CLIENT_IDENTITY, [PROVIDER]: provider };
  return LogBrewClient.create(config);
}

/**
 * @param {LogBrewClient} client
 * @returns {readonly unknown[]}
 */
function breadcrumbCategories(client) {
  return fieldOfEach(lastEventAttributes(client)["breadcrumbs"], "category");
}

/**
 * @param {number} index
 * @returns {{ readonly category: string, readonly timestamp: string }}
 */
function providedBreadcrumb(index) {
  return { category: `step${index}`, timestamp: `2026-06-02T10:01:${String(index % SECONDS_PER_MINUTE).padStart(SECOND_DIGITS, "0")}Z` };
}

await test("scoped breadcrumbs merge with client breadcrumbs in time order", () => {
  const client = createClient(() => ({
    breadcrumbs: [{ category: "http.client", data: { method: "GET" }, timestamp: "2026-06-02T10:00:02Z" }],
    truncated: false
  }));
  client.addBreadcrumb({ category: "app.start" }, "2026-06-02T10:00:01Z");
  client.addBreadcrumb({ category: "app.ready" }, "2026-06-02T10:00:03Z");

  client.issue("evt_issue_001", "2026-06-02T10:00:04Z", issue);

  assert.deepEqual(breadcrumbCategories(client), ["app.start", "http.client", "app.ready"]);
  assert.equal(lastEventAttributes(client)["breadcrumbsTruncated"], undefined);
});

await test("invalid scoped breadcrumbs are dropped and marked, and a failing provider never loses the issue", () => {
  const client = createClient(() => ({ breadcrumbs: [{ category: "bad category!" }, { category: "ok", timestamp: "2026-06-02T10:00:02Z" }] }));
  client.issue("evt_issue_002", "2026-06-02T10:00:04Z", issue);
  assert.deepEqual(breadcrumbCategories(client), ["ok"]);
  assert.equal(lastEventAttributes(client)["breadcrumbsTruncated"], true);

  const throwing = createClient(() => {
    throw new Error("provider failed");
  });
  throwing.issue("evt_issue_003", "2026-06-02T10:00:04Z", issue);
  assert.equal(lastEventAttributes(throwing)["breadcrumbs"], undefined);
});

await test("explicit issue breadcrumbs replace scoped ones and the merge keeps the newest 64", () => {
  const many = Array.from({ length: PROVIDED_BREADCRUMBS }, (_entry, index) => providedBreadcrumb(index));
  const client = createClient(() => ({ breadcrumbs: many }));
  client.issue("evt_issue_004", "2026-06-02T10:02:00Z", { ...issue, breadcrumbs: [{ category: "explicit", timestamp: "2026-06-02T10:00:00Z" }] });
  assert.deepEqual(breadcrumbCategories(client), ["explicit"]);

  client.issue("evt_issue_005", "2026-06-02T10:02:00Z", issue);
  assert.equal(breadcrumbCategories(client).length, MAX_BREADCRUMBS);
  assert.equal(lastEventAttributes(client)["breadcrumbsTruncated"], true);
});

await test("a non-function breadcrumb provider is rejected", () => {
  assert.throws(() => createClient("provider"), /breadcrumb provider must be a function/u);
});
