import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_KEY = "LOGBREW_BROWSER_KEY";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
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
  const url = new URL(href);
  return {
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
    localStorage: createMemoryStorage(),
    location: {
      hash: url.hash,
      href: url.href,
      pathname: url.pathname,
      search: url.search,
      toString() {
        return url.href;
      }
    },
    removeEventListener(type, listener) {
      removeListener(listeners, type, listener);
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
