import assert from "node:assert/strict";
import test from "node:test";
import { withInstalledPackage } from "./global-errors-test-support.js";

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function options(sessionId, spanId = "00f067aa0ba902b7") {
  return {
    sessionId,
    trace: {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId, traceFlags: "01", traceSampled: true
    },
    metadata: { subjectId: sessionId, nested: { ignored: true }, traceId: "spoofed" }
  };
}

function nativeBridge() {
  let scope;
  const events = [];
  return {
    events,
    current() { return scope; },
    setLogBrewScope(value) { scope = value; },
    clearLogBrewScope() { scope = undefined; },
    emit(operation) {
      events.push({ operation, sessionId: scope?.metadata.sessionId, spanId: scope?.trace?.spanId });
    }
  };
}

for (const entry of ["native-bridge.js", "native-bridge.cjs"]) {
  test(`${entry} serializes concurrent async scope callbacks on one native bridge`, async () => {
    await withInstalledPackage(async (runtime) => {
      const run = runtime.withLogBrewNativeBridgeScopeAsync;
      assert.equal(typeof run, "function");
      assert.equal(runtime.default.withLogBrewNativeBridgeScopeAsync, run);
      const bridge = nativeBridge();
      const firstStarted = deferred();
      const firstWait = deferred();
      const secondStarted = deferred();
      const secondWait = deferred();
      const first = run(bridge, options("session_first"), async () => {
        bridge.emit("first_started");
        firstStarted.resolve();
        await firstWait.promise;
        bridge.emit("first_resumed");
        return 1;
      });
      const secondOptions = options("session_second", "d2ad6b7169205553");
      const second = run(bridge, secondOptions, async (payload) => {
        bridge.emit("second_started");
        assert.equal(payload.metadata.nested, undefined);
        assert.equal(payload.metadata.traceId, undefined);
        secondStarted.resolve();
        await secondWait.promise;
        bridge.emit("second_resumed");
        return 2;
      });
      secondOptions.sessionId = "changed_after_enqueue";
      secondOptions.trace.spanId = "1111111111111111";
      await firstStarted.promise;
      assert.equal(bridge.events.length, 1);
      assert.equal(bridge.current().metadata.sessionId, "session_first");
      firstWait.resolve();
      assert.equal(await first, 1);
      await secondStarted.promise;
      assert.equal(bridge.current().metadata.sessionId, "session_second");
      secondWait.resolve();
      assert.equal(await second, 2);
      assert.equal(bridge.current(), undefined);
      assert.deepEqual(bridge.events, [
        { operation: "first_started", sessionId: "session_first", spanId: "00f067aa0ba902b7" },
        { operation: "first_resumed", sessionId: "session_first", spanId: "00f067aa0ba902b7" },
        { operation: "second_started", sessionId: "session_second", spanId: "d2ad6b7169205553" },
        { operation: "second_resumed", sessionId: "session_second", spanId: "d2ad6b7169205553" }
      ]);
    }, entry);
  });
}

test("async scope work on a separate bridge does not wait for a held bridge", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    assert.equal(typeof run, "function");
    const heldBridge = nativeBridge();
    const otherBridge = nativeBridge();
    const started = deferred();
    const wait = deferred();
    const held = run(heldBridge, options("session_first"), async () => {
      started.resolve();
      await wait.promise;
      return 1;
    });
    await started.promise;
    try {
      assert.equal(await run(otherBridge, options("session_second"), () => 2), 2);
      assert.equal(otherBridge.current(), undefined);
      assert.equal(heldBridge.current().metadata.sessionId, "session_first");
    } finally {
      wait.resolve();
      await held;
    }
  }, "native-bridge.js");
});

test("a rejected callback preserves its error and releases the queued scope", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    assert.equal(typeof run, "function");
    const bridge = nativeBridge();
    const applicationError = new Error("private application detail");
    const started = deferred();
    const wait = deferred();
    const first = run(bridge, options("session_first"), async () => {
      started.resolve();
      await wait.promise;
      throw applicationError;
    });
    const rejection = assert.rejects(first, (error) => error === applicationError);
    const second = run(bridge, options("session_second"), () => {
      bridge.emit("second_started");
      return 2;
    });
    await started.promise;
    wait.resolve();
    await rejection;
    assert.equal(await second, 2);
    assert.equal(bridge.current(), undefined);
    assert.equal(JSON.stringify(bridge.events).includes("private application detail"), false);
    assert.equal(bridge.events[0].sessionId, "session_second");
  }, "native-bridge.cjs");
});

test("native set failure clears partial scope and allows the next queued operation", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    assert.equal(typeof run, "function");
    const bridge = nativeBridge();
    const originalSet = bridge.setLogBrewScope;
    const setError = new Error("native set failed");
    let callbackCalls = 0;
    bridge.setLogBrewScope = (scope) => {
      originalSet(scope);
      if (scope.metadata.sessionId === "session_first") { throw setError; }
    };
    const first = run(bridge, options("session_first"), () => { callbackCalls += 1; });
    const rejection = assert.rejects(first, (error) => error === setError);
    const second = run(bridge, options("session_second"), () => {
      bridge.emit("second_started");
      return 2;
    });
    await rejection;
    assert.equal(await second, 2);
    assert.equal(callbackCalls, 0);
    assert.equal(bridge.events[0].sessionId, "session_second");
    assert.equal(bridge.current(), undefined);
  }, "native-bridge.js");
});

test("unavailable or failing scope clear rejects before stale context can reach the callback", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    assert.equal(typeof run, "function");
    let callbackCalls = 0;
    await assert.rejects(run({ setLogBrewScope() {} }, () => { callbackCalls += 1; }),
      (error) => error.code === "configuration_error");
    const bridge = nativeBridge();
    bridge.setLogBrewScope({ metadata: { sessionId: "stale_session" } });
    const clearError = new Error("native clear failed");
    const originalClear = bridge.clearLogBrewScope;
    let fails = true;
    bridge.clearLogBrewScope = () => {
      if (fails) { throw clearError; }
      originalClear();
    };
    await assert.rejects(run(bridge, options("session_first"), () => { callbackCalls += 1; }),
      (error) => error === clearError);
    assert.equal(callbackCalls, 0);
    fails = false;
    assert.equal(await run(bridge, options("session_second"), () => {
      bridge.emit("recovered");
      return 2;
    }), 2);
    assert.equal(bridge.events[0].sessionId, "session_second");
    assert.equal(bridge.current(), undefined);
  }, "native-bridge.cjs");
});

test("async native setter and clear promises settle before callbacks and queue release", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    assert.equal(typeof run, "function");
    const calls = [];
    const bridge = async (scope) => {
      calls.push(scope ? "set_started" : "clear_started");
      await Promise.resolve();
      calls.push(scope ? "set_finished" : "clear_finished");
    };
    assert.equal(await run(bridge, () => { calls.push("callback"); return 42; }), 42);
    assert.deepEqual(calls, [
      "clear_started", "clear_finished", "set_started", "set_finished",
      "callback", "clear_started", "clear_finished"
    ]);
  }, "native-bridge.js");
});

test("the existing helper retains its synchronous return and the new helper returns a Promise", async () => {
  await withInstalledPackage(async (runtime) => {
    const bridge = nativeBridge();
    assert.equal(runtime.withLogBrewNativeBridgeScope(bridge, () => 42), 42);
    assert.equal(typeof runtime.withLogBrewNativeBridgeScopeAsync, "function");
    const result = runtime.withLogBrewNativeBridgeScopeAsync(bridge, () => 42);
    assert.ok(result instanceof Promise);
    assert.equal(await result, 42);
    assert.equal(bridge.current(), undefined);
  }, "native-bridge.cjs");
});

test("final scope clear failure rejects the result and releases the bridge for recovery", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    const bridge = nativeBridge();
    const clearError = new Error("native clear failed");
    const originalClear = bridge.clearLogBrewScope;
    let clearCalls = 0;
    bridge.clearLogBrewScope = async () => {
      clearCalls += 1;
      await Promise.resolve();
      if (clearCalls === 2) { throw clearError; }
      originalClear();
    };
    const first = run(bridge, options("session_first"), () => 1);
    const rejected = assert.rejects(first, (error) => error === clearError);
    const second = run(bridge, options("session_second"), () => {
      bridge.emit("second_started");
      return 2;
    });
    await rejected;
    assert.equal(await second, 2);
    assert.equal(bridge.events[0].sessionId, "session_second");
    assert.equal(bridge.current(), undefined);
  }, "native-bridge.js");
});

test("a rejected callback remains observable when its scope clear also rejects", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    const bridge = nativeBridge();
    const applicationError = new Error("application failed");
    const originalClear = bridge.clearLogBrewScope;
    let clearCalls = 0;
    bridge.clearLogBrewScope = async () => {
      clearCalls += 1;
      if (clearCalls === 2) { throw new Error("native clear failed"); }
      originalClear();
    };
    await assert.rejects(run(bridge, options("session_first"), () => {
      throw applicationError;
    }), (error) => error === applicationError);
    assert.equal(await run(bridge, options("session_second"), () => 2), 2);
    assert.equal(bridge.current(), undefined);
  }, "native-bridge.cjs");
});

test("the async scope queue is bounded per bridge and recovers capacity after completion", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    const bridge = nativeBridge();
    const started = deferred();
    const wait = deferred();
    const first = run(bridge, async () => {
      started.resolve();
      await wait.promise;
      return 0;
    });
    await started.promise;
    const queued = Array.from({ length: 127 }, (_unused, index) => run(bridge, () => index + 1));
    try {
      await assert.rejects(run(bridge, () => 129),
        (error) => error.code === "native_scope_queue_full");
      assert.equal(await run(nativeBridge(), () => 42), 42);
    } finally {
      wait.resolve();
      await first;
      assert.deepEqual(await Promise.all(queued), Array.from({ length: 127 }, (_unused, index) => index + 1));
    }
    assert.equal(await run(bridge, () => 42), 42);
    assert.equal(bridge.current(), undefined);
  }, "native-bridge.js");
});
