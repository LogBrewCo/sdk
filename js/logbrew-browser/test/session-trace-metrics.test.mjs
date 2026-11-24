import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const SESSION_ID = /^[0-9a-f]{32}$/u;
const QUEUE = { flushOnCapture: false };

async function importBrowserPackage(entry) {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-session-test-"));
  await mkdir(join(tempDir, "node_modules", "@logbrew"), { recursive: true });
  await cp(resolve(repoRoot, "js/logbrew-js"), join(tempDir, "node_modules", "@logbrew", "sdk"), { recursive: true });
  await cp(resolve(repoRoot, "js/logbrew-browser"), join(tempDir, "node_modules", "@logbrew", "browser"), { recursive: true });
  const entryPath = join(tempDir, "node_modules", "@logbrew", "browser", entry);
  const imported = entry === "index.cjs"
    ? createRequire(import.meta.url)(entryPath)
    : await import(pathToFileURL(entryPath));
  return {
    imported,
    async removeTempDir() {
      await rm(tempDir, { force: true, recursive: true });
    }
  };
}

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value))
  };
}

function createWindow(sessionStorage = createMemoryStorage()) {
  return {
    addEventListener() {},
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" },
    location: { hash: "", href: "https://app.example.test/checkout", pathname: "/checkout", search: "" },
    navigator: {},
    removeEventListener() {},
    sessionStorage
  };
}

function install(imported, browserWindow, options = {}) {
  return imported.installLogBrewBrowser({
    breadcrumbs: false,
    browserWindow,
    clientKey: "LOGBREW_BROWSER_KEY",
    flushOnCapture: false,
    replayPersistedOnInstall: false,
    transport: { send: async () => ({ statusCode: 202 }) },
    ...options
  });
}

function sentEvents(context) {
  return JSON.parse(context.previewJson()).events;
}

for (const entry of ["index.js", "index.cjs"]) {
  test(`browser issues and logs carry the page trace in context.trace in ${entry}`, async () => {
    const { imported, removeTempDir } = await importBrowserPackage(entry);
    try {
      const context = install(imported, createWindow());
      await imported.captureBrowserError({ error: new Error("payment declined"), message: "payment declined", type: "error" }, context, QUEUE);
      await imported.captureBrowserAction({ name: "checkout.clicked" }, context, QUEUE);
      context.client.log("evt_browser_log_test", "2026-11-24T10:00:00Z", { level: "warn", message: "payment step failing" });
      const events = sentEvents(context);
      const pageView = events.find((event) => event.type === "span");
      const expected = { sampled: true, spanId: context.traceContext.spanId, traceId: context.traceContext.traceId };
      assert.equal(pageView.attributes.traceId, context.traceContext.traceId);
      for (const type of ["issue", "log", "action"]) {
        const event = events.find((candidate) => candidate.type === type);
        assert.deepEqual(event.attributes.context.trace, expected, type);
        assert.equal(event.attributes.metadata?.traceId, undefined, type);
        assert.equal(event.attributes.metadata?.traceSampled, undefined, type);
      }
    } finally {
      await removeTempDir();
    }
  });

  test(`every browser event carries one session ID that lasts across reloads in the tab in ${entry}`, async () => {
    const { imported, removeTempDir } = await importBrowserPackage(entry);
    try {
      const tab = createMemoryStorage();
      const first = install(imported, createWindow(tab), { context: { schemaVersion: 1, subject: { id: "user_123", kind: "user" } } });
      await imported.captureBrowserAction({ name: "checkout.clicked" }, first, QUEUE);
      const firstEvents = sentEvents(first);
      const [sessionId] = firstEvents.map((event) => event.attributes.context.session.id);
      assert.match(sessionId, SESSION_ID);
      for (const event of firstEvents) {
        assert.deepEqual(event.attributes.context.session, { id: sessionId });
        assert.deepEqual(event.attributes.context.subject, { id: "user_123", kind: "user" });
      }
      const reloaded = install(imported, createWindow(tab));
      assert.equal(sentEvents(reloaded)[0].attributes.context.session.id, sessionId);
      const otherTab = install(imported, createWindow());
      assert.notEqual(sentEvents(otherTab)[0].attributes.context.session.id, sessionId);
      const off = install(imported, createWindow(tab), { session: false });
      assert.equal(sentEvents(off)[0].attributes.context?.session, undefined);
    } finally {
      await removeTempDir();
    }
  });

  test(`request, page load, and Web Vital timings also arrive as metric events in ${entry}`, async () => {
    const { imported, removeTempDir } = await importBrowserPackage(entry);
    try {
      const context = install(imported, createWindow(), { capturePageViews: false });
      await imported.captureBrowserFetchSpan({ durationMs: 12, method: "GET", statusCode: 503, url: "/api/cart?card=4242" }, context, QUEUE);
      await imported.captureBrowserXhrSpan({ durationMs: 7, method: "POST", statusCode: 201, url: "/api/orders" }, context, QUEUE);
      await imported.captureBrowserNavigationTiming(
        { duration: 80, entryType: "navigation", name: "https://app.example.test/checkout", startTime: 0 },
        context,
        QUEUE
      );
      await imported.captureBrowserWebVital({ name: "LCP", rating: "good", value: 1200 }, context, QUEUE);
      await imported.captureBrowserWebVital({ name: "CLS", rating: "good", value: 0.05 }, context, QUEUE);
      const events = sentEvents(context);
      const metrics = events.filter((event) => event.type === "metric").map((event) => event.attributes);
      const spans = events.filter((event) => event.type === "span");
      assert.equal(spans.length, 5);
      assert.deepEqual(metrics.map(({ kind, name, temporality, unit, value }) => ({ kind, name, temporality, unit, value })), [
        { kind: "histogram", name: "http.client.duration", temporality: "delta", unit: "ms", value: 12 },
        { kind: "histogram", name: "http.client.duration", temporality: "delta", unit: "ms", value: 7 },
        { kind: "histogram", name: "browser.page_load.duration", temporality: "delta", unit: "ms", value: 80 },
        { kind: "histogram", name: "browser.web_vital.lcp", temporality: "delta", unit: "ms", value: 1200 },
        { kind: "histogram", name: "browser.web_vital.cls", temporality: "delta", unit: "1", value: 0.05 }
      ]);
      assert.deepEqual(metrics[0].metadata, { method: "GET", requestPath: "/api/cart", statusCode: 503 });
      assert.equal(metrics[3].metadata.rating, "good");
      for (const metric of metrics) {
        assert.equal(metric.context.trace.traceId, context.traceContext.traceId);
        assert.match(metric.context.session.id, SESSION_ID);
      }
    } finally {
      await removeTempDir();
    }
  });
}

test("2 identical browser errors get different event IDs", async () => {
  const { imported, removeTempDir } = await importBrowserPackage("index.js");
  try {
    const context = install(imported, createWindow(), { capturePageViews: false });
    const error = { error: new Error("payment declined"), message: "payment declined", type: "error" };
    await imported.captureBrowserError(error, context, QUEUE);
    await imported.captureBrowserError(error, context, QUEUE);
    const [first, second] = sentEvents(context);
    assert.notEqual(first.id, second.id);
    assert.match(imported.createAutomaticBrowserEventId("evt_vue_error", "Checkout failed"), /^evt_vue_error_checkout_failed_[0-9a-f]{32}$/u);
  } finally {
    await removeTempDir();
  }
});
