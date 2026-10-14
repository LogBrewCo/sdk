import assert from "node:assert/strict";
import test from "node:test";
import { withInstalledPackage } from "./global-errors-test-support.js";

test("initial route capture failure detaches every listener before normal recovery", async () => {
  await withInstalledPackage(async ({ createReactNavigationSpanListener }, _directory, { LogBrewClient }) => {
    const appendError = new Error("storage unavailable");
    const listeners = new Map();
    let route = { name: "Checkout", path: "/checkout" };
    let fails = true;
    const client = LogBrewClient.create({
      apiKey: "LOGBREW_CLIENT_KEY", sdkName: "navigation-test", sdkVersion: "0.1.0",
      automaticDelivery: false,
      eventStore: {
        load() { return []; },
        append() { if (fails) { throw appendError; } },
        acknowledge() {}, purge() {}, close() {}
      }
    });
    const container = {
      getCurrentRoute() { return route; },
      addListener(name, listener) {
        listeners.set(name, listener);
        return { remove() { listeners.delete(name); } };
      }
    };
    const trace = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7", traceFlags: "01", traceSampled: true
    };
    assert.throws(() => createReactNavigationSpanListener(client, container, {
      captureInitialRoute: true, trace, metadata: { subjectId: "subject_first" }
    }), (error) => error === appendError);
    assert.equal(listeners.size, 0);
    assert.equal(client.pendingEvents(), 0);
    fails = false;
    route = { name: "Cart", path: "/cart" };
    for (const listener of listeners.values()) { listener(); }
    assert.equal(client.pendingEvents(), 0);
    const stop = createReactNavigationSpanListener(client, container, {
      captureInitialRoute: true,
      trace: { ...trace, spanId: "d2ad6b7169205553" },
      metadata: { subjectId: "subject_second" }
    });
    assert.equal(client.pendingEvents(), 1);
    const serialized = client.previewJson();
    assert.equal(serialized.includes("subject_first"), false);
    assert.equal(serialized.includes("subject_second"), true);
    assert.equal(serialized.includes("00f067aa0ba902b7"), false);
    stop();
    assert.equal(listeners.size, 0);
  }, "index.js");
});

test("a state subscription failure detaches the earlier action subscription", async () => {
  await withInstalledPackage(async ({ createReactNavigationSpanListener }, _directory, { LogBrewClient }) => {
    const stateError = new Error("state subscription unavailable");
    const listeners = new Map();
    const client = LogBrewClient.create({
      apiKey: "LOGBREW_CLIENT_KEY", sdkName: "navigation-test", sdkVersion: "0.1.0",
      automaticDelivery: false
    });
    const container = {
      getCurrentRoute() { return { name: "Checkout" }; },
      addListener(name, listener) {
        if (name === "state") { throw stateError; }
        listeners.set(name, listener);
        return { remove() { listeners.delete(name); } };
      }
    };
    assert.throws(() => createReactNavigationSpanListener(client, container),
      (error) => error === stateError);
    assert.equal(listeners.size, 0);
  }, "index.cjs");
});
