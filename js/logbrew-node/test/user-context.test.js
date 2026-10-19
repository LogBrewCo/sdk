import assert from "node:assert/strict";
import test from "node:test";

import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewNodeClient,
  createLogBrewTraceContext,
  runWithLogBrewTrace,
  setLogBrewUser
} from "../index.js";

const TIMESTAMP = "2026-06-02T10:00:00Z";

function logContext(client) {
  client.log("evt_log", TIMESTAMP, { message: "checkout", level: "info" });
  return JSON.parse(client.previewJson()).events.at(-1).attributes.context;
}

function newClient() {
  return createLogBrewNodeClient({ apiKey: "TEST_API_KEY", transport: RecordingTransport.alwaysAccept(), automaticDelivery: false, captureRuntimeContext: false });
}

test("a user set in one request reaches that request's events only", async () => {
  const client = newClient();
  const first = await runWithLogBrewTrace(createLogBrewTraceContext({}), async () => {
    assert.equal(setLogBrewUser("user-42"), true);
    await Promise.resolve();
    return logContext(client);
  });
  const second = runWithLogBrewTrace(createLogBrewTraceContext({}), () => logContext(client));

  assert.deepEqual(first.subject, { id: "user-42", kind: "user" });
  assert.equal(second.subject, undefined);
  assert.equal(setLogBrewUser("user-42"), false, "outside a request the call does nothing");
  assert.equal(logContext(client), undefined);
});

test("anonymous users are supported and invalid ids or kinds are rejected", () => {
  const client = newClient();
  const context = runWithLogBrewTrace(createLogBrewTraceContext({}), () => {
    setLogBrewUser("visitor-7", { kind: "anonymous" });
    return logContext(client);
  });
  assert.deepEqual(context.subject, { id: "visitor-7", kind: "anonymous" });
  for (const [id, options] of [["", {}], ["x".repeat(201), {}], ["user\n1", {}], ["user-1", { kind: "admin" }]]) {
    assert.throws(() => setLogBrewUser(id, options), /LogBrew user/u);
  }
});
