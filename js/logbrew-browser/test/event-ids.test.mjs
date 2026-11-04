import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const READABLE_ID = /^(.+)_[a-f0-9]{32}$/u;

async function importBrowserPackage(entry) {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-event-id-test-"));
  await mkdir(join(tempDir, "node_modules", "@logbrew"), { recursive: true });
  await cp(resolve(repoRoot, "js/logbrew-js"), join(tempDir, "node_modules", "@logbrew", "sdk"), {
    recursive: true
  });
  await cp(resolve(repoRoot, "js/logbrew-browser"), join(tempDir, "node_modules", "@logbrew", "browser"), {
    recursive: true
  });
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

function createFakeBrowserWindow() {
  return {
    document: { visibilityState: "visible" },
    location: { href: "https://app.example.test/products/12345?email=dev@example.test#billing-tab" },
    navigator: {}
  };
}

function interactionEntry() {
  return {
    duration: 320,
    entryType: "event",
    interactionId: 7,
    name: "click",
    processingEnd: 40,
    processingStart: 20,
    startTime: 10
  };
}

function eventsWithTemplates(imported, browserWindow) {
  const pageTemplate = "/products/:id";
  const request = { durationMs: 4, method: "GET", statusCode: 200, url: "https://api.example.test/orders/98765?card=4242" };
  const spanOptions = { includeQueryString: true, randomValues: (length) => new Uint8Array(length).fill(1) };
  return {
    action: imported.createBrowserActionEvent({ metadata: { routeTemplate: pageTemplate }, name: "checkout.submit" }, browserWindow, { includeQueryString: true }),
    document: imported.createBrowserNavigationTimingEvent(
      { duration: 10, entryType: "navigation", name: "https://app.example.test/products/12345", startTime: 0 },
      browserWindow,
      { ...spanOptions, navigationPathTemplate: pageTemplate }
    ),
    error: imported.createBrowserErrorEvent(new Error("Card for dev@example.test failed"), browserWindow, { includeQueryString: true }),
    fetch: imported.createBrowserFetchSpanEvent(request, browserWindow, { ...spanOptions, resourcePathTemplate: "/orders/:id" }),
    inp: imported.createBrowserInteractionToNextPaintEvent([interactionEntry()], browserWindow, { ...spanOptions, interactionPathTemplate: pageTemplate }),
    interaction: imported.createBrowserInteractionTimingEvent(interactionEntry(), browserWindow, { ...spanOptions, interactionPathTemplate: pageTemplate }),
    network: imported.createBrowserNetworkEvent({ method: "GET", routeTemplate: "/orders/:id" }, browserWindow, { includeQueryString: true }),
    rejection: imported.createUnhandledRejectionEvent({ reason: new Error("Session 55555 expired") }, browserWindow, { includeQueryString: true }),
    resource: imported.createBrowserResourceTimingEvent(
      { duration: 5, initiatorType: "fetch", name: "https://api.example.test/orders/98765", startTime: 0 },
      browserWindow,
      { ...spanOptions, resourcePathTemplate: "/orders/:id" }
    ),
    webVital: imported.createBrowserWebVitalEvent(
      { name: "LCP", value: 1200, url: "https://app.example.test/products/12345" },
      browserWindow,
      { ...spanOptions, webVitalPathTemplate: pageTemplate }
    ),
    xhr: imported.createBrowserXhrSpanEvent(request, browserWindow, { ...spanOptions, resourcePathTemplate: "/orders/:id" })
  };
}

for (const entry of ["index.js", "index.cjs"]) {
  test(`default browser event IDs repeat only the event name, never the page path or error text, in ${entry}`, async () => {
    const { imported, removeTempDir } = await importBrowserPackage(entry);
    try {
      const events = eventsWithTemplates(imported, createFakeBrowserWindow());
      const readableIds = Object.fromEntries(Object.entries(events).map(([kind, event]) => [kind, event.id.match(READABLE_ID)?.[1]]));
      assert.deepEqual(readableIds, {
        action: "evt_browser_action_checkout_submit",
        document: "evt_browser_document_products_id",
        error: "evt_browser_error",
        fetch: "evt_browser_fetch_get_orders_id",
        inp: "evt_browser_inp_products_id",
        interaction: "evt_browser_interaction_click_products_id",
        network: "evt_browser_network_network_get_orders_id",
        rejection: "evt_browser_unhandledrejection",
        resource: "evt_browser_resource_fetch_orders_id",
        webVital: "evt_browser_web_vital_lcp_products_id",
        xhr: "evt_browser_xhr_get_orders_id"
      });
    } finally {
      await removeTempDir();
    }
  });
}

test("an explicit idFactory still receives the page path and error message", async () => {
  const { imported, removeTempDir } = await importBrowserPackage("index.js");
  try {
    const contexts = [];
    const idFactory = (context) => {
      contexts.push({ message: context.message, path: context.path, source: context.source });
      return `evt_custom_${contexts.length}`;
    };
    const browserWindow = createFakeBrowserWindow();
    const webVital = imported.createBrowserWebVitalEvent({ name: "CLS", value: 0.1 }, browserWindow, { idFactory, webVitalPathTemplate: "/products/:id" });
    const error = imported.createBrowserErrorEvent(new Error("Card declined"), browserWindow, { idFactory });

    assert.equal(webVital.id, "evt_custom_1");
    assert.equal(error.id, "evt_custom_2");
    assert.deepEqual(contexts, [
      { message: "CLS /products/:id", path: "/products/12345", source: "web_vital" },
      { message: "Card declined", path: "/products/12345", source: "error" }
    ]);
  } finally {
    await removeTempDir();
  }
});
