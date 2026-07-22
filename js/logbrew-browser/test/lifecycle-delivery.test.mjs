import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_KEY = "LOGBREW_BROWSER_KEY";
const ENDPOINT = "https://intake.example.test/v1/events";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-lifecycle-test-"));
  await mkdir(join(tempDir, "node_modules", "@logbrew"), { recursive: true });
  await cp(resolve(repoRoot, "js/logbrew-js"), join(tempDir, "node_modules", "@logbrew", "sdk"), {
    recursive: true
  });
  await cp(resolve(repoRoot, "js/logbrew-browser"), join(tempDir, "node_modules", "@logbrew", "browser"), {
    recursive: true
  });
  const imported = await import(pathToFileURL(join(tempDir, "node_modules", "@logbrew", "browser", "index.js")));
  return {
    imported,
    async removeTempDir() {
      await rm(tempDir, { force: true, recursive: true });
    }
  };
}

test("hidden and pagehide share one lifecycle delivery and retain later captures", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const browserWindow = createBrowserWindow();
  const requests = [];
  const firstResponse = deferred();
  const flushes = [];
  try {
    const context = imported.installLogBrewBrowser({
      browserWindow,
      captureGlobalErrors: false,
      capturePageViews: false,
      captureUnhandledRejections: false,
      clientKey: CLIENT_KEY,
      endpoint: ENDPOINT,
      fetchImpl: async (url, init) => {
        requests.push({ init, url });
        return requests.length === 1 ? firstResponse.promise : response(202);
      },
      flushOnOnline: false,
      maxRetries: 0,
      onFlush(value, _context, details) {
        flushes.push({ details, value });
      }
    });

    assert.equal(browserWindow.listenerCount("pagehide"), 1);
    assert.equal(browserWindow.document.listenerCount("visibilitychange"), 1);
    queueLog(context.client, "evt_browser_lifecycle_first_001");
    browserWindow.document.visibilityState = "hidden";
    browserWindow.document.dispatchEvent({ type: "visibilitychange" });
    await waitFor(() => requests.length === 1);

    browserWindow.dispatchEvent({ type: "pagehide" });
    queueLog(context.client, "evt_browser_lifecycle_later_001");
    firstResponse.resolve(response(202));
    await waitFor(() => flushes.length >= 1);
    await nextTask();

    assert.equal(requests.length, 1);
    assert.equal(flushes.length, 1);
    assert.equal(context.client.pendingEvents(), 1);
    assert.equal(flushes[0].details.reason, "visibility_hidden");
    assert.equal(requests[0].url, ENDPOINT);
    assert.equal(requests[0].init.keepalive, true);
    assert.equal(requests[0].init.headers.authorization, `Bearer ${CLIENT_KEY}`);
    assert.equal(requests[0].init.body.includes(CLIENT_KEY), false);
    assert.deepEqual(eventIds(requests[0].init.body), ["evt_browser_lifecycle_first_001"]);

    await context.flush();
    assert.equal(requests.length, 2);
    assert.deepEqual(eventIds(requests[1].init.body), ["evt_browser_lifecycle_later_001"]);

    context.uninstall();
    context.uninstall();
    assert.equal(browserWindow.listenerCount("pagehide"), 0);
    assert.equal(browserWindow.document.listenerCount("visibilitychange"), 0);
  } finally {
    await removeTempDir();
  }
});

test("lifecycle delivery defers custom and non-keepalive transports", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  try {
    const customWindow = createBrowserWindow();
    const customBodies = [];
    const customContext = imported.installLogBrewBrowser({
      browserWindow: customWindow,
      captureGlobalErrors: false,
      capturePageViews: false,
      captureUnhandledRejections: false,
      clientKey: CLIENT_KEY,
      flushOnOnline: false,
      maxRetries: 0,
      transport: {
        async send(_apiKey, body) {
          customBodies.push(body);
          return { attempts: 1, statusCode: 202 };
        }
      }
    });
    queueLog(customContext.client, "evt_browser_custom_deferred_001");
    customWindow.dispatchEvent({ type: "pagehide" });
    await nextTask();
    assert.equal(customBodies.length, 0);
    assert.equal(customContext.client.pendingEvents(), 1);
    await customContext.flush();
    assert.deepEqual(eventIds(customBodies[0]), ["evt_browser_custom_deferred_001"]);
    customContext.uninstall();

    const nonKeepaliveWindow = createBrowserWindow();
    const nonKeepaliveRequests = [];
    const nonKeepaliveContext = imported.installLogBrewBrowser({
      browserWindow: nonKeepaliveWindow,
      captureGlobalErrors: false,
      capturePageViews: false,
      captureUnhandledRejections: false,
      clientKey: CLIENT_KEY,
      fetchImpl: async (url, init) => {
        nonKeepaliveRequests.push({ init, url });
        return response(202);
      },
      flushOnOnline: false,
      keepalive: false,
      maxRetries: 0
    });
    queueLog(nonKeepaliveContext.client, "evt_browser_non_keepalive_deferred_001");
    nonKeepaliveWindow.dispatchEvent({ type: "pagehide" });
    await nextTask();
    assert.equal(nonKeepaliveRequests.length, 0);
    assert.equal(nonKeepaliveContext.client.pendingEvents(), 1);
    await nonKeepaliveContext.flush();
    assert.equal(nonKeepaliveRequests.length, 1);
    assert.equal(nonKeepaliveRequests[0].init.keepalive, false);
    nonKeepaliveContext.uninstall();

    const beaconWindow = createBrowserWindow();
    const beaconCalls = [];
    const beaconContext = imported.installLogBrewBrowser({
      browserWindow: beaconWindow,
      captureGlobalErrors: false,
      capturePageViews: false,
      captureUnhandledRejections: false,
      clientKey: CLIENT_KEY,
      flushOnOnline: false,
      transport: imported.createBeaconTransport({
        endpoint: "https://intake.example.test/browser-beacon",
        sendBeacon(endpoint, payload) {
          beaconCalls.push({ endpoint, payload });
          return true;
        }
      })
    });
    queueLog(beaconContext.client, "evt_browser_beacon_deferred_001");
    beaconWindow.dispatchEvent({ type: "pagehide" });
    await nextTask();
    assert.equal(beaconCalls.length, 0);
    assert.equal(beaconContext.client.pendingEvents(), 1);
    beaconContext.uninstall();
  } finally {
    await removeTempDir();
  }
});

test("terminal auth, quota, and validation outcomes pause until an explicit successful flush", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  try {
    for (const [status, code] of [[401, "unauthenticated"], [429, "rate_limited"], [400, "transport_error"]]) {
      const browserWindow = createBrowserWindow();
      const statuses = [status, 503, 202, 202];
      const requests = [];
      const errors = [];
      const context = imported.installLogBrewBrowser({
        browserWindow,
        captureGlobalErrors: false,
        capturePageViews: false,
        captureUnhandledRejections: false,
        clientKey: CLIENT_KEY,
        fetchImpl: async (url, init) => {
          requests.push({ init, url });
          return response(statuses.shift());
        },
        flushOnOnline: false,
        maxRetries: 0,
        onCaptureError(error, _context, details) {
          errors.push({ code: error.code, details });
        }
      });

      queueLog(context.client, `evt_browser_terminal_${status}`);
      browserWindow.dispatchEvent({ type: "pagehide" });
      await waitFor(() => errors.length === 1);
      assert.equal(errors[0].code, code);
      assert.equal(errors[0].details.reason, "pagehide");
      assert.equal(context.client.pendingEvents(), 1);

      browserWindow.document.visibilityState = "hidden";
      browserWindow.document.dispatchEvent({ type: "visibilitychange" });
      await nextTask();
      assert.equal(requests.length, 1);

      await assert.rejects(context.flush(), /unexpected transport status 503/);
      assert.equal(requests.length, 2);
      assert.equal(context.client.pendingEvents(), 1);

      browserWindow.dispatchEvent({ type: "pagehide" });
      await nextTask();
      assert.equal(requests.length, 2);

      const recovered = await context.flush();
      assert.equal(recovered.statusCode, 202);
      assert.equal(requests.length, 3);
      assert.equal(context.client.pendingEvents(), 0);

      queueLog(context.client, `evt_browser_terminal_recovered_${status}`);
      browserWindow.dispatchEvent({ type: "pagehide" });
      await waitFor(() => requests.length === 4);
      assert.equal(context.client.pendingEvents(), 0);
      context.uninstall();
    }
  } finally {
    await removeTempDir();
  }
});

test("oversized lifecycle bodies remain queued for explicit non-keepalive delivery", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const browserWindow = createBrowserWindow();
  const lifecycleRequests = [];
  const deferredErrors = [];
  const normalBodies = [];
  try {
    const context = imported.installLogBrewBrowser({
      browserWindow,
      captureGlobalErrors: false,
      capturePageViews: false,
      captureUnhandledRejections: false,
      clientKey: CLIENT_KEY,
      fetchImpl: async (url, init) => {
        lifecycleRequests.push({ init, url });
        return response(202);
      },
      flushOnOnline: false,
      maxKeepaliveBodyBytes: 128,
      maxRetries: 0,
      onCaptureError(error) {
        deferredErrors.push(error.code);
      }
    });
    context.client.log("evt_browser_lifecycle_oversized_001", "2026-07-18T00:00:00Z", {
      level: "info",
      message: "x".repeat(256)
    });
    browserWindow.dispatchEvent({ type: "pagehide" });
    await waitFor(() => deferredErrors.length === 1);
    assert.equal(lifecycleRequests.length, 0);
    assert.deepEqual(deferredErrors, ["keepalive_body_too_large"]);
    assert.equal(context.client.pendingEvents(), 1);

    await context.client.flush(imported.createFetchTransport({
      fetchImpl: async (_url, init) => {
        normalBodies.push(init.body);
        return response(202);
      },
      keepalive: false
    }));
    assert.deepEqual(eventIds(normalBodies[0]), ["evt_browser_lifecycle_oversized_001"]);
    assert.equal(context.client.pendingEvents(), 0);
    context.uninstall();
  } finally {
    await removeTempDir();
  }
});

test("failed shutdown restores lifecycle delivery after an in-flight exit request", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const browserWindow = createBrowserWindow();
  const firstResponse = deferred();
  const requests = [];
  const statuses = [503, 202];
  try {
    const context = imported.installLogBrewBrowser({
      browserWindow,
      captureGlobalErrors: false,
      capturePageViews: false,
      captureUnhandledRejections: false,
      clientKey: CLIENT_KEY,
      fetchImpl: async (url, init) => {
        requests.push({ init, url });
        if (requests.length === 1) {
          return firstResponse.promise;
        }
        return response(statuses.shift());
      },
      flushOnOnline: false,
      maxRetries: 0
    });
    queueLog(context.client, "evt_browser_shutdown_race_001");
    browserWindow.dispatchEvent({ type: "pagehide" });
    await waitFor(() => requests.length === 1);

    const shutdown = context.shutdown();
    firstResponse.resolve(response(503));
    await assert.rejects(shutdown, /unexpected transport status 503/);
    assert.equal(browserWindow.listenerCount("pagehide"), 1);
    assert.equal(context.client.pendingEvents(), 1);

    browserWindow.dispatchEvent({ type: "pagehide" });
    await waitFor(() => requests.length === 3);
    assert.equal(context.client.pendingEvents(), 0);
    context.uninstall();
  } finally {
    await removeTempDir();
  }
});

test("persistent lifecycle retries preserve exact failed bytes and clear accepted storage", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const browserWindow = createBrowserWindow();
  const storage = createMemoryStorage();
  browserWindow.localStorage = storage;
  const bodies = [];
  const errors = [];
  const statuses = [503, 202];
  try {
    const context = imported.installLogBrewBrowser({
      browserWindow,
      captureGlobalErrors: false,
      capturePageViews: false,
      captureUnhandledRejections: false,
      clientKey: CLIENT_KEY,
      fetchImpl: async (_url, init) => {
        bodies.push(init.body);
        return response(statuses.shift());
      },
      flushOnOnline: false,
      maxRetries: 0,
      onCaptureError(error) {
        errors.push(error.code);
      },
      persistOffline: {
        lockManager: undefined,
        storage
      }
    });
    queueLog(context.client, "evt_browser_persistent_lifecycle_001");
    browserWindow.dispatchEvent({ type: "pagehide" });
    await waitFor(() => errors.length === 1);
    assert.equal(storage.getItem("logbrew:browser:persisted-batches").includes(CLIENT_KEY), false);
    assert.equal(context.client.pendingEvents(), 1);

    browserWindow.dispatchEvent({ type: "pagehide" });
    await waitFor(() => bodies.length === 2);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(context.client.pendingEvents(), 0);
    assert.equal(storage.getItem("logbrew:browser:persisted-batches"), null);
    context.uninstall();
  } finally {
    await removeTempDir();
  }
});

function createBrowserWindow() {
  const windowTarget = createEventTarget();
  const documentTarget = createEventTarget();
  return {
    ...windowTarget,
    document: {
      ...documentTarget,
      visibilityState: "visible"
    },
    location: {
      hash: "#private-fragment",
      pathname: "/checkout",
      search: "?filter=private-query"
    }
  };
}

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event);
      }
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    }
  };
}

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
  };
}

function queueLog(client, id) {
  client.log(id, "2026-07-18T00:00:00Z", {
    level: "info",
    message: "browser lifecycle delivery"
  });
}

function response(status) {
  return { headers: new globalThis.Headers(), status };
}

function eventIds(body) {
  return JSON.parse(body).events.map((event) => event.id);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 1);
    });
  }
  throw new Error("condition was not met");
}

function nextTask() {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, 0);
  });
}
