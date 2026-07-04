import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_KEY = "LOGBREW_BROWSER_KEY";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";
const CHILD_SPAN_ID = "3333333333333333";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-navigation-test-"));
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

test("installed browser navigation timing capture emits a sanitized document-load child span", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    captureBrowserNavigationTiming,
    createBrowserTraceContext,
    installLogBrewBrowser
  } = imported;
  try {
    assert.equal(typeof captureBrowserNavigationTiming, "function");
    const browserWindow = createFakeBrowserWindow("https://app.example.test/products/42?email=dev@example.test#reviews");
    const context = installLogBrewBrowser({
      browserWindow,
      capturePageViews: false,
      clientKey: CLIENT_KEY,
      flushOnCapture: false,
      traceContext: createBrowserTraceContext({
        sampled: true,
        spanId: PARENT_SPAN_ID,
        traceId: TRACE_ID
      }),
      transport: {
        async send() {
          return { statusCode: 202 };
        }
      }
    });

    await captureBrowserNavigationTiming(createNavigationEntry(), context, {
      flushOnCapture: false,
      metadata: {
        feature: "catalog",
        nestedDropped: { value: "masked" }
      },
      navigationPathTemplate: "/products/:id",
      now: () => "2026-07-04T12:00:00.000Z",
      randomValues: () => fillBytes(8, 0x33)
    });

    const payload = JSON.parse(context.previewJson());
    assert.equal(payload.events.length, 1);
    const [event] = payload.events;
    assert.equal(event.type, "span");
    assert.equal(event.attributes.name, "browser.document /products/:id");
    assert.equal(event.attributes.traceId, TRACE_ID);
    assert.equal(event.attributes.parentSpanId, PARENT_SPAN_ID);
    assert.equal(event.attributes.spanId, CHILD_SPAN_ID);
    assert.equal(event.attributes.status, "ok");
    assert.equal(event.attributes.durationMs, 384.123);
    assert.equal(event.attributes.metadata.source, "browser.document");
    assert.equal(event.attributes.metadata.path, "/products/42");
    assert.equal(event.attributes.metadata.documentPath, "/products/:id");
    assert.equal(event.attributes.metadata.navigationType, "navigate");
    assert.equal(event.attributes.metadata.responseStatus, 200);
    assert.equal(event.attributes.metadata.redirectCount, 2);
    assert.equal(event.attributes.metadata.activationStartMs, 7);
    assert.equal(event.attributes.metadata.firstByteMs, 120);
    assert.equal(event.attributes.metadata.redirectMs, 10);
    assert.equal(event.attributes.metadata.workerMs, 5);
    assert.equal(event.attributes.metadata.fetchMs, 10);
    assert.equal(event.attributes.metadata.lookupMs, 20);
    assert.equal(event.attributes.metadata.connectMs, 30);
    assert.equal(event.attributes.metadata.tlsMs, 20);
    assert.equal(event.attributes.metadata.requestMs, 40);
    assert.equal(event.attributes.metadata.responseMs, 150);
    assert.equal(event.attributes.metadata.domInteractiveMs, 270);
    assert.equal(event.attributes.metadata.domContentLoadedMs, 310);
    assert.equal(event.attributes.metadata.domContentLoadedEventMs, 8);
    assert.equal(event.attributes.metadata.domCompleteMs, 360);
    assert.equal(event.attributes.metadata.loadEventMs, 384.123);
    assert.equal(event.attributes.metadata.loadEventDurationMs, 4.123);
    assert.equal(event.attributes.metadata.transferSize, 4096);
    assert.equal(event.attributes.metadata.encodedBodySize, 2048);
    assert.equal(event.attributes.metadata.decodedBodySize, 8192);
    assert.equal(event.attributes.metadata.feature, "catalog");
    assert.equal(event.attributes.metadata.nestedDropped, undefined);
    assert.equal(JSON.stringify(event).includes("app.example.test"), false);
    assert.equal(JSON.stringify(event).includes("email=dev@example.test"), false);
    assert.equal(JSON.stringify(event).includes("#reviews"), false);
    assert.equal(JSON.stringify(event).includes("serverTiming"), false);
  } finally {
    await removeTempDir();
  }
});

test("installed browser navigation timing instrumentation waits for load and captures once", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    installLogBrewBrowser,
    installLogBrewBrowserNavigationTimingInstrumentation
  } = imported;
  try {
    assert.equal(typeof installLogBrewBrowserNavigationTimingInstrumentation, "function");
    const browserWindow = createFakeBrowserWindow("https://app.example.test/profile/123?sample=masked", {
      readyState: "loading"
    });
    browserWindow.performance = {
      getEntriesByType(type) {
        return type === "navigation" ? [createNavigationEntry({
          name: "https://app.example.test/profile/123?sample=masked"
        })] : [];
      }
    };
    const context = installLogBrewBrowser({
      browserWindow,
      capturePageViews: false,
      clientKey: CLIENT_KEY,
      flushOnCapture: false,
      transport: {
        async send() {
          return { statusCode: 202 };
        }
      }
    });

    const instrumentation = installLogBrewBrowserNavigationTimingInstrumentation(context, {
      flushOnCapture: false,
      navigationPathTemplate({ path }) {
        return path.replace(/\/\d+$/u, "/:id");
      },
      now: () => "2026-07-04T12:01:00.000Z",
      randomValues: () => fillBytes(8, 0x44)
    });

    assert.equal(JSON.parse(context.previewJson()).events.length, 0);
    browserWindow.dispatchEvent({ type: "load" });
    browserWindow.runTimers();
    instrumentation.uninstall();

    const payload = JSON.parse(context.previewJson());
    assert.equal(payload.events.length, 1);
    const [event] = payload.events;
    assert.equal(event.attributes.name, "browser.document /profile/:id");
    assert.equal(event.attributes.metadata.documentPath, "/profile/:id");
    assert.equal(event.attributes.metadata.path, "/profile/123");
    assert.equal(event.attributes.metadata.traceId, undefined);
    assert.equal(JSON.stringify(event).includes("sample=masked"), false);
    assert.equal(browserWindow.removedLoadListeners, 1);
  } finally {
    await removeTempDir();
  }
});

function createNavigationEntry(overrides = {}) {
  return {
    activationStart: 7,
    connectEnd: 70,
    connectStart: 40,
    decodedBodySize: 8192,
    domComplete: 360,
    domContentLoadedEventEnd: 310,
    domContentLoadedEventStart: 302,
    domInteractive: 270,
    domainLookupEnd: 40,
    domainLookupStart: 20,
    duration: 384.123,
    encodedBodySize: 2048,
    entryType: "navigation",
    fetchStart: 10,
    initiatorType: "navigation",
    loadEventEnd: 384.123,
    loadEventStart: 380,
    name: "https://app.example.test/products/42?email=dev@example.test#reviews",
    redirectCount: 2,
    redirectEnd: 10,
    redirectStart: 0,
    requestStart: 80,
    responseEnd: 270,
    responseStart: 120,
    responseStatus: 200,
    secureConnectionStart: 50,
    startTime: 0,
    transferSize: 4096,
    type: "navigate",
    workerStart: 5,
    ...overrides,
    serverTiming: [{ name: "sensitive", duration: 123 }]
  };
}

function createFakeBrowserWindow(href, { readyState = "complete" } = {}) {
  const currentUrl = new URL(href);
  const windowListeners = new Map();
  const timers = [];
  return {
    removedLoadListeners: 0,
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    dispatchEvent(event) {
      windowListeners.get(event.type)?.(event);
    },
    document: {
      addEventListener() {},
      readyState,
      removeEventListener() {},
      visibilityState: "visible"
    },
    localStorage: createMemoryStorage(),
    location: {
      hash: currentUrl.hash,
      href: currentUrl.href,
      pathname: currentUrl.pathname,
      search: currentUrl.search,
      toString() {
        return currentUrl.href;
      }
    },
    performance: {
      getEntriesByType() {
        return [];
      }
    },
    removeEventListener(type, listener) {
      if (type === "load" && windowListeners.get(type) === listener) {
        this.removedLoadListeners += 1;
        windowListeners.delete(type);
      }
    },
    runTimers() {
      while (timers.length > 0) {
        timers.shift()();
      }
    },
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
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

function fillBytes(length, value) {
  return Array.from({ length }, () => value);
}
