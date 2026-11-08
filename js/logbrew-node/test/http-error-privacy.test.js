import assert from "node:assert/strict";
import test from "node:test";
import { createHttpErrorEvent } from "@logbrew/node";

const MESSAGE_LIMIT = 1024;
const LONG_TEXT = 2000;

test("error issues keep the message out of the event ID and metadata and bound its length", () => {
  const detail = "x".repeat(LONG_TEXT);
  const event = createHttpErrorEvent(new Error(`card declined for dev@example.test\n${detail}`), { method: "POST", url: "/checkout" });

  assert.equal(event.id.includes("dev"), false);
  assert.equal(event.id.includes("declined"), false);
  assert.equal(JSON.stringify(event.attributes.metadata).includes("dev@example.test"), false);
  assert.equal(event.attributes.message, `card declined for dev@example.test ${detail}`.slice(0, MESSAGE_LIMIT));
  assert.equal(event.attributes.title, "POST /checkout failed");
});
