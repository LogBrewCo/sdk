import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { createServer, get as httpGet } from "node:http";
import test from "node:test";

import { RecordingTransport, createIssueAttributesFromError } from "@logbrew/sdk";
import {
  addLogBrewBreadcrumb,
  createLogBrewNodeClient,
  createLogBrewTraceContext,
  runWithLogBrewTrace
} from "../index.js";

const TIMESTAMP = "2026-06-02T10:00:00Z";
const pinoEndChannel = channel("tracing:pino_asJson:end");

async function startServer(t) {
  const server = createServer((req, res) => {
    res.writeHead(req.url.startsWith("/missing") ? 404 : 200);
    res.end("ok");
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function newClient(options = {}) {
  return createLogBrewNodeClient({
    apiKey: "TEST_API_KEY",
    automaticDelivery: false,
    transport: RecordingTransport.alwaysAccept(),
    ...options
  });
}

function captureIssue(client, id) {
  client.issue(id, TIMESTAMP, createIssueAttributesFromError(new Error("checkout failed")));
  return JSON.parse(client.previewJson()).events.find((event) => event.id === id).attributes;
}

function newTrace() {
  return createLogBrewTraceContext({});
}

test("console, HTTP, and Pino records inside a request become that request's issue breadcrumbs", async (t) => {
  const origin = await startServer(t);
  const client = newClient();
  const issue = await runWithLogBrewTrace(newTrace(), async () => {
    console.info("checkout started for cart %s", "cart-7");
    await fetch(`${origin}/inventory?token=hidden#frag`);
    await new Promise((resolve) => {
      httpGet(`${origin}/missing/price?session=hidden`, (res) => { res.resume(); res.on("end", resolve); });
    });
    pinoEndChannel.publish({ arguments: [{}, "", 40, Date.now()], result: '{"level":40,"msg":"stock low"}\n' });
    return captureIssue(client, "evt_issue_request");
  });

  const crumbs = issue.breadcrumbs.map(({ category, level, message, data }) => ({ category, level, message, data }));
  // Bun has no Node HTTP diagnostics channels, so only Node.js records HTTP client breadcrumbs.
  const http = process.versions.bun ? [] : [
    { category: "http.client", level: "info", message: undefined, data: { method: "GET", url: `${origin}/inventory`, status_code: 200 } },
    { category: "http.client", level: "warning", message: undefined, data: { method: "GET", url: `${origin}/missing/price`, status_code: 404 } }
  ];
  assert.deepEqual(crumbs, [
    { category: "console", level: "info", message: "checkout started for cart cart-7", data: undefined },
    ...http,
    { category: "log.pino", level: "warning", message: "stock low", data: undefined }
  ]);
  assert.equal(JSON.stringify(issue).includes("hidden"), false);
});

test("breadcrumbs from one request never reach another request's issue", async () => {
  const client = newClient();
  const first = newTrace();
  const second = newTrace();
  runWithLogBrewTrace(first, () => { addLogBrewBreadcrumb({ category: "checkout", message: "first request step" }); });
  const issue = runWithLogBrewTrace(second, () => {
    addLogBrewBreadcrumb({ category: "checkout", message: "second request step" });
    return captureIssue(client, "evt_issue_isolated");
  });

  assert.deepEqual(issue.breadcrumbs.map(({ message }) => message), ["second request step"]);
});

test("breadcrumbs outside a request reach issues captured outside a request", () => {
  const client = newClient();
  addLogBrewBreadcrumb({ category: "worker", message: "job 41 started" });
  const issue = captureIssue(client, "evt_issue_process");

  assert.ok(issue.breadcrumbs.some(({ message }) => message === "job 41 started"));
});

test("LogBrew's own delivery requests are not breadcrumbs", async (t) => {
  const origin = await startServer(t);
  const client = createLogBrewNodeClient({ apiKey: "TEST_API_KEY", endpoint: `${origin}/v1/events`, maxRetries: 0 });
  const issue = await runWithLogBrewTrace(newTrace(), async () => {
    client.log("evt_log_delivery", TIMESTAMP, { message: "queued", level: "info" });
    await client.flush();
    return captureIssue(client, "evt_issue_delivery");
  });

  assert.equal(issue.breadcrumbs, undefined);
  await client.shutdown();
});

test("the breadcrumbs option must be a boolean", () => {
  assert.throws(() => newClient({ breadcrumbs: "yes" }), /breadcrumbs must be a boolean/u);
});
