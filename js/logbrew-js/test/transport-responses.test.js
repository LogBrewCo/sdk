import { EXPECTED_EVENT_COUNT, captureRejection, enqueueAll, field, sampleClient } from "./batch-helpers.js";
import { RecordingTransport, SdkError, TransportError } from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

const UNAUTHORIZED = 401;
const TOO_MANY_REQUESTS = 429;
const ACCEPTED = 202;
const RETRY_AFTER_MS = 120_000;
const NEGATIVE_DELAY_MS = -1;
const SINGLE_SEND = 1;
const TWO_ATTEMPTS = 2;

/**
 * @param {unknown} error
 * @returns {void}
 */
function assertRateLimitError(error) {
  assert.equal(error instanceof SdkError, true);
  assert.equal(field(error, "code"), "rate_limited");
  assert.equal(field(error, "retryAfterMs"), RETRY_AFTER_MS);
  assert.equal(field(error, "retryable"), true);
  assert.equal(field(error, "message"), "transport rate limited the batch");
}

await test("unauthenticated response surfaces clean error", async () => {
  const client = sampleClient();
  enqueueAll(client);
  const transport = new RecordingTransport([{ statusCode: UNAUTHORIZED }]);

  await assert.rejects(client.flush(transport), /transport rejected the API key/u);
  assert.equal(client.pendingEvents(), EXPECTED_EVENT_COUNT);
});

await test("rate-limited response surfaces retry-after without retrying", async () => {
  const client = sampleClient();
  enqueueAll(client);
  const transport = new RecordingTransport([{ retryAfterMs: RETRY_AFTER_MS, statusCode: TOO_MANY_REQUESTS }]);

  const error = await captureRejection(async () => client.flush(transport));

  assertRateLimitError(error);
  assert.equal(client.pendingEvents(), EXPECTED_EVENT_COUNT);
  assert.equal(transport.sentBodies.length, SINGLE_SEND);
});

await test("network failure retries before succeeding", async () => {
  const client = sampleClient();
  enqueueAll(client);
  const transport = new RecordingTransport([
    TransportError.network("temporary outage"),
    { statusCode: ACCEPTED }
  ]);

  const response = await client.flush(transport);

  assert.equal(response.attempts, TWO_ATTEMPTS);
  assert.equal(transport.sentBodies.length, TWO_ATTEMPTS);
});

await test("SDK error ignores unsafe optional retry-after details", () => {
  /** @type {unknown} */
  const nullDetails = Reflect.construct(SdkError, ["transport_error", "transport failed", null]);
  const negativeDelay = new SdkError("rate_limited", "transport rate limited the batch", { retryAfterMs: NEGATIVE_DELAY_MS });

  assert.equal(field(nullDetails, "retryAfterMs"), undefined);
  assert.equal(negativeDelay.retryAfterMs, undefined);
});
