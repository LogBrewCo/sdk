import assert from "node:assert/strict";
import test from "node:test";
import { withInstalledIndex } from "./global-errors-test-support.js";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const SESSION_ID = /^[0-9a-f]{32}$/u;

function createClient(sdk, options = {}) {
  return sdk.createLogBrewReactNativeClient({
    automaticDelivery: false,
    clientKey: "LOGBREW_REACT_NATIVE_KEY",
    transport: { send: async () => ({ statusCode: 202 }) },
    ...options
  });
}

test("React Native issues and logs carry the active trace in context.trace", async () => {
  await withInstalledIndex(async (sdk) => {
    const client = createClient(sdk);
    const trace = sdk.createReactNativeTraceContext({ traceparent: TRACEPARENT, spanId: "b7ad6b7169203331" });
    sdk.withLogBrewTrace(trace, () => {
      sdk.captureReactNativeError(client, new Error("payment declined"));
      client.log("evt_rn_log_test", "2026-11-24T10:00:00Z", { level: "warn", message: "payment step failing" });
    });
    const events = JSON.parse(client.previewJson()).events;
    const expected = { traceId: trace.traceId, spanId: trace.spanId, parentSpanId: trace.parentSpanId, sampled: true };
    for (const type of ["issue", "log"]) {
      const event = events.find((candidate) => candidate.type === type);
      assert.deepEqual(event.attributes.context.trace, expected, type);
    }
    assert.equal(events.find((event) => event.type === "issue").attributes.metadata.traceId, undefined);
  });
});

test("every React Native event carries one app session ID unless sessions are off", async () => {
  await withInstalledIndex(async (sdk) => {
    const client = createClient(sdk);
    client.log("evt_rn_log_a", "2026-11-24T10:00:00Z", { level: "info", message: "opened" });
    sdk.captureReactNativeAction(client, { name: "checkout.tapped" });
    const ids = JSON.parse(client.previewJson()).events.map((event) => event.attributes.context.session.id);
    assert.equal(ids.length, 2);
    assert.match(ids[0], SESSION_ID);
    assert.equal(ids[1], ids[0]);
    const off = createClient(sdk, { session: false });
    off.log("evt_rn_log_b", "2026-11-24T10:00:00Z", { level: "info", message: "opened" });
    assert.equal(JSON.parse(off.previewJson()).events[0].attributes.context, undefined);
  });
});
