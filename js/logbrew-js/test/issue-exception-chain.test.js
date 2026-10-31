import { firstAttributes, isValidationError, pick, sampleClient, setAt } from "./issue-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { IssueAttributes } from "@logbrew/sdk"
 */

const ROOT_FRAME = {
  column: 34,
  filename: "checkout.js",
  function: "submit",
  inApp: true,
  line: 12
};
const CHANGED_LINE = 99;
const SELF_PARENT_ID = 1;
/** @type {readonly (readonly [string, unknown])[]} */
const INVALID_CHAIN_PATCHES = [
  ["exceptionChain.entries.1.message", "must not accompany redaction"],
  ["exceptionChain.entries.1.parentId", SELF_PARENT_ID],
  ["exceptionChain.entries.0.type", "DifferentError"],
  ["exceptionChain.entries.0.stackFrames.0", { ...ROOT_FRAME, line: CHANGED_LINE }]
];

/**
 * @returns {IssueAttributes}
 */
function manualChainAttributes() {
  const rootFrame = { ...ROOT_FRAME };
  return {
    exception: {
      mechanism: { handled: true, type: "javascript.boundary" },
      type: "CheckoutError"
    },
    exceptionChain: {
      entries: [
        {
          id: 0,
          mechanism: { handled: true, type: "javascript.boundary" },
          message: "Checkout failed",
          messageState: "captured",
          relationship: "reported",
          stackFrames: [rootFrame],
          stackFramesState: "captured",
          type: "CheckoutError"
        },
        {
          id: 1,
          mechanism: { handled: true, type: "javascript.cause" },
          messageState: "redacted",
          parentId: 0,
          relationship: "cause",
          stackFramesState: "not_captured",
          type: "ProviderError"
        }
      ],
      truncated: false
    },
    level: "error",
    stackFrames: [rootFrame],
    title: "CheckoutError"
  };
}

/**
 * @returns {void}
 */
function assertRejectsContradictions() {
  for (const [keyPath, replacement] of INVALID_CHAIN_PATCHES) {
    const invalid = manualChainAttributes();
    setAt(invalid, keyPath, replacement);
    assert.throws(
      () => {
        sampleClient().issue("evt_invalid_chain", "2026-07-17T12:00:00Z", invalid);
      },
      isValidationError
    );
  }
}

await test("manual exception chains preserve redaction state and reject contradictions", () => {
  const attributes = manualChainAttributes();
  const client = sampleClient();
  client.issue("evt_manual_chain", "2026-07-17T12:00:00Z", attributes);
  const queued = firstAttributes(client);

  assert.equal(pick(queued, "exceptionChain.entries.1.message"), undefined);
  assert.equal(pick(queued, "exceptionChain.entries.1.messageState"), "redacted");
  assert.equal(pick(queued, "exceptionChain.entries.1.stackFramesState"), "not_captured");

  assertRejectsContradictions();
});
