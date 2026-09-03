import assert from "node:assert/strict";
import test from "node:test";
import { withInstalledIndex } from "./global-errors-test-support.js";

test("React Native error events attach privacy-bounded release artifact metadata", async () => {
  await withInstalledIndex(async ({ createReactNativeErrorEvent, createReactNativeTraceContext }) => {
    const debugId = "11111111-2222-4333-8444-555555555555";
    const trace = createReactNativeTraceContext({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      spanId: "b7ad6b7169203331"
    });
    const error = new TypeError("Checkout failed with hidden email hidden@example.test");
    error.stack = "TypeError: Checkout failed with hidden email hidden@example.test\n    at checkout (https://static.example.test/react-native/index.android.bundle?email=hidden@example.test#pay:12:34)";

    const event = createReactNativeErrorEvent(error, {
      appState: { currentState: "active" },
      debugIdMap: { "https://static.example.test/react-native/index.android.bundle?email=hidden@example.test#pay": debugId },
      evidence: { likelyRootCause: "The authorization retry budget was exhausted." },
      environment: "production",
      platform: { OS: "ios" },
      release: "2026.07.06-rn",
      runtime: "react-native",
      screen: "Checkout",
      service: "checkout-mobile",
      trace
    });
    const metadata = event.attributes.metadata;
    const serialized = JSON.stringify(event.attributes);

    assert.equal(event.attributes.title, "React Native error: Checkout failed with hidden email hidden@example.test");
    assert.equal(metadata.source, "react-native.error");
    assert.equal(metadata.releaseArtifactDebugId, debugId);
    assert.equal(metadata.releaseArtifactCodeFile, "/react-native/index.android.bundle");
    assert.equal(metadata.errorFrameFile, "/react-native/index.android.bundle");
    assert.equal(metadata.issueGroupingKey, "react-native.error:TypeError:/react-native/index.android.bundle");
    assert.equal(metadata.errorFrameLine, 12);
    assert.equal(metadata.errorFrameColumn, 34);
    assert.equal(metadata.release, "2026.07.06-rn");
    assert.equal(metadata.environment, "production");
    assert.equal(metadata.service, "checkout-mobile");
    assert.equal(metadata.runtime, "react-native");
    assert.equal(metadata.platform, "ios");
    assert.equal(metadata.appState, "active");
    assert.equal(metadata.screen, "Checkout");
    assert.equal(metadata.traceId, trace.traceId);
    assert.equal(metadata.spanId, trace.spanId);
    assert.equal(metadata.parentSpanId, trace.parentSpanId);
    assert.equal(metadata.errorName, "TypeError");
    assert.equal(metadata.errorValueType, "object");
    assert.equal(event.attributes.evidence.likelyRootCause, "The authorization retry budget was exhausted.");
    assert.equal(serialized.includes("static.example.test"), false);
    assert.equal(serialized.includes("email=hidden"), false);
    assert.equal(serialized.includes("#pay"), false);
    assert.equal(serialized.includes("errorStack"), false);
  });
});

test("root React Native bundle frames retain privacy-bounded grouping identity", async () => {
  await withInstalledIndex(async ({ createReactNativeErrorEvent }) => {
    const eventFor = (functionName, line) => {
      const error = new Error("shared failure");
      error.stack = `Error: shared failure\n    at ${functionName} (http://localhost:8081?logbrew_query_placeholder=hidden:${line}:20)`;
      return createReactNativeErrorEvent(error).attributes;
    };
    const checkout = eventFor("checkoutFailure", 12);
    const profile = eventFor("profileFailure", 24);
    const generic = eventFor("anonymous", 33);

    assert.equal(checkout.metadata.issueGroupingKey, "react-native.error:Error:function=checkoutFailure");
    assert.equal(profile.metadata.issueGroupingKey, "react-native.error:Error:function=profileFailure");
    assert.equal(generic.metadata.issueGroupingKey, "react-native.error:Error:position=33:20");
    assert.equal(/localhost|logbrew_query_placeholder/u.test(JSON.stringify([checkout, profile, generic])), false);
  });
});

test("React Native error events discover the Metro Debug ID without an explicit map", async () => {
  await withInstalledIndex(async ({ createReactNativeErrorEvent }) => {
    const debugId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const runtimeUrl = "https://mobile.example.test/react-native/index.android.bundle?logbrew_query_placeholder=hidden#checkout";
    const registrySymbol = Symbol.for("@logbrew/react-native/debug-ids");
    const previousRegistry = globalThis[registrySymbol];
    globalThis[registrySymbol] = {
      [`Error\n    at __logbrew_register__ (${runtimeUrl}:1:1)`]: debugId,
    };

    try {
      const error = new Error("react native checkout exploded");
      error.stack = `Error: react native checkout exploded\n    at checkoutFailureSignal (${runtimeUrl}:12:34)`;

      const event = createReactNativeErrorEvent(error, {
        environment: "production",
        platform: { OS: "android" },
        release: "2026.07.09-rn-metro",
        runtime: "react-native",
        service: "checkout-mobile",
      });
      const metadata = event.attributes.metadata;
      const serialized = JSON.stringify(event.attributes);

      assert.equal(metadata.releaseArtifactDebugId, debugId);
      assert.equal(metadata.releaseArtifactCodeFile, "/react-native/index.android.bundle");
      assert.equal(metadata.errorFrameFile, "/react-native/index.android.bundle");
      assert.equal(serialized.includes("mobile.example.test"), false);
      assert.equal(serialized.includes("logbrew_query_placeholder"), false);
      assert.equal(serialized.includes("__logbrew_register__"), false);
    } finally {
      if (previousRegistry === undefined) {
        delete globalThis[registrySymbol];
      } else {
        globalThis[registrySymbol] = previousRegistry;
      }
    }
  });
});

test("React Native error events preserve an ordered bounded Metro stack", async () => {
  await withInstalledIndex(async ({ createReactNativeErrorEvent }) => {
    const debugId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const runtimeUrl = "https://mobile.example.test/react-native/index.android.bundle?hidden=value#checkout";
    const registrySymbol = Symbol.for("@logbrew/react-native/debug-ids");
    const previousRegistry = globalThis[registrySymbol];
    globalThis[registrySymbol] = {
      [`Error\n    at __logbrew_register__ (${runtimeUrl}:1:1)`]: debugId,
    };

    try {
      const error = new Error("react native checkout exploded");
      error.stack = [
        "Error: react native checkout exploded",
        `    at checkoutFailureSignal (${runtimeUrl}:12:34)`,
        `    at submitOrder (${runtimeUrl}:45:6)`
      ].join("\n");

      const event = createReactNativeErrorEvent(error, {
        environment: "production",
        platform: { OS: "android" },
        release: "2026.07.17-rn-metro",
        runtime: "react-native",
        service: "checkout-mobile",
      });

      assert.deepEqual(event.attributes.stackFrames, [
        {
          filename: "/react-native/index.android.bundle",
          line: 12,
          column: 34,
          function: "checkoutFailureSignal",
          debugId
        },
        {
          filename: "/react-native/index.android.bundle",
          line: 45,
          column: 6,
          function: "submitOrder",
          debugId
        }
      ]);
      assert.deepEqual(
        event.attributes.exceptionChain.entries[0].stackFrames,
        event.attributes.stackFrames
      );
      const serialized = JSON.stringify(event.attributes);
      assert.equal(serialized.includes("mobile.example.test"), false);
      assert.equal(serialized.includes("hidden=value"), false);
      assert.equal(serialized.includes("#checkout"), false);
      assert.equal(serialized.includes("__logbrew_register__"), false);
    } finally {
      if (previousRegistry === undefined) {
        delete globalThis[registrySymbol];
      } else {
        globalThis[registrySymbol] = previousRegistry;
      }
    }
  });
});

test("React Native error capture ignores malformed Metro registry state", async () => {
  await withInstalledIndex(async ({ createReactNativeErrorEvent }) => {
    const registrySymbol = Symbol.for("@logbrew/react-native/debug-ids");
    const previousRegistry = globalThis[registrySymbol];
    const registry = {};
    Object.defineProperty(registry, "unreadable", {
      enumerable: true,
      get() {
        throw new Error("registry getter must not interrupt capture");
      },
    });
    globalThis[registrySymbol] = registry;

    try {
      const error = new Error("react native checkout exploded");
      error.stack = "Error: react native checkout exploded\n    at checkoutFailureSignal (app:///index.android.bundle:12:34)";

      const event = createReactNativeErrorEvent(error, {
        environment: "production",
        platform: { OS: "android" },
        release: "2026.07.09-rn-metro",
        runtime: "react-native",
        service: "checkout-mobile",
      });

      assert.equal(event.attributes.metadata.releaseArtifactDebugId, undefined);
      assert.equal(event.attributes.metadata.errorFrameFile, "/index.android.bundle");
    } finally {
      if (previousRegistry === undefined) {
        delete globalThis[registrySymbol];
      } else {
        globalThis[registrySymbol] = previousRegistry;
      }
    }
  });
});

test("React Native error capture rejects ambiguous Metro Debug IDs for one runtime file", async () => {
  await withInstalledIndex(async ({ createReactNativeErrorEvent }) => {
    const runtimeUrl = "app:///index.android.bundle";
    const registrySymbol = Symbol.for("@logbrew/react-native/debug-ids");
    const previousRegistry = globalThis[registrySymbol];
    globalThis[registrySymbol] = {
      [`Error\n    at firstRegistration (${runtimeUrl}:1:1)`]: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      [`Error\n    at secondRegistration (${runtimeUrl}:2:2)`]: "11111111-2222-4333-8444-555555555555",
    };

    try {
      const error = new Error("react native checkout exploded");
      error.stack = `Error: react native checkout exploded\n    at checkoutFailureSignal (${runtimeUrl}:12:34)`;
      const event = createReactNativeErrorEvent(error, {
        environment: "production",
        platform: { OS: "android" },
        release: "2026.07.09-rn-metro",
        runtime: "react-native",
        service: "checkout-mobile",
      });

      assert.equal(event.attributes.metadata.releaseArtifactDebugId, undefined);
    } finally {
      if (previousRegistry === undefined) {
        delete globalThis[registrySymbol];
      } else {
        globalThis[registrySymbol] = previousRegistry;
      }
    }
  });
});

test("React Native error capture rejects malformed Metro stack coordinates", async () => {
  await withInstalledIndex(async ({ createReactNativeErrorEvent }) => {
    const runtimeUrl = "app:///index.android.bundle";
    const registrySymbol = Symbol.for("@logbrew/react-native/debug-ids");
    const previousRegistry = globalThis[registrySymbol];
    globalThis[registrySymbol] = {
      [`Error\n    at malformedRegistration (${runtimeUrl}:1x:1)`]: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    };

    try {
      const error = new Error("react native checkout exploded");
      error.stack = `Error: react native checkout exploded\n    at checkoutFailureSignal (${runtimeUrl}:12:34)`;
      const event = createReactNativeErrorEvent(error, {
        environment: "production",
        platform: { OS: "android" },
        release: "2026.07.09-rn-metro",
        runtime: "react-native",
        service: "checkout-mobile",
      });

      assert.equal(event.attributes.metadata.releaseArtifactDebugId, undefined);
    } finally {
      if (previousRegistry === undefined) {
        delete globalThis[registrySymbol];
      } else {
        globalThis[registrySymbol] = previousRegistry;
      }
    }
  });
});
