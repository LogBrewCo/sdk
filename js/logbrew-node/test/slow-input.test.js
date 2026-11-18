import assert from "node:assert/strict";
import test from "node:test";

import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewNodeClient,
  databaseOperationWithLogBrewSpan,
  instrumentLogBrewPgClient,
  instrumentLogBrewRedisClient
} from "../index.js";

const SLOW_LABEL = `a${"_".repeat(50_000)}b`;
const TIME_BUDGET_MS = 100;

function newClient() {
  return createLogBrewNodeClient({ apiKey: "TEST_API_KEY", transport: RecordingTransport.alwaysAccept(), automaticDelivery: false, captureRuntimeContext: false });
}

async function assertFast(name, work) {
  const started = performance.now();
  await work();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < TIME_BUDGET_MS, `${name} took ${elapsed} ms`);
}

test("operation span labels stay fast on long underscore runs", async () => {
  const client = newClient();
  await assertFast("operation span", () => databaseOperationWithLogBrewSpan("Order", {
    client,
    operationKind: SLOW_LABEL,
    system: SLOW_LABEL,
    operation: async () => 1
  }));
});

test("pg query labels stay fast on long underscore runs", async () => {
  const pgClient = { query: async () => ({ rows: [] }) };
  instrumentLogBrewPgClient(pgClient, { client: newClient(), operationKind: SLOW_LABEL });
  await assertFast("pg query", () => pgClient.query("SELECT 1"));
});

test("redis command labels stay fast on long underscore runs", async () => {
  const redisClient = { sendCommand: async () => "OK" };
  instrumentLogBrewRedisClient(redisClient, { client: newClient(), operationName: SLOW_LABEL });
  await assertFast("redis command", () => redisClient.sendCommand([SLOW_LABEL]));
});

test("labels keep inner underscores and drop edge underscores", async () => {
  const client = newClient();
  await databaseOperationWithLogBrewSpan("Order", { client, operationKind: "__Bulk__Insert__", system: "__my db__", operation: async () => 1 });
  const span = JSON.parse(client.previewJson()).events.find((event) => event.type === "span");
  assert.match(JSON.stringify(span), /"my_db"/u);
  assert.match(JSON.stringify(span), /"bulk__insert"/u);
});
