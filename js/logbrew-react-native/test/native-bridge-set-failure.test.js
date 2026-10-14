import assert from "node:assert/strict";
import test from "node:test";
import { withInstalledPackage } from "./global-errors-test-support.js";

const firstScope = {
  trace: {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
    traceSampled: true
  },
  sessionId: "session_first",
  metadata: { subjectId: "subject_first", nested: { ignored: true }, traceId: "spoofed" }
};

for (const method of ["setLogBrewScope", "syncLogBrewScope"]) {
  test(`${method} failure clears partially applied trace and session scope`, async () => {
    await withInstalledPackage(async ({ withLogBrewNativeBridgeScope }) => {
      const setError = new Error("native scope set failed");
      const events = [];
      let currentScope;
      let callbackCalls = 0;
      let clears = 0;
      let fails = true;
      const bridge = {
        [method](scope) {
          currentScope = scope;
          if (fails) {
            throw setError;
          }
        },
        clearLogBrewScope() {
          clears += 1;
          currentScope = undefined;
        },
        captureEvent() {
          events.push(structuredClone(currentScope ?? null));
        }
      };
      assert.throws(() => withLogBrewNativeBridgeScope(bridge, firstScope, () => {
        callbackCalls += 1;
      }), (error) => error === setError);
      assert.equal(callbackCalls, 0);
      assert.equal(clears, 1);
      bridge.captureEvent();
      assert.deepEqual(events, [null]);

      fails = false;
      const result = withLogBrewNativeBridgeScope(bridge, { sessionId: "session_second" }, () => {
        bridge.captureEvent();
        return 42;
      });
      assert.equal(result, 42);
      assert.equal(currentScope, undefined);
      assert.equal(events[1].metadata.sessionId, "session_second");
      assert.equal(events[1].trace, undefined);
      assert.equal(JSON.stringify(events).includes("session_first"), false);
      assert.equal(JSON.stringify(events).includes("subject_first"), false);
    }, "native-bridge.js");
  });
}

test("function bridge set failure clears the applied scope through its undefined callback", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScope }) => {
    const setError = new Error("native scope set failed");
    const calls = [];
    let currentScope;
    const bridge = (scope) => {
      calls.push(scope);
      currentScope = scope;
      if (scope !== undefined) {
        throw setError;
      }
    };
    assert.throws(() => withLogBrewNativeBridgeScope(bridge, firstScope, () => {}),
      (error) => error === setError);
    assert.equal(currentScope, undefined);
    assert.equal(calls.length, 2);
    assert.equal(calls[1], undefined);
    assert.equal(calls[0].metadata.nested, undefined);
    assert.equal(calls[0].metadata.traceId, undefined);
  }, "native-bridge.cjs");
});

test("a second scope clear failure cannot replace the original native set error", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScope }) => {
    const setError = new Error("native scope set failed");
    let clears = 0;
    let callbackCalls = 0;
    const bridge = {
      setLogBrewScope() { throw setError; },
      clearLogBrewTraceContext() {
        clears += 1;
        throw new Error("native scope clear failed");
      }
    };
    assert.throws(() => withLogBrewNativeBridgeScope(bridge, firstScope, () => {
      callbackCalls += 1;
    }), (error) => error === setError);
    assert.equal(clears, 1);
    assert.equal(callbackCalls, 0);
  }, "native-bridge.cjs");
});
