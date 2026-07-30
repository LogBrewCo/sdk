import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import {
  createClient,
  createErrorUtils,
  withInstalledPackage
} from "./global-errors-test-support.js";

test("captures nonfatal global reports before root registration and after mount", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const previousCalls = [];
    const errorUtils = createErrorUtils((error, isFatal) => {
      previousCalls.push({ error, isFatal });
    });
    const client = createClient();
    const installation = installLogBrewReactNativeGlobalErrorHandler({ client, errorUtils });

    errorUtils.currentHandler()(new TypeError("pre-root sensitive value"), false);
    errorUtils.currentHandler()(new Error("post-mount sensitive value"), false);

    assert.equal(client.issues.length, 2);
    assert.equal(previousCalls.length, 2);
    for (const { attributes } of client.issues) {
      assert.equal(attributes.title, "React Native global JavaScript report");
      assert.equal(attributes.message, "React Native global JavaScript report");
      assert.equal(attributes.level, "error");
      assert.deepEqual(
        {
          automatic: attributes.metadata.automatic,
          fatal: attributes.metadata.fatal,
          handled: attributes.metadata.handled,
          mechanism: attributes.metadata.mechanism,
          source: attributes.metadata.source
        },
        {
          automatic: true,
          fatal: false,
          handled: true,
          mechanism: "react_native_error_utils",
          source: "react-native.global_error"
        }
      );
    }
    assert.deepEqual(installation.health(), {
      active: true,
      capturedEvents: 2,
      lastOutcome: "captured",
      suppressedEvents: 0
    });
  });
});

test("CommonJS exposes matching named and default entry points", async () => {
  await withInstalledPackage(async (_module, packageDir) => {
    const required = createRequire(import.meta.url)(
      path.join(packageDir, "global-errors.cjs")
    );

    assert.equal(typeof required.createLogBrewReactNativePromiseRejectionHandlers, "function");
    assert.equal(typeof required.installLogBrewReactNativeGlobalErrorHandler, "function");
    assert.equal(
      required.default.createLogBrewReactNativePromiseRejectionHandlers,
      required.createLogBrewReactNativePromiseRejectionHandlers
    );
    assert.equal(
      required.default.installLogBrewReactNativeGlobalErrorHandler,
      required.installLogBrewReactNativeGlobalErrorHandler
    );
  });
});

test("redacts error content and local or remote stack locations", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const errorUtils = createErrorUtils();
    const client = createClient();
    installLogBrewReactNativeGlobalErrorHandler({ client, errorUtils });
    const sensitiveKey = ["to", "ken"].join("");
    const sensitivePair = `${sensitiveKey}=hidden`;
    const error = new Error(`${sensitivePair} email@example.test`);
    error.stack = [
      `Error: ${sensitivePair} email@example.test`,
      `    at email@example.test (https://sensitive.example.test/index.android.bundle?${sensitivePair}#account:12:34)`,
      "    at local (/home/example/account-name/source.js:56:78)",
      "    at workspace (/workspace/account-data/workspace.js:90:12)",
      "    at opt (/opt/account-data/opt.js:91:13)",
      "    at windows (C:\\account-data\\windows.js:92:14)",
      "    at unc (\\\\server\\account-data\\unc.js:93:15)"
    ].join("\n");

    errorUtils.currentHandler()(error, false);

    const serialized = JSON.stringify(client.issues);
    for (const forbidden of [
      sensitivePair,
      "email@example.test",
      "sensitive.example.test",
      "account-name",
      "/home/",
      "/workspace/",
      "/opt/",
      "C:\\",
      "\\\\server\\",
      "#account"
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    assert.ok(client.issues[0].attributes.stackFrames.length >= 1);
    assert.ok(client.issues[0].attributes.stackFrames.length <= 32);
  });
});

test("fatal errors remain unsupported without a synchronous native store and still chain", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const previousCalls = [];
    const diagnostics = [];
    const errorUtils = createErrorUtils((error, isFatal) => previousCalls.push({ error, isFatal }));
    const client = createClient();
    installLogBrewReactNativeGlobalErrorHandler({
      client,
      errorUtils,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    errorUtils.currentHandler()(new Error("fatal private content"), true);

    assert.equal(client.issues.length, 0);
    assert.equal(previousCalls.length, 1);
    assert.deepEqual(diagnostics, [{ code: "fatal_capture_requires_sync_store" }]);
    assert.equal(Object.isFrozen(diagnostics[0]), true);
  });
});

test("capture and diagnostic callback failures cannot blank the prior handler", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    let previousCalls = 0;
    const errorUtils = createErrorUtils(() => {
      previousCalls += 1;
    });
    installLogBrewReactNativeGlobalErrorHandler({
      client: createClient({ fail: true }),
      errorUtils,
      onDiagnostic() {
        throw new Error("private diagnostic failure");
      }
    });

    assert.doesNotThrow(() => errorUtils.currentHandler()(new Error("private"), false));
    assert.equal(previousCalls, 1);
  });
});

test("installation is idempotent and recursive capture is suppressed", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const client = createClient();
    let previousCalls = 0;
    const errorUtils = createErrorUtils((error, isFatal) => {
      previousCalls += 1;
      errorUtils.currentHandler()(error, isFatal);
    });

    const first = installLogBrewReactNativeGlobalErrorHandler({ client, errorUtils });
    const second = installLogBrewReactNativeGlobalErrorHandler({ client, errorUtils });
    assert.equal(first, second);
    assert.doesNotThrow(() => errorUtils.currentHandler()(new Error("private"), false));
    assert.equal(client.issues.length, 1);
    assert.equal(previousCalls, 1);
    assert.equal(first.health().suppressedEvents, 1);
  });
});

test("remove restores only the handler slot owned by the installation", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const previous = () => {};
    const errorUtils = createErrorUtils(previous);
    const installation = installLogBrewReactNativeGlobalErrorHandler({
      client: createClient(),
      errorUtils
    });

    assert.equal(installation.remove(), true);
    assert.equal(errorUtils.currentHandler(), previous);
    assert.equal(installation.remove(), false);

    const next = installLogBrewReactNativeGlobalErrorHandler({
      client: createClient(),
      errorUtils
    });
    const laterOwner = () => {};
    errorUtils.setGlobalHandler(laterOwner);
    assert.equal(next.remove(), false);
    assert.equal(errorUtils.currentHandler(), laterOwner);
  });
});

test("failed restoration remains active and can be retried", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const previous = () => {};
    let current = previous;
    let rejectRestore = true;
    const errorUtils = {
      getGlobalHandler() {
        return current;
      },
      setGlobalHandler(handler) {
        if (handler === previous && rejectRestore) {
          throw new Error("private restore failure");
        }
        current = handler;
      }
    };
    const client = createClient();
    const installation = installLogBrewReactNativeGlobalErrorHandler({ client, errorUtils });

    assert.equal(installation.remove(), false);
    assert.equal(installation.health().active, true);
    current(new Error("still captured"), false);
    assert.equal(client.issues.length, 1);

    rejectRestore = false;
    assert.equal(installation.remove(), true);
    assert.equal(current, previous);
    assert.equal(installation.health().active, false);
  });
});

test("missing platform or client seams return an inactive startup-safe handle", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const diagnostics = [];
    const missingPlatform = installLogBrewReactNativeGlobalErrorHandler({
      client: createClient(),
      errorUtils: {},
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    const missingClient = installLogBrewReactNativeGlobalErrorHandler({
      client: {},
      errorUtils: createErrorUtils(),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    assert.equal(missingPlatform.health().active, false);
    assert.equal(missingClient.health().active, false);
    assert.deepEqual(diagnostics, [
      { code: "handler_unavailable" },
      { code: "handler_unavailable" }
    ]);
  });
});

test("previous handler failures remain exactly observable", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const expected = new Error("application handler failure");
    const errorUtils = createErrorUtils(() => {
      throw expected;
    });
    const client = createClient();
    installLogBrewReactNativeGlobalErrorHandler({ client, errorUtils });

    assert.throws(
      () => errorUtils.currentHandler()(new Error("private"), false),
      (error) => error === expected
    );
    assert.equal(client.issues.length, 1);
  });
});

test("throwing or nonfunction ErrorUtils access stays inactive", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const diagnostics = [];
    let nonfunctionSetterCalls = 0;
    const inputs = [
      {
        getGlobalHandler() {
          throw new Error("private getter failure");
        },
        setGlobalHandler() {}
      },
      {
        getGlobalHandler() {
          return () => {};
        },
        setGlobalHandler() {
          throw new Error("private setter failure");
        }
      },
      {
        getGlobalHandler() {
          return "not a handler";
        },
        setGlobalHandler() {
          nonfunctionSetterCalls += 1;
        }
      }
    ];

    for (const errorUtils of inputs) {
      assert.doesNotThrow(() => {
        const installation = installLogBrewReactNativeGlobalErrorHandler({
          client: createClient(),
          errorUtils,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
        });
        assert.equal(installation.health().active, false);
      });
    }
    assert.deepEqual(diagnostics, [
      { code: "handler_unavailable" },
      { code: "handler_unavailable" },
      { code: "handler_unavailable" }
    ]);
    assert.equal(nonfunctionSetterCalls, 0);
  });
});

test("hostile capability getters cannot escape startup", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const diagnostics = [];
    const client = new Proxy({}, {
      get() {
        throw new Error("private client getter");
      }
    });
    const errorUtils = new Proxy({}, {
      get() {
        throw new Error("private ErrorUtils getter");
      }
    });

    assert.doesNotThrow(() => {
      const first = installLogBrewReactNativeGlobalErrorHandler({
        client,
        errorUtils: createErrorUtils(),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
      });
      const second = installLogBrewReactNativeGlobalErrorHandler({
        client: createClient(),
        errorUtils,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
      });
      assert.equal(first.health().active, false);
      assert.equal(second.health().active, false);
    });
    assert.deepEqual(diagnostics, [
      { code: "handler_unavailable" },
      { code: "handler_unavailable" }
    ]);
  });
});

test("hostile thrown values cannot leak or block chaining", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const client = createClient();
    let previousCalls = 0;
    const errorUtils = createErrorUtils(() => {
      previousCalls += 1;
    });
    installLogBrewReactNativeGlobalErrorHandler({ client, errorUtils });
    const hostile = new Proxy({}, {
      get() {
        throw new Error(`hidden@example.test ${["to", "ken"].join("")}=hidden`);
      }
    });

    assert.doesNotThrow(() => errorUtils.currentHandler()(hostile, false));
    assert.equal(previousCalls, 1);
    assert.equal(client.issues.length, 1);
    const serialized = JSON.stringify(client.issues);
    assert.equal(serialized.includes("hidden@example.test"), false);
    assert.equal(serialized.includes(`${["to", "ken"].join("")}=hidden`), false);
  });
});

test("captured reports receive distinct content-independent IDs", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const client = createClient();
    const errorUtils = createErrorUtils();
    installLogBrewReactNativeGlobalErrorHandler({ client, errorUtils });

    errorUtils.currentHandler()(new Error("first private value"), false);
    errorUtils.currentHandler()(new Error("second private value"), false);

    assert.equal(client.issues.length, 2);
    assert.notEqual(client.issues[0].id, client.issues[1].id);
    assert.match(client.issues[0].id, /^evt_rn_global_[a-z0-9]+_[a-z0-9]+$/u);
    assert.match(client.issues[1].id, /^evt_rn_global_[a-z0-9]+_[a-z0-9]+$/u);
  });
});

test("app-owned Promise rejection handlers capture fixed privacy-safe reports", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativePromiseRejectionHandlers }) => {
    const client = createClient();
    const diagnostics = [];
    const originalPromise = globalThis.Promise;
    const originalHermes = globalThis.HermesInternal;
    const handlers = createLogBrewReactNativePromiseRejectionHandlers({
      client,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    const sensitivePair = `${["to", "ken"].join("")}=hidden`;
    const hostileReason = new Proxy({}, {
      get() {
        throw new Error(`hidden@example.test ${sensitivePair}`);
      }
    });

    assert.doesNotThrow(() => handlers.onUnhandled(41, { reason: hostileReason }));
    assert.doesNotThrow(() => handlers.onUnhandled(41, { reason: "duplicate private value" }));
    assert.doesNotThrow(() => handlers.onHandled(41));

    assert.equal(globalThis.Promise, originalPromise);
    assert.equal(globalThis.HermesInternal, originalHermes);
    assert.equal(client.issues.length, 1);
    assert.match(client.issues[0].id, /^evt_rn_promise_[a-z0-9]+_[a-z0-9]+$/u);
    assert.deepEqual(
      {
        title: client.issues[0].attributes.title,
        message: client.issues[0].attributes.message,
        level: client.issues[0].attributes.level,
        metadata: {
          automatic: client.issues[0].attributes.metadata.automatic,
          fatal: client.issues[0].attributes.metadata.fatal,
          handled: client.issues[0].attributes.metadata.handled,
          mechanism: client.issues[0].attributes.metadata.mechanism,
          source: client.issues[0].attributes.metadata.source
        }
      },
      {
        title: "Unhandled Promise rejection",
        message: "Unhandled Promise rejection",
        level: "error",
        metadata: {
          automatic: true,
          fatal: false,
          handled: false,
          mechanism: "app_owned_promise_rejection_tracker",
          source: "react-native.promise_rejection"
        }
      }
    );
    const serialized = JSON.stringify(client.issues);
    assert.equal(serialized.includes("hidden@example.test"), false);
    assert.equal(serialized.includes(sensitivePair), false);
    assert.equal(serialized.includes("duplicate private value"), false);
    assert.deepEqual(handlers.health(), {
      available: true,
      capturedEvents: 1,
      evictedRejections: 0,
      handledLaterEvents: 1,
      lastOutcome: "handled_later",
      maxTrackedRejections: 128,
      suppressedEvents: 1,
      trackedRejections: 1,
      unknownHandledEvents: 0,
      untrackedEvents: 0
    });
    assert.equal(Object.isFrozen(handlers), true);
    assert.equal(Object.isFrozen(handlers.health()), true);
    assert.deepEqual(diagnostics, [{ code: "promise_rejection_duplicate_suppressed" }]);
    assert.equal(Object.isFrozen(diagnostics[0]), true);
  });
});

test("Promise rejection tracking stays bounded and never emits runtime identifiers", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativePromiseRejectionHandlers }) => {
    const client = createClient();
    const diagnostics = [];
    const handlers = createLogBrewReactNativePromiseRejectionHandlers({
      client,
      maxTrackedRejections: 2,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    const privateRuntimeId = "private-runtime-id@example.test";

    handlers.onUnhandled(1, { reason: "first private reason" });
    handlers.onUnhandled(2, { reason: "second private reason" });
    handlers.onUnhandled(privateRuntimeId, { reason: "third private reason" });
    handlers.onUnhandled(privateRuntimeId, { reason: "duplicate private reason" });
    handlers.onHandled(1);
    handlers.onUnhandled(undefined, { reason: "untracked private reason" });

    const serialized = JSON.stringify(client.issues);
    for (const forbidden of [
      privateRuntimeId,
      "first private reason",
      "second private reason",
      "third private reason",
      "duplicate private reason",
      "untracked private reason"
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    assert.equal(client.issues.length, 4);
    assert.deepEqual(handlers.health(), {
      available: true,
      capturedEvents: 4,
      evictedRejections: 1,
      handledLaterEvents: 0,
      lastOutcome: "captured_untracked",
      maxTrackedRejections: 2,
      suppressedEvents: 1,
      trackedRejections: 2,
      unknownHandledEvents: 1,
      untrackedEvents: 1
    });
    assert.deepEqual(diagnostics, [
      { code: "promise_rejection_tracking_evicted" },
      { code: "promise_rejection_duplicate_suppressed" },
      { code: "promise_rejection_id_unavailable" }
    ]);
  });
});

test("Promise rejection capture and diagnostics cannot interfere with the app", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativePromiseRejectionHandlers }) => {
    const handlers = createLogBrewReactNativePromiseRejectionHandlers({
      client: createClient({ fail: true }),
      onDiagnostic() {
        throw new Error("private diagnostic failure");
      }
    });

    assert.doesNotThrow(() => handlers.onUnhandled(7, {
      get reason() {
        throw new Error("private reason getter");
      }
    }));
    assert.doesNotThrow(() => handlers.onHandled(7));
    assert.deepEqual(handlers.health(), {
      available: true,
      capturedEvents: 0,
      evictedRejections: 0,
      handledLaterEvents: 0,
      lastOutcome: "handled_unknown",
      maxTrackedRejections: 128,
      suppressedEvents: 0,
      trackedRejections: 0,
      unknownHandledEvents: 1,
      untrackedEvents: 0
    });
  });
});

test("missing Promise rejection client returns startup-safe inert handlers", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativePromiseRejectionHandlers }) => {
    const diagnostics = [];
    const handlers = createLogBrewReactNativePromiseRejectionHandlers({
      client: {},
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    assert.doesNotThrow(() => handlers.onUnhandled(1, { reason: "private" }));
    assert.doesNotThrow(() => handlers.onHandled(1));
    assert.deepEqual(handlers.health(), {
      available: false,
      capturedEvents: 0,
      evictedRejections: 0,
      handledLaterEvents: 0,
      lastOutcome: "unavailable",
      maxTrackedRejections: 0,
      suppressedEvents: 0,
      trackedRejections: 0,
      unknownHandledEvents: 0,
      untrackedEvents: 0
    });
    assert.deepEqual(diagnostics, [{ code: "promise_rejection_handler_unavailable" }]);
  });
});
