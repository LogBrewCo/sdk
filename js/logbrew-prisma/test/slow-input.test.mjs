import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import { createLogBrewNodeClient } from "@logbrew/node";
import { prismaOperationWithLogBrewSpan } from "@logbrew/prisma";
import test from "node:test";

/**
 * @typedef {{ readonly elapsed: number, readonly json: string }} Operation
 */

const LONG_INPUT_LENGTH = 50_000;
const TIME_BUDGET_MS = 100;

/**
 * @param {string} model
 * @returns {Promise<Operation>}
 */
async function runOperation(model) {
  const client = createLogBrewNodeClient({ apiKey: "TEST_API_KEY", automaticDelivery: false, captureRuntimeContext: false, transport: RecordingTransport.alwaysAccept() });
  const started = performance.now();
  await prismaOperationWithLogBrewSpan({ args: {}, model, operation: "findMany", query: async () => [] }, { client });
  return { elapsed: performance.now() - started, json: client.previewJson() };
}

await test("Prisma model labels stay fast on long underscore runs", async () => {
  const { elapsed } = await runOperation(`a${"_".repeat(LONG_INPUT_LENGTH)}b`);
  assert.ok(elapsed < TIME_BUDGET_MS, `model label took ${elapsed} ms`);
});

await test("Prisma model labels keep inner underscores and drop edge underscores", async () => {
  const { json } = await runOperation("__Order Line__Item__");
  assert.match(json, /"prisma findmany Order_Line__Item"/u);
});
