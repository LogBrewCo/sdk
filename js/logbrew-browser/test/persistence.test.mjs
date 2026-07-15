import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_KEY = "LOGBREW_BROWSER_KEY";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-test-"));
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

test("persistent browser transport stores retryable batches without auth and replays them", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const { createPersistentBrowserTransport } = imported;
  const storage = createMemoryStorage();
  const sent = [];
  let statusCode = 503;
  try {
    const transport = createPersistentBrowserTransport({
      storage,
      transport: {
        async send(apiKey, body) {
          sent.push({ apiKey, body });
          return { statusCode };
        }
      }
    });
    const body = JSON.stringify({
      events: [{ id: "evt_offline_001", type: "log" }],
      sdk: { name: "logbrew-browser", version: "0.1.0" }
    });

    const firstResponse = await transport.send(CLIENT_KEY, body);

    assert.equal(firstResponse.statusCode, 503);
    assert.equal(sent.length, 1);
    assert.equal(storage.getItem("logbrew:browser:persisted-batches").includes(CLIENT_KEY), false);
    assert.equal(storage.getItem("logbrew:browser:persisted-batches").includes("evt_offline_001"), true);

    statusCode = 202;
    const replay = await transport.replayStoredBatches(CLIENT_KEY);

    assert.deepEqual(replay, { attempted: 1, delivered: 1, retained: 0 });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body, body);
    assert.equal(storage.getItem("logbrew:browser:persisted-batches"), null);
  } finally {
    await removeTempDir();
  }
});

test("installLogBrewBrowser replays persisted batches before flushing live online queue", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const { installLogBrewBrowser } = imported;
  const storage = createMemoryStorage();
  const browserWindow = createFakeBrowserWindow(storage);
  const sentBodies = [];
  try {
    const context = installLogBrewBrowser({
      browserWindow,
      capturePageViews: false,
      clientKey: CLIENT_KEY,
      flushOnCapture: false,
      persistOffline: {
        storage
      },
      replayPersistedOnInstall: false,
      transport: {
        async send(_apiKey, body) {
          sentBodies.push(body);
          return { statusCode: 202 };
        }
      }
    });
    const storedBody = JSON.stringify({
      events: [{ id: "evt_persisted_001", type: "log" }],
      sdk: { name: "logbrew-browser", version: "0.1.0" }
    });
    await context.transport.send(CLIENT_KEY, storedBody);
    assert.equal(storage.getItem("logbrew:browser:persisted-batches"), null);
    const failingContext = installLogBrewBrowser({
      browserWindow,
      capturePageViews: false,
      clientKey: CLIENT_KEY,
      flushOnCapture: false,
      persistOffline: {
        storage
      },
      replayPersistedOnInstall: false,
      transport: {
        async send() {
          return { statusCode: 503 };
        }
      }
    });
    await failingContext.transport.send(CLIENT_KEY, storedBody);
    failingContext.uninstall();
    assert.equal(JSON.parse(storage.getItem("logbrew:browser:persisted-batches")).batches.length, 1);

    context.client.log("evt_live_001", "2026-06-22T10:00:00Z", {
      level: "info",
      logger: "browser.lifecycle",
      message: "live queue after offline replay"
    });
    browserWindow.dispatchEvent("online");
    await waitFor(() => sentBodies.length === 3);

    assert.equal(JSON.parse(sentBodies[1]).events[0].id, "evt_persisted_001");
    assert.equal(JSON.parse(sentBodies[2]).events[0].id, "evt_live_001");
    assert.equal(storage.getItem("logbrew:browser:persisted-batches"), null);
    context.uninstall();
  } finally {
    await removeTempDir();
  }
});

test("online recovery skips same-session persisted copies while the live queue still owns them", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const { installLogBrewBrowser } = imported;
  const storage = createMemoryStorage();
  const browserWindow = createFakeBrowserWindow(storage);
  const sentBodies = [];
  let statusCode = 503;
  try {
    const context = installLogBrewBrowser({
      browserWindow,
      capturePageViews: false,
      clientKey: CLIENT_KEY,
      flushOnCapture: false,
      maxRetries: 0,
      persistOffline: {
        storage
      },
      replayPersistedOnInstall: false,
      transport: {
        async send(_apiKey, body) {
          sentBodies.push(body);
          return { statusCode };
        }
      }
    });

    context.client.log("evt_same_session_failed_001", "2026-06-22T10:00:00Z", {
      level: "warning",
      logger: "browser.lifecycle",
      message: "same session failed flush"
    });
    await context.flush().catch((error) => {
      assert.equal(error.code, "transport_error");
    });
    assert.equal(JSON.parse(storage.getItem("logbrew:browser:persisted-batches")).batches.length, 1);

    statusCode = 202;
    context.client.log("evt_same_session_live_001", "2026-06-22T10:00:01Z", {
      level: "info",
      logger: "browser.lifecycle",
      message: "same session live queue"
    });
    browserWindow.dispatchEvent("online");
    await waitFor(() => sentBodies.length === 3);

    assert.equal(sentBodies[0], sentBodies[1]);
    assert.deepEqual(JSON.parse(sentBodies[1]).events.map((event) => event.id), ["evt_same_session_failed_001"]);
    assert.deepEqual(JSON.parse(sentBodies[2]).events.map((event) => event.id), ["evt_same_session_live_001"]);
    assert.equal(storage.getItem("logbrew:browser:persisted-batches"), null);
    context.uninstall();
  } finally {
    await removeTempDir();
  }
});

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

function createFakeBrowserWindow(storage) {
  const listeners = new Map();
  const documentListeners = new Map();
  return {
    document: {
      addEventListener(type, listener) {
        addListener(documentListeners, type, listener);
      },
      removeEventListener(type, listener) {
        removeListener(documentListeners, type, listener);
      },
      visibilityState: "visible"
    },
    localStorage: storage,
    addEventListener(type, listener) {
      addListener(listeners, type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(listeners, type, listener);
    },
    dispatchEvent(type, event = {}) {
      dispatchListeners(listeners, type, event);
    }
  };
}

function addListener(listeners, type, listener) {
  const existing = listeners.get(type) ?? [];
  existing.push(listener);
  listeners.set(type, existing);
}

function removeListener(listeners, type, listener) {
  listeners.set(type, (listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
}

function dispatchListeners(listeners, type, event) {
  for (const listener of listeners.get(type) ?? []) {
    listener(event);
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out waiting for condition");
}
