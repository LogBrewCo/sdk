import assert from "node:assert/strict";
import test from "node:test";
import { withInstalledPackage } from "./global-errors-test-support.js";

for (const entry of ["native-bridge.js", "native-bridge.cjs"]) {
  test(`${entry} preserves the application error when clearing the bridge scope fails`, async () => {
    await withInstalledPackage(async ({ withLogBrewNativeBridgeScope }) => {
      const applicationError = new Error("application failed");
      let clears = 0;
      const bridge = {
        setLogBrewScope() {},
        clearLogBrewScope() {
          clears += 1;
          throw new Error("scope clear failed");
        }
      };
      assert.throws(() => withLogBrewNativeBridgeScope(bridge, () => {
        throw applicationError;
      }), (error) => error === applicationError);
      assert.equal(clears, 1);
      await assert.rejects(withLogBrewNativeBridgeScope(bridge, async () => {
        throw applicationError;
      }), (error) => error === applicationError);
      assert.equal(clears, 2);
    }, entry);
  });

  test(`${entry} exposes scope clear failure once after a successful callback`, async () => {
    await withInstalledPackage(async ({ withLogBrewNativeBridgeScope }) => {
      const scopeClearError = new Error("scope clear failed");
      let clears = 0;
      const bridge = {
        setLogBrewScope() {},
        clearLogBrewScope() {
          clears += 1;
          throw scopeClearError;
        }
      };
      assert.throws(() => withLogBrewNativeBridgeScope(bridge, () => 42),
        (error) => error === scopeClearError);
      assert.equal(clears, 1);
      await assert.rejects(withLogBrewNativeBridgeScope(bridge, async () => 42),
        (error) => error === scopeClearError);
      assert.equal(clears, 2);
    }, entry);
  });

  test(`${entry} retains bridge scope until async work settles`, async () => {
    await withInstalledPackage(async ({ withLogBrewNativeBridgeScope }) => {
      let scope;
      const bridge = {
        setLogBrewScope(value) { scope = value; },
        clearLogBrewScope() { scope = undefined; }
      };
      const options = {
        screen: "Checkout",
        trace: {
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
          traceFlags: "01",
          traceSampled: true
        },
        metadata: { nested: { ignored: true }, traceId: "spoofed" }
      };
      const result = withLogBrewNativeBridgeScope(bridge, options, async (payload) => {
        assert.equal(scope, payload);
        assert.equal(payload.trace.traceId, options.trace.traceId);
        assert.equal(payload.metadata.nested, undefined);
        assert.equal(payload.metadata.traceId, undefined);
        await Promise.resolve();
        assert.equal(scope, payload);
        return 42;
      });
      assert.ok(scope);
      assert.equal(await result, 42);
      assert.equal(scope, undefined);
    }, entry);
  });
}
