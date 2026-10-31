import { items, pick } from "./issue-helpers.js";
import assert from "node:assert/strict";
import { createIssueAttributesFromError } from "@logbrew/sdk";
import test from "node:test";

const PARENT_FIRST_CAUSE_COUNT = 4;
const CAUSE_SUMMARY_LIMIT = 5;
const EXCEPTION_CHAIN_LIMIT = 8;
const REDACTED_ENTRY = { message: undefined, messageState: "redacted", stackFramesState: "captured" };
const EXPECTED_PARENT_FIRST_ENTRIES = [
  { ...REDACTED_ENTRY, file: "checkout.js", id: 0, parentId: undefined, relationship: "reported", type: "AggregateError" },
  { ...REDACTED_ENTRY, file: "wrapped.js", id: 1, parentId: 0, relationship: "cause", type: "URIError" },
  { ...REDACTED_ENTRY, file: "mid.js", id: 2, parentId: 0, relationship: "aggregate_member", type: "RangeError" },
  { ...REDACTED_ENTRY, file: "low.js", id: 3, parentId: 2, relationship: "cause", type: "TypeError" },
  { ...REDACTED_ENTRY, file: "side.js", id: 4, parentId: 0, relationship: "aggregate_member", type: "SyntaxError" }
];

const SINGLE_CAUSE = 1;

/**
 * @param {string} name
 * @returns {new (message: string) => Error}
 */
function causeClass(name) {
  const CauseType = class extends Error {};
  Object.defineProperty(CauseType, "name", { value: name });
  return CauseType;
}

/**
 * @returns {RangeError}
 */
function middleCauseError() {
  const low = new TypeError("low wrapped detail for dynamic-user-marker");
  low.stack = "TypeError: low wrapped detail\n    at low (/tmp/local/low.js:1:2)";
  const mid = new RangeError("middle checkout numeric-marker-12345");
  mid.cause = low;
  mid.stack = "RangeError: middle checkout numeric-marker-12345\n    at mid (/tmp/local/mid.js:3:4)";
  return mid;
}

/**
 * @returns {AggregateError}
 */
function aggregateCheckoutError() {
  const mid = middleCauseError();
  const side = new SyntaxError("side opaque-marker-abc123");
  side.stack = "SyntaxError: side opaque-marker-abc123\n    at side (/tmp/local/side.js:5:6)";
  const wrapped = new URIError("wrapped callback dynamic-user-marker");
  wrapped.stack = "URIError: wrapped callback dynamic-user-marker\n    at wrapped (/tmp/local/wrapped.js:7:8)";
  const error = new AggregateError([mid, side], "top checkout failed", { cause: wrapped });
  error.stack = "AggregateError: top checkout failed\n    at checkout (/tmp/local/checkout.js:9:10)";
  return error;
}

/**
 * @param {unknown} entry
 * @returns {Readonly<Record<string, unknown>>}
 */
function entrySummary(entry) {
  return {
    file: pick(entry, "stackFrames.0.filename"),
    id: pick(entry, "id"),
    message: pick(entry, "message"),
    messageState: pick(entry, "messageState"),
    parentId: pick(entry, "parentId"),
    relationship: pick(entry, "relationship"),
    stackFramesState: pick(entry, "stackFramesState"),
    type: pick(entry, "type")
  };
}

/**
 * @returns {Error}
 */
function deepCauseChain() {
  const causeTypes = ["Cause0", "Cause1", "Cause2", "Cause3", "Cause4", "Cause5", "Cause6", "Cause7"].map((name) => causeClass(name));
  const error = new Error("root");
  let cursor = error;
  for (const [index, CauseType] of causeTypes.entries()) {
    const next = new CauseType(`cause ${index}`);
    cursor.cause = next;
    cursor = next;
  }
  return error;
}

await test("createIssueAttributesFromError preserves bounded parent-first cause evidence", () => {
  const attributes = createIssueAttributesFromError(aggregateCheckoutError());

  assert.equal(pick(attributes, "metadata.errorCauseCount"), PARENT_FIRST_CAUSE_COUNT);
  assert.equal(pick(attributes, "metadata.errorCauseTypes"), "URIError,RangeError,TypeError,SyntaxError");
  assert.equal(pick(attributes, "metadata.errorCauseSources"), "cause,errors[0],cause,errors[1]");
  assert.equal(pick(attributes, "metadata.errorExceptionGroup"), true);
  assert.equal(pick(attributes, "metadata.errorCauseTruncated"), undefined);
  assert.equal(pick(attributes, "exceptionChain.truncated"), false);
  assert.deepEqual(items(pick(attributes, "exceptionChain.entries")).map((entry) => entrySummary(entry)), EXPECTED_PARENT_FIRST_ENTRIES);

  const serializedCauseMetadata = JSON.stringify({
    errorCauseCount: pick(attributes, "metadata.errorCauseCount"),
    errorCauseSources: pick(attributes, "metadata.errorCauseSources"),
    errorCauseTypes: pick(attributes, "metadata.errorCauseTypes"),
    errorExceptionGroup: pick(attributes, "metadata.errorExceptionGroup")
  });
  assert.doesNotMatch(serializedCauseMetadata, /wrapped detail|dynamic-user-marker|12345|abc123|local|stack/u);
});

await test("createIssueAttributesFromError caps cause chain summaries", () => {
  const attributes = createIssueAttributesFromError(deepCauseChain());

  assert.equal(pick(attributes, "metadata.errorCauseCount"), CAUSE_SUMMARY_LIMIT);
  assert.equal(pick(attributes, "metadata.errorCauseTypes"), "Cause0,Cause1,Cause2,Cause3,Cause4");
  assert.equal(pick(attributes, "metadata.errorCauseSources"), "cause,cause,cause,cause,cause");
  assert.equal(pick(attributes, "metadata.errorCauseTruncated"), true);
  assert.equal(pick(attributes, "exceptionChain.entries.length"), EXCEPTION_CHAIN_LIMIT);
  assert.equal(pick(attributes, "exceptionChain.truncated"), true);
  assert.deepEqual(
    items(pick(attributes, "exceptionChain.entries")).map((entry) => pick(entry, "type")),
    ["Error", "Cause0", "Cause1", "Cause2", "Cause3", "Cause4", "Cause5", "Cause6"]
  );
});

await test("createIssueAttributesFromError avoids arbitrary non-error cause names", () => {
  const error = new Error("root");
  error.cause = {
    message: "nested detail should not copy",
    name: "dynamicUserMarker123"
  };

  const attributes = createIssueAttributesFromError(error);

  assert.equal(pick(attributes, "metadata.errorCauseCount"), SINGLE_CAUSE);
  assert.equal(pick(attributes, "metadata.errorCauseTypes"), "Object");
  assert.equal(pick(attributes, "metadata.errorCauseSources"), "cause");
  assert.doesNotMatch(JSON.stringify(attributes.metadata), /dynamicUserMarker123|nested detail/u);
});
