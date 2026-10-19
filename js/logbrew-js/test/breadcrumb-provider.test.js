import test from "node:test";
import assert from "node:assert/strict";

import { LogBrewClient } from "../index.js";

const PROVIDER = Symbol.for("@logbrew/sdk.breadcrumbProvider");
const issue = { title: "Checkout failed", level: "error" };

function createClient(provider) {
  return LogBrewClient.create({ apiKey: "LOGBREW_API_KEY", sdkName: "logbrew-js", sdkVersion: "0.1.0", [PROVIDER]: provider });
}

const attributes = (client) => JSON.parse(client.previewJson()).events.at(-1).attributes;

test("scoped breadcrumbs merge with client breadcrumbs in time order", () => {
  const client = createClient(() => ({
    breadcrumbs: [{ timestamp: "2026-06-02T10:00:02Z", category: "http.client", data: { method: "GET" } }],
    truncated: false
  }));
  client.addBreadcrumb({ category: "app.start" }, "2026-06-02T10:00:01Z");
  client.addBreadcrumb({ category: "app.ready" }, "2026-06-02T10:00:03Z");

  client.issue("evt_issue_001", "2026-06-02T10:00:04Z", issue);

  assert.deepEqual(attributes(client).breadcrumbs.map(({ category }) => category), ["app.start", "http.client", "app.ready"]);
  assert.equal(attributes(client).breadcrumbsTruncated, undefined);
});

test("invalid scoped breadcrumbs are dropped and marked, and a failing provider never loses the issue", () => {
  const client = createClient(() => ({ breadcrumbs: [{ category: "bad category!" }, { timestamp: "2026-06-02T10:00:02Z", category: "ok" }] }));
  client.issue("evt_issue_002", "2026-06-02T10:00:04Z", issue);
  assert.deepEqual(attributes(client).breadcrumbs.map(({ category }) => category), ["ok"]);
  assert.equal(attributes(client).breadcrumbsTruncated, true);

  const throwing = createClient(() => { throw new Error("provider failed"); });
  throwing.issue("evt_issue_003", "2026-06-02T10:00:04Z", issue);
  assert.equal(attributes(throwing).breadcrumbs, undefined);
});

test("explicit issue breadcrumbs replace scoped ones and the merge keeps the newest 64", () => {
  const many = Array.from({ length: 70 }, (_, index) => ({ timestamp: `2026-06-02T10:01:${String(index % 60).padStart(2, "0")}Z`, category: `step${index}` }));
  const client = createClient(() => ({ breadcrumbs: many }));
  client.issue("evt_issue_004", "2026-06-02T10:02:00Z", { ...issue, breadcrumbs: [{ timestamp: "2026-06-02T10:00:00Z", category: "explicit" }] });
  assert.deepEqual(attributes(client).breadcrumbs.map(({ category }) => category), ["explicit"]);

  client.issue("evt_issue_005", "2026-06-02T10:02:00Z", issue);
  assert.equal(attributes(client).breadcrumbs.length, 64);
  assert.equal(attributes(client).breadcrumbsTruncated, true);
});

test("a non-function breadcrumb provider is rejected", () => {
  assert.throws(() => createClient("provider"), /breadcrumb provider must be a function/u);
});
