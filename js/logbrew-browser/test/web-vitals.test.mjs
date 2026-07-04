import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_KEY = "LOGBREW_BROWSER_KEY";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";
const CHILD_SPAN_ID = "8888888888888888";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-web-vitals-test-"));
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

test("installed browser Web Vital capture emits a sanitized trace-linked child span", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    captureBrowserWebVital,
    createBrowserTraceContext,
    installLogBrewBrowser
  } = imported;
  try {
    assert.equal(typeof captureBrowserWebVital, "function");
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

    await captureBrowserWebVital(createLcpMetric(), context, {
      flushOnCapture: false,
      metadata: {
        feature: "catalog",
        nestedDropped: { value: "masked" }
      },
      now: () => "2026-07-04T13:00:00.000Z",
      randomValues: () => fillBytes(8, 0x88),
      webVitalPathTemplate: "/products/:id"
    });

    const payload = JSON.parse(context.previewJson());
    assert.equal(payload.events.length, 1);
    const [event] = payload.events;
    assert.equal(event.type, "span");
    assert.equal(event.attributes.name, "browser.web_vital LCP /products/:id");
    assert.equal(event.attributes.traceId, TRACE_ID);
    assert.equal(event.attributes.parentSpanId, PARENT_SPAN_ID);
    assert.equal(event.attributes.spanId, CHILD_SPAN_ID);
    assert.equal(event.attributes.status, "ok");
    assert.equal(event.attributes.durationMs, 2480.456);
    assert.equal(event.attributes.metadata.source, "browser.web_vital");
    assert.equal(event.attributes.metadata.path, "/products/42");
    assert.equal(event.attributes.metadata.metricName, "LCP");
    assert.equal(event.attributes.metadata.metricValue, 2480.456);
    assert.equal(event.attributes.metadata.metricUnit, "millisecond");
    assert.equal(event.attributes.metadata.rating, "needs-improvement");
    assert.equal(event.attributes.metadata.navigationType, "navigate");
    assert.equal(event.attributes.metadata.metricId, "v4-123");
    assert.equal(event.attributes.metadata.delta, 120.25);
    assert.equal(event.attributes.metadata.loadState, "dom-interactive");
    assert.equal(event.attributes.metadata.timeToFirstByteMs, 121.5);
    assert.equal(event.attributes.metadata.resourceLoadDelayMs, 25);
    assert.equal(event.attributes.metadata.resourceLoadDurationMs, 175.125);
    assert.equal(event.attributes.metadata.elementRenderDelayMs, 40);
    assert.equal(event.attributes.metadata.feature, "catalog");
    assert.equal(event.attributes.metadata.nestedDropped, undefined);
    assert.equal(event.attributes.metadata.element, undefined);
    assert.equal(event.attributes.metadata.interactionTarget, undefined);
    assert.equal(event.attributes.metadata.largestShiftTarget, undefined);
    assert.equal(event.attributes.metadata.entries, undefined);
    assert.equal(JSON.stringify(event).includes("app.example.test"), false);
    assert.equal(JSON.stringify(event).includes("cdn.example.test"), false);
    assert.equal(JSON.stringify(event).includes("email=dev@example.test"), false);
    assert.equal(JSON.stringify(event).includes("#reviews"), false);
    assert.equal(JSON.stringify(event).includes("button.checkout"), false);
    assert.equal(JSON.stringify(event).includes("hero.jpg"), false);
  } finally {
    await removeTempDir();
  }
});

test("installed browser Web Vitals instrumentation registers app-owned callbacks and stops capture after uninstall", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    createBrowserTraceContext,
    installLogBrewBrowser,
    installLogBrewBrowserWebVitalsInstrumentation
  } = imported;
  try {
    assert.equal(typeof installLogBrewBrowserWebVitalsInstrumentation, "function");
    const browserWindow = createFakeBrowserWindow("https://app.example.test/checkout?sample=private#pay");
    const callbacks = {};
    const unregistered = [];
    const webVitals = {
      onCLS(callback) {
        callbacks.CLS = callback;
        return () => unregistered.push("CLS");
      },
      onLCP(callback) {
        callbacks.LCP = callback;
        return () => unregistered.push("LCP");
      }
    };
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

    const instrumentation = installLogBrewBrowserWebVitalsInstrumentation(context, {
      flushOnCapture: false,
      metricNames: ["LCP", "CLS"],
      now: () => "2026-07-04T13:01:00.000Z",
      randomValues: sequenceRandomValues([
        fillBytes(8, 0x11),
        fillBytes(8, 0x22)
      ]),
      webVitalPathTemplate: "/checkout",
      webVitals
    });

    callbacks.LCP(createLcpMetric());
    callbacks.CLS({
      attribution: {
        largestShiftTarget: "main form",
        loadState: "complete"
      },
      delta: 0.02,
      id: "v4-cls",
      name: "CLS",
      navigationType: "navigate",
      rating: "poor",
      value: 0.12345
    });
    instrumentation.uninstall();
    callbacks.LCP({ ...createLcpMetric(), id: "after-uninstall" });

    const payload = JSON.parse(context.previewJson());
    const spans = payload.events.filter((event) => event.type === "span");
    assert.equal(spans.length, 2);
    assert.equal(spans[0].attributes.name, "browser.web_vital LCP /checkout");
    assert.equal(spans[0].attributes.spanId, "1111111111111111");
    assert.equal(spans[1].attributes.name, "browser.web_vital CLS /checkout");
    assert.equal(spans[1].attributes.spanId, "2222222222222222");
    assert.equal(spans[1].attributes.durationMs, undefined);
    assert.equal(spans[1].attributes.metadata.metricUnit, "score");
    assert.equal(spans[1].attributes.metadata.metricValue, 0.1235);
    assert.equal(spans[1].attributes.metadata.largestShiftTarget, undefined);
    assert.deepEqual(unregistered.sort(), ["CLS", "LCP"]);
    assert.equal(JSON.stringify(payload).includes("after-uninstall"), false);
    assert.equal(JSON.stringify(payload).includes("sample=private"), false);
  } finally {
    await removeTempDir();
  }
});

function createLcpMetric() {
  return {
    attribution: {
      element: "img.hero",
      elementRenderDelay: 40,
      interactionTarget: "button.checkout",
      interactionTargetElement: { tagName: "BUTTON" },
      loadState: "dom-interactive",
      nestedDropped: { private: true },
      resourceLoadDelay: 25,
      resourceLoadDuration: 175.125,
      timeToFirstByte: 121.5,
      url: "https://cdn.example.test/assets/hero.jpg?asset=masked"
    },
    delta: 120.25,
    entries: [{
      element: { tagName: "IMG" },
      entryType: "largest-contentful-paint",
      url: "https://cdn.example.test/assets/hero.jpg?asset=masked"
    }],
    id: "v4-123",
    name: "LCP",
    navigationType: "navigate",
    rating: "needs-improvement",
    value: 2480.456
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

function sequenceRandomValues(values) {
  let index = 0;
  return () => {
    if (index >= values.length) {
      return values[values.length - 1];
    }
    const nextValue = values[index];
    index += 1;
    return nextValue;
  };
}
