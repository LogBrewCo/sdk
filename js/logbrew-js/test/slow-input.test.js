import { member, sampleClient } from "./tracing-helpers.js";
import assert from "node:assert/strict";
import { logAttributesFromWinstonInfo } from "@logbrew/sdk";
import test from "node:test";

const LONG_INPUT_LENGTH = 50_000;
const TIME_BUDGET_MS = 100;

/**
 * @param {() => void} work
 * @returns {number}
 */
function elapsedMs(work) {
  const started = performance.now();
  work();
  return performance.now() - started;
}

await test("timestamp validation stays fast on a long time portion without an offset", () => {
  const client = sampleClient();
  const timestamp = `2026-06-02T${"1".repeat(LONG_INPUT_LENGTH)}`;
  const elapsed = elapsedMs(() => {
    assert.throws(() => {
      client.log("evt_slow_timestamp", timestamp, { level: "info", message: "ready" });
    }, /timezone offset/u);
  });
  assert.ok(elapsed < TIME_BUDGET_MS, `timestamp validation took ${elapsed} ms`);
});

await test("Winston stack parsing stays fast on a long headline", () => {
  const stack = `TypeError:${" ".repeat(LONG_INPUT_LENGTH)} failed `;
  const elapsed = elapsedMs(() => {
    logAttributesFromWinstonInfo({ level: "error", message: "checkout failed", stack });
  });
  assert.ok(elapsed < TIME_BUDGET_MS, `stack parsing took ${elapsed} ms`);
});

await test("Winston stack parsing keeps the headline name and message", () => {
  const attributes = logAttributesFromWinstonInfo({ level: "error", message: "checkout failed", stack: "TypeError:   payment failed\n    at checkout.js:1:1" });
  assert.equal(member(attributes.metadata, "errorName"), "TypeError");
  assert.equal(member(attributes.metadata, "errorMessage"), "payment failed");
});
