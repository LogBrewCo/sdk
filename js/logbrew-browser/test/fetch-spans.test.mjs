import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_KEY = "LOGBREW_BROWSER_KEY";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";
const FETCH_SPAN_ID = "8888888888888888";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-fetch-test-"));
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

test("installed browser fetch wrapper emits a sanitized child span and scoped traceparent", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    createBrowserTraceContext,
    createLogBrewBrowserFetch,
    installLogBrewBrowser
  } = imported;
  try {
    assert.equal(typeof createLogBrewBrowserFetch, "function");
    const fetchCalls = [];
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
    const tracedFetch = createLogBrewBrowserFetch(context, {
      fetchImpl: async (input, init) => {
        fetchCalls.push({ init, input });
        return {
          headers: new globalThis.Headers({ "content-length": "456" }),
          status: 503
        };
      },
      flushOnCapture: false,
      now: () => "2026-07-04T10:00:00.000Z",
      nowMs: createNowMs([1000, 1123.456]),
      randomValues: () => fillBytes(8, 0x88),
      resourcePathTemplate: "/api/orders/:id",
      tracePropagationTargets: [/^https:\/\/api\.example\.test\/api\//u]
    });

    const response = await tracedFetch("https://api.example.test/api/orders/123?email=dev@example.test#fragment", {
      body: "private body",
      headers: {
        Accept: "application/json"
      },
      method: "POST"
    });

    assert.equal(response.status, 503);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].init.headers.Accept, "application/json");
    assert.equal(fetchCalls[0].init.headers.traceparent, `00-${TRACE_ID}-${FETCH_SPAN_ID}-01`);

    const payload = JSON.parse(context.previewJson());
    assert.equal(payload.events.length, 1);
    const [event] = payload.events;
    assert.equal(event.type, "span");
    assert.equal(event.attributes.name, "browser.fetch POST /api/orders/:id");
    assert.equal(event.attributes.traceId, TRACE_ID);
    assert.equal(event.attributes.parentSpanId, PARENT_SPAN_ID);
    assert.equal(event.attributes.spanId, FETCH_SPAN_ID);
    assert.equal(event.attributes.status, "error");
    assert.equal(event.attributes.durationMs, 123.456);
    assert.equal(event.attributes.metadata.source, "browser.fetch");
    assert.equal(event.attributes.metadata.path, "/checkout");
    assert.equal(event.attributes.metadata.method, "POST");
    assert.equal(event.attributes.metadata.requestPath, "/api/orders/:id");
    assert.equal(event.attributes.metadata.statusCode, 503);
    assert.equal(event.attributes.metadata.responseBodySize, 456);
    assert.equal(event.attributes.metadata.tracePropagated, true);
    assert.equal(JSON.stringify(event).includes("api.example.test"), false);
    assert.equal(JSON.stringify(event).includes("email=dev@example.test"), false);
    assert.equal(JSON.stringify(event).includes("#fragment"), false);
    assert.equal(JSON.stringify(event).includes("private body"), false);
    assert.equal(JSON.stringify(event).includes("application/json"), false);
  } finally {
    await removeTempDir();
  }
});

test("installed browser fetch wrapper records network failures without swallowing the original error", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    createLogBrewBrowserFetch,
    installLogBrewBrowser
  } = imported;
  try {
    const browserWindow = createFakeBrowserWindow("https://app.example.test/settings");
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
    const networkError = new TypeError("Failed to fetch hidden query");
    const tracedFetch = createLogBrewBrowserFetch(context, {
      fetchImpl: async () => {
        throw networkError;
      },
      flushOnCapture: false,
      now: () => "2026-07-04T10:01:00.000Z",
      nowMs: createNowMs([2000, 2012]),
      randomValues: () => fillBytes(8, 0x66)
    });

    await assert.rejects(
      () => tracedFetch("/api/profile/42?sample=hidden", { method: "PATCH" }),
      (error) => error === networkError
    );

    const [event] = JSON.parse(context.previewJson()).events;
    assert.equal(event.attributes.name, "browser.fetch PATCH /api/profile/42");
    assert.equal(event.attributes.status, "error");
    assert.equal(event.attributes.durationMs, 12);
    assert.equal(event.attributes.metadata.errorType, "TypeError");
    assert.equal(event.attributes.metadata.errorMessage, undefined);
    assert.equal(JSON.stringify(event).includes("sample=hidden"), false);
    assert.equal(JSON.stringify(event).includes("hidden query"), false);
  } finally {
    await removeTempDir();
  }
});

test("installed browser fetch instrumentation patches only when explicitly installed and restores cleanly", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    installLogBrewBrowser,
    installLogBrewBrowserFetchInstrumentation
  } = imported;
  try {
    assert.equal(typeof installLogBrewBrowserFetchInstrumentation, "function");
    const browserWindow = createFakeBrowserWindow("https://app.example.test/account");
    const originalFetch = async () => ({ headers: new globalThis.Headers(), status: 202 });
    browserWindow.fetch = originalFetch;
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

    const instrumentation = installLogBrewBrowserFetchInstrumentation(context, {
      flushOnCapture: false,
      now: () => "2026-07-04T10:02:00.000Z",
      nowMs: createNowMs([3000, 3015]),
      randomValues: () => fillBytes(8, 0x44),
      resourcePathTemplate({ path }) {
        return path.replace(/\/\d+$/u, "/:id");
      }
    });

    assert.notEqual(browserWindow.fetch, originalFetch);
    await browserWindow.fetch("/api/accounts/123", { method: "GET" });
    instrumentation.uninstall();
    assert.equal(browserWindow.fetch, originalFetch);

    const [event] = JSON.parse(context.previewJson()).events;
    assert.equal(event.attributes.name, "browser.fetch GET /api/accounts/:id");
  } finally {
    await removeTempDir();
  }
});

function createFakeBrowserWindow(href) {
  const currentUrl = new URL(href);
  return {
    addEventListener() {},
    document: {
      addEventListener() {},
      removeEventListener() {},
      visibilityState: "visible"
    },
    fetch: undefined,
    localStorage: createMemoryStorage(),
    location: {
      hash: currentUrl.hash,
      href: currentUrl.href,
      origin: currentUrl.origin,
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

function createNowMs(values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1);
}

function fillBytes(length, value) {
  return Array.from({ length }, () => value);
}
