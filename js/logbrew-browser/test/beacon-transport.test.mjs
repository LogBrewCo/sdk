import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_KEY = "LOGBREW_BROWSER_KEY";
const ENDPOINT = "http://127.0.0.1:4318/api/telemetry/ingest/browser-beacon";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-beacon-test-"));
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

test("beacon transport queues a headerless browser beacon envelope with the client key only in the body", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const { createBeaconTransport } = imported;
  const beaconCalls = [];
  try {
    const transport = createBeaconTransport({
      endpoint: ENDPOINT,
      sendBeacon(_endpoint, payload) {
        beaconCalls.push({ endpoint: _endpoint, payload });
        return true;
      }
    });
    const response = await transport.send(CLIENT_KEY, bodyWithEvent("evt_beacon_001"));
    const payload = await readPayload(beaconCalls[0].payload);

    assert.deepEqual(response, { statusCode: 202, attempts: 1, queued: true });
    assert.equal(beaconCalls[0].endpoint, ENDPOINT);
    assert.equal(payload.ingest_key, CLIENT_KEY);
    assert.equal(payload.envelope.events[0].id, "evt_beacon_001");
    assert.equal(JSON.stringify(payload).includes("authorization"), false);
  } finally {
    await removeTempDir();
  }
});

test("beacon transport falls back to fetch when beacon is refused, unavailable, or oversized", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const { createBeaconTransport } = imported;
  const fetchCalls = [];
  try {
    const fetchImpl = async (url, init) => {
      fetchCalls.push({ url, init });
      const status = fetchCalls.length === 1 ? 429 : 202;
      return {
        headers: new Map(status === 429 ? [["retry-after", "7"]] : []),
        status
      };
    };
    const refusedTransport = createBeaconTransport({
      endpoint: ENDPOINT,
      fetchImpl,
      sendBeacon() {
        return false;
      }
    });
    const oversizedTransport = createBeaconTransport({
      endpoint: ENDPOINT,
      fetchImpl,
      maxBeaconBodyBytes: 16,
      sendBeacon() {
        throw new Error("oversized payload should not call sendBeacon");
      }
    });

    const refusedResponse = await refusedTransport.send(CLIENT_KEY, bodyWithEvent("evt_refused_001"));
    const oversizedResponse = await oversizedTransport.send(CLIENT_KEY, bodyWithEvent("evt_oversized_001"));
    const refusedPayload = JSON.parse(fetchCalls[0].init.body);
    const oversizedPayload = JSON.parse(fetchCalls[1].init.body);

    assert.deepEqual(refusedResponse, { statusCode: 429, attempts: 1, retryAfterMs: 7000, queued: false });
    assert.deepEqual(oversizedResponse, { statusCode: 202, attempts: 1, queued: false });
    assert.equal(fetchCalls[0].url, ENDPOINT);
    assert.equal(fetchCalls[0].init.method, "POST");
    assert.equal(fetchCalls[0].init.keepalive, true);
    assert.equal(fetchCalls[0].init.headers.authorization, undefined);
    assert.equal(fetchCalls[0].init.headers["content-type"], "application/json");
    assert.equal(refusedPayload.ingest_key, CLIENT_KEY);
    assert.equal(refusedPayload.envelope.events[0].id, "evt_refused_001");
    assert.equal(fetchCalls[1].init.keepalive, false);
    assert.equal(oversizedPayload.envelope.events[0].id, "evt_oversized_001");
  } finally {
    await removeTempDir();
  }
});

test("persistent browser transport never stores client keys before beacon send", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const { createBeaconTransport, createPersistentBrowserTransport } = imported;
  const storage = createMemoryStorage();
  try {
    const transport = createPersistentBrowserTransport({
      storage,
      transport: createBeaconTransport({
        endpoint: ENDPOINT,
        fetchImpl: async () => ({ headers: new Map(), status: 503 }),
        sendBeacon() {
          return false;
        }
      })
    });

    await transport.send(CLIENT_KEY, bodyWithEvent("evt_persisted_beacon_001")).catch((error) => {
      assert.equal(error.code, "transport_error");
    });

    const stored = storage.getItem("logbrew:browser:persisted-batches");
    assert.equal(stored.includes(CLIENT_KEY), false);
    assert.equal(stored.includes("evt_persisted_beacon_001"), true);
  } finally {
    await removeTempDir();
  }
});

function bodyWithEvent(id) {
  return JSON.stringify({
    events: [{ id, type: "log" }],
    sdk: { name: "logbrew-browser", version: "0.1.0" }
  });
}

async function readPayload(payload) {
  if (payload && typeof payload.text === "function") {
    return JSON.parse(await payload.text());
  }
  return JSON.parse(String(payload));
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
