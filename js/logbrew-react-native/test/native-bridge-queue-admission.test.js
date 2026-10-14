import assert from "node:assert/strict";
import test from "node:test";
import { withInstalledPackage } from "./global-errors-test-support.js";

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function bridgeAdapter() {
  let scope;
  let callbackCalls = 0;
  return {
    current() { return scope; },
    callbackCalls() { return callbackCalls; },
    recordCallback() { callbackCalls += 1; },
    setLogBrewScope(value) { scope = value; },
    clearLogBrewScope() { scope = undefined; }
  };
}

for (const entry of ["native-bridge.js", "native-bridge.cjs"]) {
  test(`${entry} rejects oversized async scope metadata before native work starts`, async () => {
    await withInstalledPackage(async (runtime) => {
      const bridge = bridgeAdapter();
      await assert.rejects(runtime.withLogBrewNativeBridgeScopeAsync(bridge, {
        metadata: { detail: "x".repeat(8193) }
      }, () => bridge.recordCallback()), (error) => error.code === "native_scope_too_large");
      assert.equal(bridge.callbackCalls(), 0);
      assert.equal(bridge.current(), undefined);
      assert.equal(await runtime.withLogBrewNativeBridgeScopeAsync(bridge, () => 42), 42);
    }, entry);
  });
}

test("a full async queue rejects before snapshotting more application scope data", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    const bridge = bridgeAdapter();
    const started = deferred();
    const release = deferred();
    const held = run(bridge, { sessionId: "session_active" }, async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const queued = Array.from({ length: 127 }, () => run(bridge, () => {}));
    let snapshotReads = 0;
    try {
      await assert.rejects(run(bridge, {
        get metadata() { snapshotReads += 1; return { detail: "queued detail" }; }
      }, () => bridge.recordCallback()), (error) => error.code === "native_scope_queue_full");
      assert.equal(snapshotReads, 0);
      assert.equal(bridge.callbackCalls(), 0);
      assert.equal(bridge.current().metadata.sessionId, "session_active");
    } finally {
      release.resolve();
      await held;
      await Promise.all(queued);
    }
    assert.equal(bridge.current(), undefined);
  }, "native-bridge.js");
});

test("async metadata admission counts derived fields and does not change the synchronous helper", async () => {
  await withInstalledPackage(async (runtime) => {
    const bridge = bridgeAdapter();
    const metadata = Object.fromEntries(Array.from({ length: 63 }, (_unused, index) => [`field${index}`, index]));
    assert.equal(await runtime.withLogBrewNativeBridgeScopeAsync(bridge, { metadata }, () => 42), 42);
    metadata.extra = 1;
    await assert.rejects(runtime.withLogBrewNativeBridgeScopeAsync(bridge, { metadata }, () => 43),
      (error) => error.code === "native_scope_too_large");
    assert.equal(runtime.withLogBrewNativeBridgeScope(bridge, { metadata }, () => 44), 44);
    assert.equal(bridge.current(), undefined);
  }, "native-bridge.cjs");
});

test("reentrant scope snapshots cannot admit more than the bridge queue capacity", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    const bridge = bridgeAdapter();
    const started = deferred();
    const release = deferred();
    const held = run(bridge, async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const queued = [];
    const outer = run(bridge, {
      get metadata() {
        for (let index = 0; index < 127; index += 1) {
          queued.push(run(bridge, () => index));
        }
        return {};
      }
    }, () => "outer");
    const outcomes = queued.map((result) => result.then(
      () => "completed",
      (error) => error.code
    ));
    release.resolve();
    await held;
    assert.equal(await outer, "outer");
    assert.equal((await Promise.all(outcomes)).filter((outcome) => outcome === "native_scope_queue_full").length, 1);
    assert.equal(bridge.current(), undefined);
  }, "native-bridge.js");
});

test("a rejected queued scope retains the active scope and leaves unrelated bridges available", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    const bridge = bridgeAdapter();
    const started = deferred();
    const release = deferred();
    const held = run(bridge, {
      sessionId: "session_active",
      trace: {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", traceFlags: "01", traceSampled: true
      }
    }, async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    try {
      await assert.rejects(run(bridge, { metadata: { detail: "x".repeat(8193) } }, () => bridge.recordCallback()),
        (error) => error.code === "native_scope_too_large");
      assert.equal(bridge.current().metadata.sessionId, "session_active");
      assert.equal(bridge.current().trace.spanId, "00f067aa0ba902b7");
      assert.equal(await run(bridgeAdapter(), () => 42), 42);
      assert.equal(bridge.callbackCalls(), 0);
    } finally {
      release.resolve();
      await held;
    }
    assert.equal(bridge.current(), undefined);
  }, "native-bridge.cjs");
});

test("failed snapshots release their reservations while an application callback is stalled", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    const bridge = bridgeAdapter();
    const started = deferred();
    const release = deferred();
    const held = run(bridge, async () => { started.resolve(); await release.promise; });
    await started.promise;
    const snapshotError = new Error("application snapshot failed");
    const queued = [];
    try {
      for (let index = 0; index < 200; index += 1) {
        await assert.rejects(run(bridge, {
          get metadata() { throw snapshotError; }
        }, () => bridge.recordCallback()), (error) => error === snapshotError);
      }
      for (let index = 0; index < 127; index += 1) {
        queued.push(run(bridge, () => index));
      }
      await assert.rejects(run(bridge, () => 128), (error) => error.code === "native_scope_queue_full");
      assert.equal(bridge.callbackCalls(), 0);
    } finally {
      release.resolve();
      await held;
      await Promise.all(queued);
    }
    assert.equal(await run(bridge, () => 42), 42);
    assert.equal(bridge.current(), undefined);
  }, "native-bridge.js");
});

test("same-bridge nested work waits for application-controlled outer completion", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    const bridge = bridgeAdapter();
    const enqueued = deferred();
    const applicationExit = deferred();
    let nested;
    let nestedStarted = false;
    const outer = run(bridge, { sessionId: "session_outer" }, async () => {
      await Promise.resolve();
      nested = run(bridge, { sessionId: "session_nested" }, () => {
        nestedStarted = true;
        assert.equal(bridge.current().metadata.sessionId, "session_nested");
        return "nested";
      });
      enqueued.resolve();
      await Promise.race([nested, applicationExit.promise]);
      assert.equal(bridge.current().metadata.sessionId, "session_outer");
      return "outer";
    });
    await enqueued.promise;
    try {
      assert.equal(nestedStarted, false);
      assert.equal(bridge.current().metadata.sessionId, "session_outer");
      assert.equal(await run(bridgeAdapter(), () => 42), 42);
    } finally {
      applicationExit.resolve();
      assert.equal(await outer, "outer");
      assert.equal(await nested, "nested");
    }
    assert.equal(bridge.current(), undefined);
  }, "native-bridge.cjs");
});

test("invalid async adapter values reject with a configuration error", async () => {
  await withInstalledPackage(async ({ withLogBrewNativeBridgeScopeAsync: run }) => {
    for (const invalid of [undefined, null, "bridge", 42, false]) {
      await assert.rejects(run(invalid, () => {}), (error) => error.code === "configuration_error");
    }
  }, "native-bridge.js");
});
