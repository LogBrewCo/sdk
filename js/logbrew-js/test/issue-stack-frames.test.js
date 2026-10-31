import {
  OVERSIZED_TEXT_LENGTH,
  STACK_FRAME_LIMIT,
  TEXT_LIMIT,
  firstAttributes,
  isValidationError,
  pick,
  sampleClient,
  text,
  uncheckedIssue
} from "./issue-helpers.js";
import assert from "node:assert/strict";
import { createIssueAttributesFromError } from "@logbrew/sdk";
import test from "node:test";

const LONG_STACK_DEPTH = 40;
const LAST_KEPT_FRAME = 31;
const LINE_OFFSET = 1;
const IDENTITY_FRAME = {
  column: 34,
  filename: "/assets/app.js",
  function: "Checkout.submit",
  inApp: true,
  line: 12,
  module: "@example/checkout"
};
const INVALID_IDENTITY_FIELDS = [
  { function: "x".repeat(OVERSIZED_TEXT_LENGTH) },
  { function: "🧪".repeat(OVERSIZED_TEXT_LENGTH) },
  { module: "@example/checkout?private=value" },
  { inApp: "yes" }
];

/**
 * @returns {Error}
 */
function longStackError() {
  const error = new Error("Bounded stack");
  error.stack = [
    "Error: Bounded stack",
    "    at async /private/tmp/example/node_modules/framework/handle.js:140:21",
    ...Array.from(
      { length: LONG_STACK_DEPTH },
      (_slot, index) => `    at frame${index} (C:\\workspace\\app\\src\\frame-${index}.js?debug=value#fragment:${index + LINE_OFFSET}:2)`
    )
  ].join("\n");
  return error;
}

await test("createIssueAttributesFromError bounds and sanitizes structured stack frames", () => {
  const attributes = createIssueAttributesFromError(longStackError());

  assert.equal(pick(attributes, "stackFrames.length"), STACK_FRAME_LIMIT);
  assert.deepEqual(pick(attributes, "stackFrames.0"), {
    column: 21,
    filename: "handle.js",
    line: 140
  });
  assert.deepEqual(pick(attributes, `stackFrames.${LAST_KEPT_FRAME}`), {
    column: 2,
    filename: "frame-30.js",
    function: "frame30",
    line: 31
  });
  assert.equal(pick(attributes, "exceptionChain.entries.0.stackFrames.length"), STACK_FRAME_LIMIT);
  assert.equal(pick(attributes, "exceptionChain.entries.0.stackFramesState"), "truncated");
  assert.deepEqual(pick(attributes, "exceptionChain.entries.0.stackFrames"), attributes.stackFrames);
  assert.equal(pick(attributes, "metadata.errorFrameFile"), "handle.js");
  assert.doesNotMatch(JSON.stringify(attributes), /C:\\workspace|\/private\/tmp|debug=value|fragment|frame-31/u);
});

await test("createIssueAttributesFromError keeps legacy source labels separate from mechanism identity", () => {
  const error = new Error("Checkout failed");
  error.name = "Checkout?error";
  const attributes = createIssueAttributesFromError(error, {
    source: "application error boundary"
  });

  assert.equal(pick(attributes, "metadata.source"), "application error boundary");
  assert.equal(pick(attributes, "metadata.errorName"), "Checkout?error");
  assert.equal(pick(attributes, "exception.type"), "Error");
  assert.deepEqual(pick(attributes, "exception.mechanism"), {
    handled: true,
    type: "javascript.error"
  });
});

await test("issue stack frames reject non-string filenames", () => {
  const client = sampleClient();

  assert.throws(
    () => {
      uncheckedIssue(client, ["evt_invalid_stack", "2026-07-17T12:00:00Z", {
        level: "error",
        stackFrames: [{ column: 2, filename: { local: true }, line: 1 }],
        title: "Invalid stack"
      }]);
    },
    isValidationError
  );
});

await test("issue stack frames preserve bounded code identity", () => {
  const client = sampleClient();
  client.issue("evt_identity_stack", "2026-07-17T12:00:00Z", {
    level: "error",
    stackFrames: [{ ...IDENTITY_FRAME }],
    title: "Identity stack"
  });

  assert.deepEqual(pick(firstAttributes(client), "stackFrames"), [IDENTITY_FRAME]);

  const unicodeClient = sampleClient();
  unicodeClient.issue("evt_unicode_identity", "2026-07-17T12:00:00Z", {
    level: "error",
    stackFrames: [{
      column: 34,
      filename: "/assets/app.js",
      function: "🧪".repeat(TEXT_LIMIT),
      line: 12
    }],
    title: "Unicode identity"
  });
  const unicodeFunction = text(pick(firstAttributes(unicodeClient), "stackFrames.0.function"));
  assert.equal([...unicodeFunction].length, TEXT_LIMIT);
});

await test("issue stack frames reject invalid code identity", () => {
  for (const invalid of INVALID_IDENTITY_FIELDS) {
    const client = sampleClient();
    assert.throws(
      () => {
        uncheckedIssue(client, ["evt_invalid_identity", "2026-07-17T12:00:00Z", {
          level: "error",
          stackFrames: [{ column: 2, filename: "/assets/app.js", line: 1, ...invalid }],
          title: "Invalid identity"
        }]);
      },
      isValidationError
    );
  }
});

await test("generated stack frames omit PII-like function labels", () => {
  const error = new Error("Safe function identity");
  error.stack = [
    "Error: Safe function identity",
    "checkout@https://cdn.example/assets/app.js:12:34",
    "hidden@example.test@https://cdn.example/assets/vendor.js:56:78"
  ].join("\n");

  const attributes = createIssueAttributesFromError(error);
  assert.deepEqual(attributes.stackFrames, [
    {
      column: 34,
      filename: "https://cdn.example/assets/app.js",
      function: "checkout",
      line: 12
    },
    {
      column: 78,
      filename: "https://cdn.example/assets/vendor.js",
      line: 56
    }
  ]);
  assert.doesNotMatch(JSON.stringify(attributes), /hidden@example\.test/u);
});
