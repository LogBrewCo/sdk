import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_KEY = "LOGBREW_BROWSER_KEY";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-interaction-test-"));
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

test("installed browser interaction timing capture emits sanitized trace-linked spans", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    captureBrowserInteractionTiming,
    createBrowserTraceContext,
    installLogBrewBrowser
  } = imported;
  try {
    assert.equal(typeof captureBrowserInteractionTiming, "function");
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

    await captureBrowserInteractionTiming(createClickEventTimingEntry(), context, {
      flushOnCapture: false,
      interactionPathTemplate: "/products/:id",
      metadata: {
        feature: "catalog",
        nestedDropped: { value: "private" }
      },
      now: () => "2026-07-04T16:00:00.000Z",
      randomValues: sequenceRandomValues([
        fillBytes(8, 0x33),
        fillBytes(8, 0x44)
      ])
    });
    await captureBrowserInteractionTiming(createLongTaskEntry(), context, {
      flushOnCapture: false,
      interactionPathTemplate: "/products/:id",
      now: () => "2026-07-04T16:00:01.000Z",
      randomValues: sequenceRandomValues([
        fillBytes(8, 0x44)
      ])
    });
    await captureBrowserInteractionTiming(createLongAnimationFrameEntry(), context, {
      flushOnCapture: false,
      interactionPathTemplate: "/products/:id",
      now: () => "2026-07-04T16:00:02.000Z",
      randomValues: sequenceRandomValues([
        fillBytes(8, 0x55)
      ])
    });

    const payload = JSON.parse(context.previewJson());
    assert.equal(payload.events.length, 3);
    const [interactionSpan, longTaskSpan, longAnimationFrameSpan] = payload.events;
    assert.equal(interactionSpan.type, "span");
    assert.equal(interactionSpan.attributes.name, "browser.interaction click /products/:id");
    assert.equal(interactionSpan.attributes.traceId, TRACE_ID);
    assert.equal(interactionSpan.attributes.parentSpanId, PARENT_SPAN_ID);
    assert.equal(interactionSpan.attributes.spanId, "3333333333333333");
    assert.equal(interactionSpan.attributes.durationMs, 128);
    assert.equal(interactionSpan.attributes.metadata.source, "browser.interaction");
    assert.equal(interactionSpan.attributes.metadata.entryType, "event");
    assert.equal(interactionSpan.attributes.metadata.interactionType, "click");
    assert.equal(interactionSpan.attributes.metadata.interactionId, 91);
    assert.equal(interactionSpan.attributes.metadata.inputDelayMs, 20);
    assert.equal(interactionSpan.attributes.metadata.processingDurationMs, 55);
    assert.equal(interactionSpan.attributes.metadata.presentationDelayMs, 53);
    assert.equal(interactionSpan.attributes.metadata.path, "/products/42");
    assert.equal(interactionSpan.attributes.metadata.interactionPath, "/products/:id");
    assert.equal(interactionSpan.attributes.metadata.feature, "catalog");
    assert.equal(interactionSpan.attributes.metadata.nestedDropped, undefined);
    assert.equal(interactionSpan.attributes.metadata.target, undefined);
    assert.equal(interactionSpan.attributes.metadata.selector, undefined);
    assert.equal(interactionSpan.attributes.metadata.element, undefined);
    assert.equal(JSON.stringify(interactionSpan).includes("button.checkout"), false);

    assert.equal(longTaskSpan.attributes.name, "browser.long_task /products/:id");
    assert.equal(longTaskSpan.attributes.traceId, TRACE_ID);
    assert.equal(longTaskSpan.attributes.parentSpanId, PARENT_SPAN_ID);
    assert.equal(longTaskSpan.attributes.spanId, "4444444444444444");
    assert.equal(longTaskSpan.attributes.durationMs, 72.5);
    assert.equal(longTaskSpan.attributes.metadata.source, "browser.interaction");
    assert.equal(longTaskSpan.attributes.metadata.entryType, "longtask");
    assert.equal(longTaskSpan.attributes.metadata.taskName, "self");
    assert.equal(longTaskSpan.attributes.metadata.attribution, undefined);
    assert.equal(longTaskSpan.attributes.metadata.scripts, undefined);
    assert.equal(longAnimationFrameSpan.attributes.name, "browser.long_animation_frame /products/:id");
    assert.equal(longAnimationFrameSpan.attributes.traceId, TRACE_ID);
    assert.equal(longAnimationFrameSpan.attributes.parentSpanId, PARENT_SPAN_ID);
    assert.equal(longAnimationFrameSpan.attributes.spanId, "5555555555555555");
    assert.equal(longAnimationFrameSpan.attributes.durationMs, 120);
    assert.equal(longAnimationFrameSpan.attributes.metadata.entryType, "long-animation-frame");
    assert.equal(longAnimationFrameSpan.attributes.metadata.blockingDurationMs, 45);
    assert.equal(longAnimationFrameSpan.attributes.metadata.firstUIEventTimestampMs, 640);
    assert.equal(longAnimationFrameSpan.attributes.metadata.renderStartMs, 650);
    assert.equal(longAnimationFrameSpan.attributes.metadata.styleAndLayoutStartMs, 675);
    assert.equal(longAnimationFrameSpan.attributes.metadata.scriptCount, 2);
    assert.equal(longAnimationFrameSpan.attributes.metadata.scriptTotalDurationMs, 53);
    assert.equal(longAnimationFrameSpan.attributes.metadata.scriptMaxDurationMs, 40);
    assert.equal(longAnimationFrameSpan.attributes.metadata.scriptTotalPauseDurationMs, 5);
    assert.equal(longAnimationFrameSpan.attributes.metadata.scriptTotalForcedStyleAndLayoutDurationMs, 8);
    assert.equal(longAnimationFrameSpan.attributes.metadata.sourceURL, undefined);
    assert.equal(longAnimationFrameSpan.attributes.metadata.sourceFunctionName, undefined);
    assert.equal(longAnimationFrameSpan.attributes.metadata.invoker, undefined);
    assert.equal(JSON.stringify(longAnimationFrameSpan).includes("https://cdn.example.test/app.js"), false);
    assert.equal(JSON.stringify(longAnimationFrameSpan).includes("renderCheckout"), false);
    assert.equal(JSON.stringify(payload).includes("app.example.test"), false);
    assert.equal(JSON.stringify(payload).includes("email=dev@example.test"), false);
    assert.equal(JSON.stringify(payload).includes("#reviews"), false);
    assert.equal(JSON.stringify(payload).includes("https://cdn.example.test/app.js"), false);
  } finally {
    await removeTempDir();
  }
});

test("installed browser interaction timing instrumentation prefers long animation frames when supported", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    installLogBrewBrowser,
    installLogBrewBrowserInteractionTimingInstrumentation
  } = imported;
  try {
    const browserWindow = createFakeBrowserWindow("https://app.example.test/editor?sample=private#timeline");
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
    const fakeObserver = createFakePerformanceObserver(["event", "long-animation-frame", "longtask"]);

    const instrumentation = installLogBrewBrowserInteractionTimingInstrumentation(context, {
      flushOnCapture: false,
      interactionPathTemplate: "/editor",
      now: () => "2026-07-04T16:02:00.000Z",
      performanceObserver: fakeObserver.PerformanceObserver,
      randomValues: sequenceRandomValues([
        fillBytes(8, 0xaa),
        fillBytes(8, 0xbb)
      ])
    });

    assert.deepEqual(fakeObserver.observedOptions(), [
      { buffered: true, durationThreshold: 40, type: "event" },
      { buffered: true, type: "long-animation-frame" }
    ]);
    fakeObserver.emit([createClickEventTimingEntry(), createLongAnimationFrameEntry(), createLongTaskEntry()]);
    instrumentation.uninstall();

    const payload = JSON.parse(context.previewJson());
    const spans = payload.events.filter((event) => event.type === "span");
    assert.equal(spans.length, 2);
    assert.equal(spans[0].attributes.name, "browser.interaction click /editor");
    assert.equal(spans[0].attributes.spanId, "aaaaaaaaaaaaaaaa");
    assert.equal(spans[1].attributes.name, "browser.long_animation_frame /editor");
    assert.equal(spans[1].attributes.spanId, "bbbbbbbbbbbbbbbb");
    assert.equal(spans[1].attributes.metadata.entryType, "long-animation-frame");
    assert.equal(JSON.stringify(payload).includes("sample=private"), false);
    assert.equal(JSON.stringify(payload).includes("renderCheckout"), false);
  } finally {
    await removeTempDir();
  }
});

test("installed browser interaction timing instrumentation observes event and longtask entries and disconnects", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    installLogBrewBrowser,
    installLogBrewBrowserInteractionTimingInstrumentation
  } = imported;
  try {
    assert.equal(typeof installLogBrewBrowserInteractionTimingInstrumentation, "function");
    const browserWindow = createFakeBrowserWindow("https://app.example.test/checkout?sample=private#pay");
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

    const instrumentation = installLogBrewBrowserInteractionTimingInstrumentation(context, {
      flushOnCapture: false,
      interactionPathTemplate: "/checkout",
      now: () => "2026-07-04T16:01:00.000Z",
      performanceObserver: fakeObserver.PerformanceObserver,
      randomValues: sequenceRandomValues([
        fillBytes(8, 0x11),
        fillBytes(8, 0x22)
      ])
    });

    assert.deepEqual(fakeObserver.observedOptions(), [
      { buffered: true, durationThreshold: 40, type: "event" },
      { buffered: true, type: "longtask" }
    ]);
    fakeObserver.emit([createClickEventTimingEntry(), createLongTaskEntry(), { entryType: "resource", name: "ignored" }]);
    instrumentation.uninstall();
    assert.equal(fakeObserver.disconnectedCount(), 2);
    fakeObserver.emit([createClickEventTimingEntry()]);

    const payload = JSON.parse(context.previewJson());
    const spans = payload.events.filter((event) => event.type === "span");
    assert.equal(spans.length, 2);
    assert.equal(spans[0].attributes.name, "browser.interaction click /checkout");
    assert.equal(spans[0].attributes.spanId, "1111111111111111");
    assert.equal(spans[1].attributes.name, "browser.long_task /checkout");
    assert.equal(spans[1].attributes.spanId, "2222222222222222");
    assert.equal(JSON.stringify(payload).includes("sample=private"), false);
  } finally {
    await removeTempDir();
  }
});

function createClickEventTimingEntry() {
  return {
    duration: 128,
    entryType: "event",
    interactionId: 91,
    name: "click",
    processingEnd: 275,
    processingStart: 220,
    startTime: 200,
    target: {
      id: "checkout",
      tagName: "BUTTON",
      textContent: "button.checkout"
    }
  };
}

function createLongTaskEntry() {
  return {
    attribution: [{
      containerName: "iframe-private",
      containerSrc: "https://cdn.example.test/app.js?sample=masked",
      entryType: "taskattribution",
      name: "script"
    }],
    duration: 72.5,
    entryType: "longtask",
    name: "self",
    startTime: 500
  };
}

function createLongAnimationFrameEntry() {
  return {
    blockingDuration: 45,
    duration: 120,
    entryType: "long-animation-frame",
    firstUIEventTimestamp: 640,
    name: "long-animation-frame",
    renderStart: 650,
    scripts: [
      {
        duration: 40,
        executionStart: 620,
        forcedStyleAndLayoutDuration: 6,
        invoker: "DOMWindow.onclick",
        invokerType: "event-listener",
        pauseDuration: 3,
        sourceCharPosition: 120,
        sourceFunctionName: "renderCheckout",
        sourceURL: "https://cdn.example.test/app.js?sample=masked",
        startTime: 615,
        windowAttribution: "self"
      },
      {
        duration: 13,
        forcedStyleAndLayoutDuration: 2,
        invoker: "timer",
        pauseDuration: 2,
        sourceFunctionName: "hydratePrivateWidget",
        sourceURL: "https://cdn.example.test/vendor.js?sample=masked",
        startTime: 655
      }
    ],
    startTime: 600,
    styleAndLayoutStart: 675
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

function createFakePerformanceObserver(supportedEntryTypes) {
  const callbacks = [];
  const observers = [];
  const observed = [];
  const supported = supportedEntryTypes;
  class FakePerformanceObserver {
    static supportedEntryTypes = supported;

    constructor(callback) {
      callbacks.push(callback);
      observers.push(this);
    }

    disconnect() {
      this.disconnected = true;
    }

    observe(nextObservedOptions) {
      observed.push(nextObservedOptions);
    }
  }

  return {
    PerformanceObserver: FakePerformanceObserver,
    disconnectedCount() {
      return observers.filter((observer) => observer.disconnected).length;
    },
    emit(entries) {
      for (const callback of callbacks) {
        callback({
          getEntries() {
            return entries;
          }
        });
      }
    },
    observedOptions() {
      return observed;
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
