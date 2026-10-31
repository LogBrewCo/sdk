import { deliverUnchecked, enqueueAll, heldTransport, sampleClient } from "./batch-helpers.js";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const SERVER_ERROR = 500;
const NO_RETRIES = 0;
const NO_EVENTS = 0;
const ONE = 1;
const TWO = 2;

/**
 * @param {LogBrewClient} client
 * @returns {Promise<void>}
 */
async function assertShutdownRetryCloses(client) {
  client.log("evt_shutdown_retry", "2026-06-02T10:00:02Z", { level: "warning", message: "retry" });
  const response = await client.shutdown(RecordingTransport.alwaysAccept());
  assert.equal(response.batches, TWO);
  assert.equal(client.pendingEvents(), NO_EVENTS);
  assert.equal(client.pendingBytes(), NO_EVENTS);
  assert.throws(
    () => {
      client.log("evt_shutdown_closed", "2026-06-02T10:00:03Z", { level: "info", message: "closed" });
    },
    /client is already shut down/u
  );
}

await test("shutdown flushes and prevents future events", async () => {
  const client = sampleClient();
  enqueueAll(client);
  const transport = RecordingTransport.alwaysAccept();

  await client.shutdown(transport);

  assert.throws(
    () => {
      client.action("evt_action_002", "2026-06-02T10:00:06Z", { name: "deploy", status: "success" });
    },
    /client is already shut down/u
  );
});

await test("shutdown rejects capture while closing and reopens an intact queue after failure", async () => {
  const client = sampleClient({ maxRetries: NO_RETRIES });
  const held = heldTransport();
  client.log("evt_shutdown_001", "2026-06-02T10:00:00Z", { level: "info", message: "queued" });

  const shutdownPromise = deliverUnchecked(client, "shutdown", held.transport);
  await held.started;
  assert.throws(
    () => {
      client.log("evt_shutdown_blocked", "2026-06-02T10:00:01Z", { level: "info", message: "blocked" });
    },
    /client is shutting down/u
  );
  held.release({ statusCode: SERVER_ERROR });
  await assert.rejects(shutdownPromise, /unexpected transport status 500/u);
  assert.equal(client.pendingEvents(), ONE);

  await assertShutdownRetryCloses(client);
});
