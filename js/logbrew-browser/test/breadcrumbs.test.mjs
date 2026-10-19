import test, { after } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true }))));

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-breadcrumbs-test-"));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, "node_modules", "@logbrew"), { recursive: true });
  await cp(resolve(repoRoot, "js/logbrew-js"), join(tempDir, "node_modules", "@logbrew", "sdk"), { recursive: true });
  await cp(resolve(repoRoot, "js/logbrew-browser"), join(tempDir, "node_modules", "@logbrew", "browser"), { recursive: true });
  return import(pathToFileURL(join(tempDir, "node_modules", "@logbrew", "browser", "index.js")));
}

function createWindow() {
  let path = "/cart";
  const listeners = new Map();
  class FakeXhr {
    open() {}
    send() {
      this.status = 503;
      queueMicrotask(() => { this.loadend?.(); });
    }
    addEventListener(type, listener) {
      if (type === "loadend") {
        this.loadend = listener;
      }
    }
  }
  const browserWindow = {
    console: { debug() {}, error() {}, info() {}, log() {}, warn() {} },
    XMLHttpRequest: FakeXhr,
    fetch: async (input) => ({ status: String(input).includes("/missing") ? 404 : 200 }),
    history: {
      pushState(_state, _title, url) { path = new URL(url, "https://shop.example.test").pathname; },
      replaceState() {}
    },
    location: {
      get href() { return `https://shop.example.test${path}`; },
      get pathname() { return path; }
    },
    navigator: { userAgent: "test" },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); }
  };
  return browserWindow;
}

test("console, fetch, XHR, and route changes become breadcrumbs on the next browser issue", async () => {
  const { captureBrowserError, installLogBrewBrowser } = await importBrowserPackage();
  const browserWindow = createWindow();
  const originalFetch = browserWindow.fetch;
  const context = installLogBrewBrowser({ browserWindow, clientKey: "LOGBREW_BROWSER_KEY", flushOnCapture: false });

  browserWindow.console.warn("coupon %s rejected", "SPRING-SAVE");
  await browserWindow.fetch("/api/cart?coupon=SPRING-SAVE#total");
  await browserWindow.fetch("https://cdn.example.test/missing.js");
  const xhr = new browserWindow.XMLHttpRequest();
  xhr.open("post", "/api/checkout?step=2");
  xhr.send("{}");
  await new Promise((resolveTick) => { setTimeout(resolveTick, 0); });
  browserWindow.history.pushState({}, "", "/checkout?step=2");
  await captureBrowserError(new Error("checkout failed"), context, { flushOnCapture: false });

  const issue = JSON.parse(context.client.previewJson()).events.find((event) => event.type === "issue");
  // The page view breadcrumb the browser SDK already records comes first.
  const [pageView, ...automatic] = issue.attributes.breadcrumbs;
  assert.equal(pageView.message, "page_view /cart");
  const crumbs = automatic.map(({ category, level, message, data }) => ({ category, level, message, data }));
  assert.deepEqual(crumbs, [
    { category: "console", level: "warning", message: "coupon %s rejected", data: undefined },
    { category: "fetch", level: "info", message: undefined, data: { method: "GET", url: "https://shop.example.test/api/cart", status_code: 200 } },
    { category: "fetch", level: "warning", message: undefined, data: { method: "GET", url: "https://cdn.example.test/missing.js", status_code: 404 } },
    { category: "xhr", level: "error", message: undefined, data: { method: "POST", url: "https://shop.example.test/api/checkout", status_code: 503 } },
    { category: "navigation", level: undefined, message: undefined, data: { from: "/cart", to: "/checkout" } }
  ]);
  assert.equal(JSON.stringify(issue).includes("SPRING-SAVE"), false);

  context.uninstall();
  assert.equal(browserWindow.fetch, originalFetch);
});

test("breadcrumbs: false leaves the page untouched, and uninstall puts every method back", async () => {
  const { installLogBrewBrowser } = await importBrowserPackage();
  const quiet = createWindow();
  const quietFetch = quiet.fetch;
  installLogBrewBrowser({ browserWindow: quiet, clientKey: "LOGBREW_BROWSER_KEY", breadcrumbs: false });
  assert.equal(quiet.fetch, quietFetch);

  const page = createWindow();
  const methods = [page.fetch, page.console.warn, page.history.pushState, page.XMLHttpRequest.prototype.open];
  const context = installLogBrewBrowser({ browserWindow: page, clientKey: "LOGBREW_BROWSER_KEY" });
  assert.notEqual(page.fetch, methods[0]);
  context.uninstall();
  assert.deepEqual([page.fetch, page.console.warn, page.history.pushState, page.XMLHttpRequest.prototype.open], methods);
});
