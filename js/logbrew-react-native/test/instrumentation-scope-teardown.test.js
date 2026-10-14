import assert from "node:assert/strict";
import test from "node:test";
import { withInstalledPackage } from "./global-errors-test-support.js";

const trace = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: "01",
  traceSampled: true
};

function fixture(LogBrewClient) {
  const appStateListeners = new Set();
  const navigationListeners = new Map();
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_CLIENT_KEY", sdkName: "instrumentation-test", sdkVersion: "0.1.0",
    automaticDelivery: false
  });
  return {
    appStateListeners,
    navigationListeners,
    client,
    options: {
      trace,
      appState: {
        currentState: "active",
        addEventListener(_name, listener) {
          appStateListeners.add(listener);
          return { remove() { appStateListeners.delete(listener); } };
        }
      },
      navigationContainer: {
        getCurrentRoute() { return { name: "Checkout", path: "/checkout" }; },
        addListener(name, listener) {
          navigationListeners.set(name, listener);
          return { remove() { navigationListeners.delete(name); } };
        }
      }
    }
  };
}

test("resource wrapper setup failure removes listeners and the applied native scope", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativeInstrumentation }, _directory, { LogBrewClient }) => {
    const { options, client, appStateListeners, navigationListeners } = fixture(LogBrewClient);
    let currentScope;
    const nativeBridge = {
      setLogBrewScope(scope) { currentScope = scope; },
      clearLogBrewScope() { currentScope = undefined; }
    };
    assert.throws(() => createLogBrewReactNativeInstrumentation(client, {
      ...options, nativeBridge, metadataFactory: true
    }), /metadataFactory must be a function/u);
    assert.equal(currentScope, undefined);
    assert.equal(appStateListeners.size, 0);
    assert.equal(navigationListeners.size, 0);
    assert.equal(client.pendingEvents(), 0);
    const handle = createLogBrewReactNativeInstrumentation(client, { ...options, nativeBridge });
    assert.equal(appStateListeners.size, 1);
    handle.remove();
    assert.equal(appStateListeners.size, 0);
    assert.equal(navigationListeners.size, 0);
    assert.equal(currentScope, undefined);
  }, "instrumentation.js");
});

test("native set failure preserves its error and removes earlier listeners", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativeInstrumentation }, _directory, { LogBrewClient }) => {
    const { options, client, appStateListeners, navigationListeners } = fixture(LogBrewClient);
    const setError = new Error("native set failed");
    let currentScope;
    const nativeBridge = {
      setLogBrewScope(scope) { currentScope = scope; throw setError; },
      clearLogBrewScope() { currentScope = undefined; }
    };
    assert.throws(() => createLogBrewReactNativeInstrumentation(client, { ...options, nativeBridge }),
      (error) => error === setError);
    assert.equal(currentScope, undefined);
    assert.equal(appStateListeners.size, 0);
    assert.equal(navigationListeners.size, 0);
  }, "instrumentation.js");
});

test("native clear failure cannot retain event listeners and can be retried", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativeInstrumentation }, _directory, { LogBrewClient }) => {
    const { options, client, appStateListeners, navigationListeners } = fixture(LogBrewClient);
    const clearError = new Error("native clear failed");
    let currentScope;
    let fails = true;
    const nativeBridge = {
      setLogBrewScope(scope) { currentScope = scope; },
      clearLogBrewScope() {
        if (fails) { throw clearError; }
        currentScope = undefined;
      }
    };
    const handle = createLogBrewReactNativeInstrumentation(client, { ...options, nativeBridge });
    assert.throws(() => handle.remove(), (error) => error === clearError);
    assert.equal(appStateListeners.size, 0);
    assert.equal(navigationListeners.size, 0);
    fails = false;
    handle.remove();
    assert.equal(currentScope, undefined);
    handle.remove();
    assert.equal(appStateListeners.size, 0);
  }, "instrumentation.cjs");
});

test("a failed listener detach cannot block the other listeners or its own retry", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativeInstrumentation }, _directory, { LogBrewClient }) => {
    const { options, client, appStateListeners, navigationListeners } = fixture(LogBrewClient);
    const detachError = new Error("listener detach failed");
    let fails = true;
    options.navigationContainer.addListener = (name, listener) => {
      navigationListeners.set(name, listener);
      return { remove() {
        if (fails) { throw detachError; }
        navigationListeners.delete(name);
      } };
    };
    const handle = createLogBrewReactNativeInstrumentation(client, options);
    assert.throws(() => handle.remove(), (error) => error === detachError);
    assert.equal(appStateListeners.size, 0);
    fails = false;
    handle.remove();
    assert.equal(navigationListeners.size, 0);
  }, "instrumentation.cjs");
});

test("scope clear failure cannot replace the original wrapper setup error", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativeInstrumentation }, _directory, { LogBrewClient }) => {
    const { options, client, appStateListeners, navigationListeners } = fixture(LogBrewClient);
    let currentScope;
    let fails = true;
    const nativeBridge = {
      setLogBrewScope(scope) { currentScope = scope; },
      clearLogBrewScope() {
        if (fails) { throw new Error("native clear failed"); }
        currentScope = undefined;
      }
    };
    assert.throws(() => createLogBrewReactNativeInstrumentation(client, {
      ...options, nativeBridge, metadataFactory: true
    }), (error) => error.code === "configuration_error"
      && /metadataFactory must be a function/u.test(error.message));
    assert.equal(appStateListeners.size, 0);
    assert.equal(navigationListeners.size, 0);
    fails = false;
    const handle = createLogBrewReactNativeInstrumentation(client, { ...options, nativeBridge });
    handle.remove();
    assert.equal(currentScope, undefined);
    assert.equal(appStateListeners.size, 0);
    assert.equal(navigationListeners.size, 0);
  }, "instrumentation.js");
});
