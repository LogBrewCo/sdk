import test, { after } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true }))));

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-attribution-test-"));
  tempDirs.push(tempDir);
  const browserRoot = join(tempDir, "node_modules", "@logbrew", "browser");
  await mkdir(join(tempDir, "node_modules", "@logbrew"), { recursive: true });
  await cp(resolve(repoRoot, "js/logbrew-js"), join(tempDir, "node_modules", "@logbrew", "sdk"), { recursive: true });
  await cp(resolve(repoRoot, "js/logbrew-browser"), browserRoot, { recursive: true });
  return {
    esm: await import(pathToFileURL(join(browserRoot, "index.js"))),
    commonJs: require(join(browserRoot, "index.cjs"))
  };
}

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); }
  };
}

function createWindow(href, referrer, sessionStorage = createStorage()) {
  const url = new URL(href);
  return {
    document: { referrer, visibilityState: "visible" },
    location: { href, pathname: url.pathname },
    navigator: { userAgent: "test" },
    sessionStorage,
    addEventListener() {},
    removeEventListener() {}
  };
}

function eventTags(context) {
  return JSON.parse(context.client.previewJson()).events.map((event) => event.attributes.context?.tags);
}

const packages = await importBrowserPackage();

for (const [format, browser] of Object.entries(packages)) {
  test(`${format}: the landing URL's campaign and the referring host tag every event`, () => {
    const browserWindow = createWindow(
      "https://blog.example.test/?utm_source=newsletter&utm_medium=email&utm_campaign=october&email=a%40b.test",
      "https://forum.example.org/t/gardens/4821?page=2"
    );
    const context = browser.installLogBrewBrowser({ browserWindow, clientKey: "LOGBREW_BROWSER_KEY", flushOnCapture: false });
    browser.captureBrowserAction({ name: "signup_completed" }, context);
    const expected = {
      referrer_domain: "forum.example.org",
      utm_campaign: "october",
      utm_medium: "email",
      utm_source: "newsletter"
    };
    assert.deepEqual(eventTags(context), [expected, expected]);
    assert.equal(context.client.previewJson().includes("a@b.test"), false);
    assert.equal(context.client.previewJson().includes("4821"), false);
  });

  test(`${format}: later pages in the tab session keep the first touch`, () => {
    const storage = createStorage();
    browser.installLogBrewBrowser({
      browserWindow: createWindow("https://blog.example.test/?utm_source=ads", "", storage),
      clientKey: "LOGBREW_BROWSER_KEY",
      flushOnCapture: false
    });
    const later = browser.installLogBrewBrowser({
      browserWindow: createWindow("https://blog.example.test/auth/register", "https://blog.example.test/", storage),
      clientKey: "LOGBREW_BROWSER_KEY",
      flushOnCapture: false
    });
    assert.deepEqual(eventTags(later), [{ utm_source: "ads" }]);
  });

  test(`${format}: a direct visit adds no tags and app tags win`, () => {
    const direct = browser.installLogBrewBrowser({
      browserWindow: createWindow("https://blog.example.test/", ""),
      clientKey: "LOGBREW_BROWSER_KEY",
      flushOnCapture: false
    });
    assert.deepEqual(eventTags(direct), [undefined]);
    const tagged = browser.installLogBrewBrowser({
      browserWindow: createWindow("https://blog.example.test/?utm_source=ads", ""),
      clientKey: "LOGBREW_BROWSER_KEY",
      context: { schemaVersion: 1, tags: { utm_source: "partner", plan: "free" } },
      flushOnCapture: false
    });
    assert.deepEqual(eventTags(tagged), [{ plan: "free", utm_source: "partner" }]);
  });

  test(`${format}: captureAttribution false reads neither the URL nor the referrer`, () => {
    const context = browser.installLogBrewBrowser({
      browserWindow: createWindow("https://blog.example.test/?utm_source=ads", "https://forum.example.org/"),
      captureAttribution: false,
      clientKey: "LOGBREW_BROWSER_KEY",
      flushOnCapture: false
    });
    assert.deepEqual(eventTags(context), [undefined]);
  });
}
