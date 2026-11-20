import assert from "node:assert/strict";
import test from "node:test";
import { withInstalledPackage } from "./global-errors-test-support.js";

const trace = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: "01",
  traceSampled: true
};

const RETRY_WAIT_MS = 250;

function waitForRetry() {
  return new Promise((resolve) => { setTimeout(resolve, RETRY_WAIT_MS); });
}

function makeClient(LogBrewClient) {
  return LogBrewClient.create({
    apiKey: "LOGBREW_CLIENT_KEY", sdkName: "navigation-ref-test", sdkVersion: "0.1.0",
    automaticDelivery: false
  });
}

function fakeContainer() {
  const listeners = new Map();
  const state = { ready: false, route: { name: "Home", path: "/home" } };
  const container = {
    isReady() { return state.ready; },
    getCurrentRoute() { return state.ready ? state.route : undefined; },
    addListener(name, listener) {
      listeners.set(name, listener);
      return () => { listeners.delete(name); };
    }
  };
  return { container, listeners, state };
}

test("a navigation ref that mounts after setup records navigation spans", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativeInstrumentation }, _directory, { LogBrewClient }) => {
    const client = makeClient(LogBrewClient);
    const errors = [];
    const navigationRef = { current: null };
    const handle = createLogBrewReactNativeInstrumentation(client, {
      trace,
      navigationContainer: navigationRef,
      captureInitialNavigationRoute: true,
      onError: (error) => { errors.push(error); }
    });
    const { container, listeners, state } = fakeContainer();
    navigationRef.current = container;
    await waitForRetry();
    assert.equal(listeners.size, 0, "waits until the navigation tree is ready");
    state.ready = true;
    await waitForRetry();
    assert.equal(client.pendingEvents(), 1, "records the first route once the container is ready");
    assert.equal(client.previewJson().includes("Home"), true);
    state.route = { name: "Checkout", path: "/checkout" };
    listeners.get("state")();
    assert.equal(client.pendingEvents(), 2);
    assert.equal(client.previewJson().includes("Checkout"), true);
    handle.remove();
    assert.equal(listeners.size, 0);
    assert.deepEqual(errors, []);
  }, "instrumentation.cjs");
});

test("removing instrumentation before the navigation ref mounts stops waiting", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativeInstrumentation }, _directory, { LogBrewClient }) => {
    const client = makeClient(LogBrewClient);
    const navigationRef = { current: null };
    const handle = createLogBrewReactNativeInstrumentation(client, { trace, navigationContainer: navigationRef });
    handle.remove();
    const { container, listeners, state } = fakeContainer();
    state.ready = true;
    navigationRef.current = container;
    await waitForRetry();
    assert.equal(listeners.size, 0);
    assert.equal(client.pendingEvents(), 0);
  }, "instrumentation.js");
});

test("an invalid navigation value reports one error and keeps the rest of the setup", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativeInstrumentation }, _directory, { LogBrewClient }) => {
    const client = makeClient(LogBrewClient);
    const errors = [];
    const appStateListeners = new Set();
    const handle = createLogBrewReactNativeInstrumentation(client, {
      trace,
      appState: {
        currentState: "active",
        addEventListener(_name, listener) {
          appStateListeners.add(listener);
          return { remove() { appStateListeners.delete(listener); } };
        }
      },
      navigationContainer: { getCurrentRoute() { return undefined; } },
      onError: (error) => { errors.push(error); }
    });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "configuration_error");
    assert.equal(appStateListeners.size, 1);
    handle.remove();
    assert.equal(appStateListeners.size, 0);
  }, "instrumentation.cjs");
});

test("a navigation ref that mounts something other than a container reports one error", async () => {
  await withInstalledPackage(async ({ createLogBrewReactNativeInstrumentation }, _directory, { LogBrewClient }) => {
    const client = makeClient(LogBrewClient);
    const errors = [];
    const navigationRef = { current: null };
    const handle = createLogBrewReactNativeInstrumentation(client, {
      trace,
      navigationContainer: navigationRef,
      onError: (error) => { errors.push(error); }
    });
    navigationRef.current = {};
    await waitForRetry();
    await waitForRetry();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "configuration_error");
    handle.remove();
  }, "instrumentation.cjs");
});
