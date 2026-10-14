import assert from "node:assert/strict";
import test from "node:test";
import { withInstalledPackage } from "./global-errors-test-support.js";

for (const entry of ["global-errors.js", "global-errors.cjs"]) {
  test(`${entry} retries a dropped rejection after queue recovery`, async () => {
    await withInstalledPackage(async (runtime, _directory, { LogBrewClient }) => {
      const batches = [];
      const client = LogBrewClient.create({
        apiKey: "LOGBREW_CLIENT_KEY",
        sdkName: "react-native-rejection-test",
        sdkVersion: "0.1.0",
        automaticDelivery: false,
        maxQueueSize: 1,
        transport: {
          async send(_key, body) {
            batches.push(JSON.parse(body));
            return { attempts: 1, statusCode: 202 };
          }
        }
      });
      client.log("evt_filler", "2026-07-31T08:30:00.000Z", {
        message: "queue filler", level: "info"
      });
      const diagnostics = [];
      const handlers = runtime.createLogBrewReactNativePromiseRejectionHandlers({
        client,
        maxTrackedRejections: 1,
        onDiagnostic: (value) => diagnostics.push(value)
      });
      const reason = new Error("private rejection content");
      handlers.onUnhandled("private-runtime-id", reason);
      assert.equal(client.droppedEvents(), 1);
      assert.equal(handlers.health().capturedEvents, 0);
      assert.equal(handlers.health().trackedRejections, 0);
      assert.equal(handlers.health().lastOutcome, "capture_failed");
      assert.deepEqual(diagnostics, [{ code: "promise_rejection_capture_failed" }]);

      await client.flush();
      handlers.onUnhandled("private-runtime-id", reason);
      handlers.onUnhandled("private-runtime-id", reason);
      assert.equal(client.pendingEvents(), 1);
      assert.equal(handlers.health().capturedEvents, 1);
      assert.equal(handlers.health().trackedRejections, 1);
      assert.equal(handlers.health().suppressedEvents, 1);
      handlers.onHandled("private-runtime-id");
      assert.equal(handlers.health().handledLaterEvents, 1);
      await client.shutdown();
      assert.equal(batches[1].events.length, 1);
      assert.equal(batches[1].events[0].type, "issue");
      const serialized = JSON.stringify(batches);
      assert.equal(serialized.includes("private rejection content"), false);
      assert.equal(serialized.includes("private-runtime-id"), false);
    }, entry);
  });
}

test("a rejected report does not evict an admitted rejection identity", async () => {
  await withInstalledPackage(async (runtime, _directory, { LogBrewClient }) => {
    const client = LogBrewClient.create({
      apiKey: "LOGBREW_CLIENT_KEY",
      sdkName: "react-native-rejection-test",
      sdkVersion: "0.1.0",
      automaticDelivery: false,
      maxQueueSize: 1,
      transport: { async send() { return { attempts: 1, statusCode: 202 }; } }
    });
    const handlers = runtime.createLogBrewReactNativePromiseRejectionHandlers({
      client, maxTrackedRejections: 1
    });
    handlers.onUnhandled(1);
    handlers.onUnhandled(2);
    assert.equal(client.droppedEvents(), 1);
    assert.equal(handlers.health().evictedRejections, 0);
    await client.flush();
    handlers.onUnhandled(1);
    assert.equal(client.pendingEvents(), 0);
    assert.equal(handlers.health().suppressedEvents, 1);
    handlers.onUnhandled(2);
    assert.equal(client.pendingEvents(), 1);
    assert.equal(handlers.health().evictedRejections, 1);
    await client.shutdown();
  });
});
