import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_KEY = "LOGBREW_BROWSER_KEY";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const NAV_TRACE_ID = "11111111111111111111111111111111";
const NAV_SPAN_ID = "2222222222222222";
const POP_TRACE_ID = "33333333333333333333333333333333";
const POP_SPAN_ID = "4444444444444444";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-trace-test-"));
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

test("installed browser capture uses one explicit W3C trace context across page view, actions, issues, and fetch", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    captureBrowserAction,
    captureBrowserError,
    captureBrowserNetwork,
    createBrowserTraceContext,
    createTraceparentFetch,
    installLogBrewBrowser
  } = imported;
  const browserWindow = createFakeBrowserWindow("https://app.example.test/checkout?email=dev@example.test#step2");
  let tick = 0;
  try {
    const traceContext = createBrowserTraceContext({
      sampled: true,
      spanId: SPAN_ID,
      traceId: TRACE_ID
    });
    const context = installLogBrewBrowser({
      browserWindow,
      clientKey: CLIENT_KEY,
      flushOnCapture: false,
      now: () => `2026-07-03T10:00:0${++tick}Z`,
      traceContext,
      transport: {
        async send() {
          return { statusCode: 202 };
        }
      }
    });

    await captureBrowserAction({
      name: "checkout.clicked",
      status: "success",
      metadata: {
        routeTemplate: "/checkout",
        nestedDropped: { value: "private" }
      }
    }, context, {
      flushOnCapture: false,
      now: () => `2026-07-03T10:00:0${++tick}Z`
    });
    await captureBrowserNetwork({
      method: "POST",
      routeTemplate: "/api/checkout?email=dev@example.test#retry",
      statusCode: 503,
      durationMs: 441
    }, context, {
      flushOnCapture: false,
      now: () => `2026-07-03T10:00:0${++tick}Z`
    });
    await captureBrowserError(createErrorEvent("Checkout exploded", "/assets/app.js", 12, 4), context, {
      flushOnCapture: false,
      now: () => `2026-07-03T10:00:0${++tick}Z`
    });

    const payload = JSON.parse(context.previewJson());
    const pageView = payload.events.find((event) => event.type === "span");
    const action = payload.events.find((event) => event.type === "action" && event.attributes.metadata.source === "browser.action");
    const network = payload.events.find((event) => event.type === "action" && event.attributes.metadata.source === "browser.network");
    const issue = payload.events.find((event) => event.type === "issue");

    assert.equal(context.traceContext.traceId, TRACE_ID);
    assert.equal(context.traceContext.spanId, SPAN_ID);
    assert.equal(pageView.attributes.traceId, TRACE_ID);
    assert.equal(pageView.attributes.spanId, SPAN_ID);
    assert.equal(pageView.attributes.metadata.path, "/checkout");
    assert.equal(action.attributes.metadata.traceId, TRACE_ID);
    assert.equal(action.attributes.metadata.spanId, SPAN_ID);
    assert.equal(action.attributes.metadata.nestedDropped, undefined);
    assert.equal(network.attributes.metadata.traceId, TRACE_ID);
    assert.equal(network.attributes.metadata.spanId, SPAN_ID);
    assert.equal(network.attributes.metadata.routeTemplate, "/api/checkout");
    assert.equal(issue.attributes.metadata.traceId, TRACE_ID);
    assert.equal(issue.attributes.metadata.spanId, SPAN_ID);
    for (const event of payload.events) {
      assert.equal(event.attributes.metadata?.traceparent, undefined);
    }

    const requests = [];
    const tracedFetch = createTraceparentFetch({
      fetchImpl: async (input, init = {}) => {
        requests.push({ input, init });
        return { status: 204 };
      },
      traceContext,
      tracePropagationTargets: [/^\/api\//u]
    });
    await tracedFetch("/api/checkout?email=dev@example.test", {
      headers: { accept: "application/json" }
    });

    assert.equal(requests[0].init.headers.traceparent, `00-${TRACE_ID}-${SPAN_ID}-01`);
    assert.equal(requests[0].init.headers.accept, "application/json");
  } finally {
    await removeTempDir();
  }
});

test("installed browser navigation instrumentation renews trace context for SPA route changes", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    captureBrowserAction,
    createBrowserTraceContext,
    createTraceparentFetch,
    installLogBrewBrowser,
    installLogBrewBrowserNavigationInstrumentation
  } = imported;
  const browserWindow = createFakeBrowserWindow("https://app.example.test/checkout?email=dev@example.test#step2");
  let tick = 0;
  try {
    const context = installLogBrewBrowser({
      browserWindow,
      clientKey: CLIENT_KEY,
      flushOnCapture: false,
      now: () => `2026-07-03T10:01:0${++tick}Z`,
      traceContext: createBrowserTraceContext({
        sampled: true,
        spanId: SPAN_ID,
        traceId: TRACE_ID
      }),
      transport: {
        async send() {
          return { statusCode: 202 };
        }
      }
    });
    const navigation = installLogBrewBrowserNavigationInstrumentation(context, {
      flushOnCapture: false,
      now: () => `2026-07-03T10:01:0${++tick}Z`,
      randomValues: sequenceRandomValues([
        fillBytes(8, 0x22),
        fillBytes(16, 0x11),
        fillBytes(8, 0x44),
        fillBytes(16, 0x33)
      ])
    });

    browserWindow.history.pushState({ marker: "drop" }, "", "/account?sample=1#section");
    await captureBrowserAction({
      name: "account.loaded",
      metadata: {
        routeTemplate: "/account",
        nestedDropped: { value: "private" }
      }
    }, context, {
      flushOnCapture: false,
      now: () => `2026-07-03T10:01:0${++tick}Z`
    });

    const requests = [];
    const tracedFetch = createTraceparentFetch({
      fetchImpl: async (input, init = {}) => {
        requests.push({ input, init });
        return { status: 204 };
      },
      traceContext: () => context.traceContext,
      tracePropagationTargets: [/^\/api\//u]
    });
    await tracedFetch("/api/account?sample=1");

    browserWindow.history.replaceState({ marker: "drop" }, "", "/account?sample=2#other");
    browserWindow.setLocation("/settings?sample=3#hash");
    browserWindow.dispatchEvent({ type: "popstate" });
    navigation.uninstall();
    browserWindow.history.pushState({}, "", "/after-uninstall?sample=1#hash");

    const payload = JSON.parse(context.previewJson());
    const spans = payload.events.filter((event) => event.type === "span");
    const action = payload.events.find((event) => event.type === "action" && event.attributes.name === "account.loaded");

    assert.equal(spans.length, 3);
    assert.equal(spans[0].attributes.metadata.path, "/checkout");
    assert.equal(spans[0].attributes.traceId, TRACE_ID);
    assert.equal(spans[1].attributes.metadata.path, "/account");
    assert.equal(spans[1].attributes.metadata.previousPath, "/checkout");
    assert.equal(spans[1].attributes.metadata.navigationType, "pushState");
    assert.equal(spans[1].attributes.metadata.historyState, undefined);
    assert.equal(spans[1].attributes.traceId, NAV_TRACE_ID);
    assert.equal(spans[1].attributes.spanId, NAV_SPAN_ID);
    assert.equal(spans[2].attributes.metadata.path, "/settings");
    assert.equal(spans[2].attributes.metadata.previousPath, "/account");
    assert.equal(spans[2].attributes.metadata.navigationType, "popstate");
    assert.equal(spans[2].attributes.traceId, POP_TRACE_ID);
    assert.equal(spans[2].attributes.spanId, POP_SPAN_ID);
    assert.equal(action.attributes.metadata.path, "/account");
    assert.equal(action.attributes.metadata.traceId, NAV_TRACE_ID);
    assert.equal(action.attributes.metadata.spanId, NAV_SPAN_ID);
    assert.equal(action.attributes.metadata.nestedDropped, undefined);
    assert.equal(context.traceContext.traceId, POP_TRACE_ID);
    assert.equal(context.traceContext.spanId, POP_SPAN_ID);
    assert.equal(requests[0].init.headers.traceparent, `00-${NAV_TRACE_ID}-${NAV_SPAN_ID}-01`);
    assert.equal(JSON.stringify(payload).includes("sample=1"), false);
    assert.equal(JSON.stringify(payload).includes("#section"), false);
  } finally {
    await removeTempDir();
  }
});

function createErrorEvent(message, filename, lineno, colno) {
  return {
    colno,
    error: new Error(message),
    filename,
    lineno,
    message,
    type: "error"
  };
}

function createFakeBrowserWindow(href) {
  const listeners = new Map();
  const documentListeners = new Map();
  let currentUrl = new URL(href);
  const browserWindow = {
    addEventListener(type, listener) {
      addListener(listeners, type, listener);
    },
    dispatchEvent(event) {
      dispatchListeners(listeners, event.type, event);
    },
    document: {
      addEventListener(type, listener) {
        addListener(documentListeners, type, listener);
      },
      dispatchEvent(event) {
        dispatchListeners(documentListeners, event.type, event);
      },
      removeEventListener(type, listener) {
        removeListener(documentListeners, type, listener);
      },
      visibilityState: "visible"
    },
    history: {
      pushState(_state, _title, url) {
        setLocation(url);
      },
      replaceState(_state, _title, url) {
        setLocation(url);
      }
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
    removeEventListener(type, listener) {
      removeListener(listeners, type, listener);
    },
    setLocation
  };

  function setLocation(url) {
    if (url === undefined || url === null) {
      return;
    }
    currentUrl = new URL(String(url), currentUrl.href);
    browserWindow.location.hash = currentUrl.hash;
    browserWindow.location.href = currentUrl.href;
    browserWindow.location.pathname = currentUrl.pathname;
    browserWindow.location.search = currentUrl.search;
  }

  return browserWindow;
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

function fillBytes(length, value) {
  return Array.from({ length }, () => value);
}

function sequenceRandomValues(values) {
  let index = 0;
  return (length) => {
    const next = values[index++] ?? fillBytes(length, 0xaa);
    assert.equal(next.length, length);
    return next;
  };
}
