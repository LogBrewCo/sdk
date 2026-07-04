import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_KEY = "LOGBREW_BROWSER_KEY";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";
const XHR_SPAN_ID = "7777777777777777";
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-xhr-test-"));
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

test("installed browser XHR instrumentation emits a sanitized child span and scoped traceparent", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    createBrowserTraceContext,
    installLogBrewBrowser,
    installLogBrewBrowserXhrInstrumentation
  } = imported;
  try {
    assert.equal(typeof installLogBrewBrowserXhrInstrumentation, "function");
    const FakeXMLHttpRequest = createFakeXMLHttpRequestClass();
    const browserWindow = createFakeBrowserWindow("https://app.example.test/checkout?email=dev@example.test#step2");
    browserWindow.XMLHttpRequest = FakeXMLHttpRequest;
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
    const originalOpen = FakeXMLHttpRequest.prototype.open;
    const originalSend = FakeXMLHttpRequest.prototype.send;

    const instrumentation = installLogBrewBrowserXhrInstrumentation(context, {
      flushOnCapture: false,
      now: () => "2026-07-04T11:00:00.000Z",
      nowMs: createNowMs([1000, 1088.5]),
      randomValues: sequenceBytes([0x77, 0x55]),
      resourcePathTemplate: "/api/orders/:id",
      tracePropagationTargets: [/^https:\/\/api\.example\.test\/api\//u],
      XMLHttpRequest: FakeXMLHttpRequest
    });

    assert.notEqual(FakeXMLHttpRequest.prototype.open, originalOpen);
    assert.notEqual(FakeXMLHttpRequest.prototype.send, originalSend);

    const xhr = new browserWindow.XMLHttpRequest();
    xhr.open("POST", "https://api.example.test/api/orders/123?email=dev@example.test#fragment");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.send("private body");
    xhr.status = 503;
    xhr.setResponseHeader("Content-Length", "456");
    xhr.dispatchEvent({ type: "load" });

    instrumentation.uninstall();
    assert.equal(FakeXMLHttpRequest.prototype.open, originalOpen);
    assert.equal(FakeXMLHttpRequest.prototype.send, originalSend);
    assert.equal(xhr.requestHeaders.Accept, "application/json");
    assert.equal(xhr.requestHeaders.traceparent, `00-${TRACE_ID}-${XHR_SPAN_ID}-01`);

    const payload = JSON.parse(context.previewJson());
    assert.equal(payload.events.length, 1);
    const [event] = payload.events;
    assert.equal(event.type, "span");
    assert.equal(event.attributes.name, "browser.xhr POST /api/orders/:id");
    assert.equal(event.attributes.traceId, TRACE_ID);
    assert.equal(event.attributes.parentSpanId, PARENT_SPAN_ID);
    assert.equal(event.attributes.spanId, XHR_SPAN_ID);
    assert.equal(event.attributes.status, "error");
    assert.equal(event.attributes.durationMs, 88.5);
    assert.equal(event.attributes.metadata.source, "browser.xhr");
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

test("installed browser XHR instrumentation records network failures without payload details", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    installLogBrewBrowser,
    installLogBrewBrowserXhrInstrumentation
  } = imported;
  try {
    const FakeXMLHttpRequest = createFakeXMLHttpRequestClass();
    const browserWindow = createFakeBrowserWindow("https://app.example.test/settings");
    browserWindow.XMLHttpRequest = FakeXMLHttpRequest;
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

    installLogBrewBrowserXhrInstrumentation(context, {
      flushOnCapture: false,
      now: () => "2026-07-04T11:01:00.000Z",
      nowMs: createNowMs([2000, 2012]),
      randomValues: () => fillBytes(8, 0x66),
      XMLHttpRequest: FakeXMLHttpRequest
    });

    const xhr = new browserWindow.XMLHttpRequest();
    xhr.open("PATCH", "/api/profile/42?sample=hidden");
    xhr.send("hidden body");
    xhr.dispatchEvent({ type: "error" });

    const [event] = JSON.parse(context.previewJson()).events;
    assert.equal(event.attributes.name, "browser.xhr PATCH /api/profile/42");
    assert.equal(event.attributes.status, "error");
    assert.equal(event.attributes.durationMs, 12);
    assert.equal(event.attributes.metadata.errorType, "error");
    assert.equal(event.attributes.metadata.errorMessage, undefined);
    assert.equal(JSON.stringify(event).includes("sample=hidden"), false);
    assert.equal(JSON.stringify(event).includes("hidden body"), false);
  } finally {
    await removeTempDir();
  }
});

test("installed browser XHR summary helpers create sanitized spans", async () => {
  const { imported, removeTempDir } = await importBrowserPackage();
  const {
    captureBrowserXhrSpan,
    createBrowserXhrSpanEvent,
    installLogBrewBrowser
  } = imported;
  try {
    assert.equal(typeof captureBrowserXhrSpan, "function");
    assert.equal(typeof createBrowserXhrSpanEvent, "function");
    const browserWindow = createFakeBrowserWindow("https://app.example.test/account?sample=hidden#panel");
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

    const event = createBrowserXhrSpanEvent({
      durationMs: 15,
      method: "GET",
      responseBodySize: 42,
      statusCode: 202,
      tracePropagated: false,
      url: "https://api.example.test/api/accounts/123?sample=hidden"
    }, browserWindow, {
      resourcePathTemplate: "/api/accounts/:id"
    });
    assert.equal(event.attributes.name, "browser.xhr GET /api/accounts/:id");
    assert.equal(event.attributes.metadata.path, "/account");
    assert.equal(event.attributes.metadata.responseBodySize, 42);
    assert.equal(JSON.stringify(event).includes("sample=hidden"), false);

    await captureBrowserXhrSpan({
      durationMs: 7,
      method: "DELETE",
      statusCode: 204,
      url: "/api/accounts/123?sample=hidden"
    }, context, {
      flushOnCapture: false,
      resourcePathTemplate: ({ path }) => path.replace(/\/\d+$/u, "/:id")
    });
    const [captured] = JSON.parse(context.previewJson()).events;
    assert.equal(captured.attributes.name, "browser.xhr DELETE /api/accounts/:id");
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

function createFakeXMLHttpRequestClass() {
  return class FakeXMLHttpRequest {
    constructor() {
      this.listeners = new Map();
      this.requestHeaders = {};
      this.responseHeaders = {};
      this.status = 0;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    dispatchEvent(event) {
      for (const listener of this.listeners.get(event.type) ?? []) {
        listener.call(this, event);
      }
    }

    getResponseHeader(name) {
      return this.responseHeaders[String(name).toLowerCase()] ?? null;
    }

    open(method, url) {
      this.method = method;
      this.url = String(url);
    }

    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
    }

    send(body) {
      this.body = body;
    }

    setRequestHeader(name, value) {
      this.requestHeaders[name] = value;
    }

    setResponseHeader(name, value) {
      this.responseHeaders[String(name).toLowerCase()] = String(value);
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

function createNowMs(values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1);
}

function fillBytes(length, value) {
  return Array.from({ length }, () => value);
}

function sequenceBytes(values) {
  let index = 0;
  return (length) => fillBytes(length, values[index++] ?? values.at(-1));
}
