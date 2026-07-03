import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_KEY = "LOGBREW_BROWSER_KEY";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";
const CHILD_SPAN_ID = "7777777777777777";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-resource-test-"));
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

test("installed browser resource timing capture emits a sanitized child span", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    captureBrowserResourceTiming,
    createBrowserTraceContext,
    installLogBrewBrowser
  } = imported;
  try {
    assert.equal(typeof captureBrowserResourceTiming, "function");
    const browserWindow = createFakeBrowserWindow("https://app.example.test/checkout?email=dev@example.test#step2");
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

    await captureBrowserResourceTiming(createResourceEntry(), context, {
      flushOnCapture: false,
      metadata: {
        feature: "checkout",
        nestedDropped: { value: "private" }
      },
      now: () => "2026-07-04T09:00:00.000Z",
      randomValues: () => fillBytes(8, 0x77),
      resourcePathTemplate: "/api/orders/:id"
    });

    const payload = JSON.parse(context.previewJson());
    assert.equal(payload.events.length, 1);
    const [event] = payload.events;
    assert.equal(event.type, "span");
    assert.equal(event.attributes.name, "browser.resource fetch /api/orders/:id");
    assert.equal(event.attributes.traceId, TRACE_ID);
    assert.equal(event.attributes.parentSpanId, PARENT_SPAN_ID);
    assert.equal(event.attributes.spanId, CHILD_SPAN_ID);
    assert.equal(event.attributes.status, "error");
    assert.equal(event.attributes.durationMs, 120);
    assert.equal(event.attributes.metadata.source, "browser.resource");
    assert.equal(event.attributes.metadata.path, "/checkout");
    assert.equal(event.attributes.metadata.resourcePath, "/api/orders/:id");
    assert.equal(event.attributes.metadata.initiatorType, "fetch");
    assert.equal(event.attributes.metadata.statusCode, 503);
    assert.equal(event.attributes.metadata.transferSize, 1024);
    assert.equal(event.attributes.metadata.encodedBodySize, 900);
    assert.equal(event.attributes.metadata.decodedBodySize, 1200);
    assert.equal(event.attributes.metadata.redirectMs, 5);
    assert.equal(event.attributes.metadata.lookupMs, 5);
    assert.equal(event.attributes.metadata.connectMs, 18);
    assert.equal(event.attributes.metadata.tlsMs, 15);
    assert.equal(event.attributes.metadata.requestMs, 40);
    assert.equal(event.attributes.metadata.responseMs, 50);
    assert.equal(event.attributes.metadata.feature, "checkout");
    assert.equal(event.attributes.metadata.nestedDropped, undefined);
    assert.equal(JSON.stringify(event).includes("api.example.test"), false);
    assert.equal(JSON.stringify(event).includes("email=dev@example.test"), false);
    assert.equal(JSON.stringify(event).includes("#step2"), false);
    assert.equal(event.attributes.metadata.traceparent, undefined);
  } finally {
    await removeTempDir();
  }
});

test("installed browser resource timing instrumentation is opt-in and reversible", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    installLogBrewBrowser,
    installLogBrewBrowserResourceTimingInstrumentation
  } = imported;
  try {
    assert.equal(typeof installLogBrewBrowserResourceTimingInstrumentation, "function");
    const browserWindow = createFakeBrowserWindow("https://app.example.test/account?draft=1");
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
    const fakeObserver = createFakePerformanceObserver();

    const instrumentation = installLogBrewBrowserResourceTimingInstrumentation(context, {
      flushOnCapture: false,
      now: () => "2026-07-04T09:01:00.000Z",
      performanceObserver: fakeObserver.PerformanceObserver,
      randomValues: () => fillBytes(8, 0x55),
      resourcePathTemplate: ({ path }) => path.replace(/\/\d+$/u, "/:id")
    });

    assert.deepEqual(fakeObserver.observedOptions(), { buffered: true, type: "resource" });
    fakeObserver.emit([createResourceEntry(), { entryType: "mark", name: "not-a-resource" }]);
    instrumentation.uninstall();
    assert.equal(fakeObserver.disconnected(), true);

    const payload = JSON.parse(context.previewJson());
    const resourceSpans = payload.events.filter((event) => event.type === "span");
    assert.equal(resourceSpans.length, 1);
    assert.equal(resourceSpans[0].attributes.name, "browser.resource fetch /api/orders/:id");
    assert.equal(resourceSpans[0].attributes.metadata.resourcePath, "/api/orders/:id");
    assert.equal(JSON.stringify(resourceSpans[0]).includes("sample=private"), false);
  } finally {
    await removeTempDir();
  }
});

function createResourceEntry() {
  return {
    connectEnd: 40,
    connectStart: 22,
    decodedBodySize: 1200,
    domainLookupEnd: 20,
    domainLookupStart: 15,
    duration: 120,
    encodedBodySize: 900,
    entryType: "resource",
    fetchStart: 10,
    initiatorType: "fetch",
    name: "https://api.example.test/api/orders/123?sample=private#fragment",
    redirectEnd: 10,
    redirectStart: 5,
    requestStart: 40,
    responseEnd: 130,
    responseStart: 80,
    secureConnectionStart: 25,
    startTime: 10,
    transferSize: 1024,
    workerStart: 0,
    responseStatus: 503
  };
}

function createFakeBrowserWindow(href) {
  const currentUrl = new URL(href);
  return {
    addEventListener() {},
    document: {
      addEventListener() {},
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
    removeEventListener() {}
  };
}

function createFakePerformanceObserver() {
  let callback;
  let disconnected = false;
  let observedOptions;
  return {
    PerformanceObserver: class FakePerformanceObserver {
      constructor(nextCallback) {
        callback = nextCallback;
      }

      disconnect() {
        disconnected = true;
      }

      observe(nextObservedOptions) {
        observedOptions = nextObservedOptions;
      }
    },
    disconnected() {
      return disconnected;
    },
    emit(entries) {
      callback?.({
        getEntries() {
          return entries;
        }
      });
    },
    observedOptions() {
      return observedOptions;
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
