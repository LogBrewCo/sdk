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

const STORAGE_KEY = "logbrew:browser:anonymous-subject";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 395 * DAY_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function importBrowserPackage() {
  const tempDir = await mkdtemp(join(tmpdir(), "logbrew-browser-anonymous-subject-test-"));
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
  const writes = [];
  return {
    values,
    writes,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => {
      writes.push(key);
      values.set(key, String(value));
    }
  };
}

function createWindow(localStorage = createStorage()) {
  const browserWindow = {
    document: { referrer: "", visibilityState: "visible" },
    location: { href: "https://shop.example.test/", pathname: "/" },
    navigator: { userAgent: "test" },
    sessionStorage: createStorage(),
    addEventListener() {},
    removeEventListener() {}
  };
  Object.defineProperty(browserWindow, "localStorage", { configurable: true, get: () => localStorage });
  return browserWindow;
}

function visit(browser, browserWindow, options = {}) {
  return browser.installLogBrewBrowser({
    browserWindow,
    capturePageViews: false,
    clientKey: "LOGBREW_BROWSER_KEY",
    flushOnCapture: false,
    ...options
  });
}

async function subjects(browser, context, count = 1) {
  for (let index = 0; index < count; index += 1) {
    await browser.captureBrowserAction({ name: `step_${index}` }, context);
  }
  return JSON.parse(context.client.previewJson()).events.map((event) => event.attributes.context?.subject);
}

function storedRecord(storage) {
  return JSON.parse(storage.values.get(STORAGE_KEY));
}

const packages = await importBrowserPackage();

for (const [format, browser] of Object.entries(packages)) {
  test(`${format}: without the option no ID is stored or sent`, async () => {
    const storage = createStorage();
    const context = visit(browser, createWindow(storage));
    assert.deepEqual(await subjects(browser, context), [undefined]);
    assert.deepEqual(storage.writes, []);
  });

  test(`${format}: with the option every event of two visits carries one stored ID`, async () => {
    const storage = createStorage();
    const before = Date.now();
    const first = await subjects(browser, visit(browser, createWindow(storage), { anonymousSubject: true }), 2);
    const second = await subjects(browser, visit(browser, createWindow(storage), { anonymousSubject: true }), 2);
    const [subject] = first;
    assert.match(subject.id, UUID);
    assert.equal(subject.kind, "anonymous");
    assert.deepEqual([...first, ...second], [subject, subject, subject, subject]);
    const record = storedRecord(storage);
    assert.equal(record.id, subject.id);
    assert.ok(record.createdAt >= before && record.createdAt <= Date.now());
    assert.equal(record.expiresAt, record.createdAt + MAX_AGE_MS);
  });

  test(`${format}: an expired ID is replaced and the new one keeps its own lifetime`, async () => {
    const storage = createStorage();
    const expired = { version: 1, id: "00000000-0000-4000-8000-000000000000", createdAt: Date.now() - MAX_AGE_MS - 1, expiresAt: Date.now() - 1 };
    storage.values.set(STORAGE_KEY, JSON.stringify(expired));
    const [subject] = await subjects(browser, visit(browser, createWindow(storage), { anonymousSubject: true }));
    assert.notEqual(subject.id, expired.id);
    assert.match(subject.id, UUID);
    assert.equal(storedRecord(storage).id, subject.id);
  });

  test(`${format}: a stored ID that outlives a shorter maxAgeDays is replaced`, async () => {
    const storage = createStorage();
    const longLived = { version: 1, id: "00000000-0000-4000-8000-000000000001", createdAt: Date.now(), expiresAt: Date.now() + MAX_AGE_MS };
    storage.values.set(STORAGE_KEY, JSON.stringify(longLived));
    const [subject] = await subjects(browser, visit(browser, createWindow(storage), { anonymousSubject: { maxAgeDays: 30 } }));
    assert.notEqual(subject.id, longLived.id);
    const record = storedRecord(storage);
    assert.equal(record.expiresAt - record.createdAt, 30 * DAY_MS);
  });

  test(`${format}: malformed stored values are replaced`, async () => {
    for (const value of ["not json", "{}", JSON.stringify({ version: 1, id: "", createdAt: 0, expiresAt: Date.now() + DAY_MS })]) {
      const storage = createStorage();
      storage.values.set(STORAGE_KEY, value);
      const [subject] = await subjects(browser, visit(browser, createWindow(storage), { anonymousSubject: true }));
      assert.match(subject.id, UUID);
    }
  });

  test(`${format}: reset removes the stored ID and the next event starts a new one`, async () => {
    const storage = createStorage();
    const context = visit(browser, createWindow(storage), { anonymousSubject: true });
    const [before] = await subjects(browser, context);
    context.anonymousSubject.reset();
    assert.equal(storage.values.has(STORAGE_KEY), false);
    const [, after] = await subjects(browser, context);
    assert.notEqual(after.id, before.id);
    assert.equal(storedRecord(storage).id, after.id);
  });

  test(`${format}: enable starts an ID after install and disable removes it`, async () => {
    const storage = createStorage();
    const context = visit(browser, createWindow(storage));
    context.anonymousSubject.enable();
    await browser.captureBrowserAction({ name: "consent_given" }, context);
    context.anonymousSubject.disable();
    assert.equal(storage.values.has(STORAGE_KEY), false);
    await browser.captureBrowserAction({ name: "consent_withdrawn" }, context);
    const [given, withdrawn] = JSON.parse(context.client.previewJson()).events.map((event) => event.attributes.context?.subject);
    assert.equal(given.kind, "anonymous");
    assert.equal(withdrawn, undefined);
    assert.equal(storage.values.has(STORAGE_KEY), false);
  });

  test(`${format}: a subject the app sets wins over the anonymous ID`, async () => {
    const storage = createStorage();
    const userSubject = { id: "user_42", kind: "user" };
    const clientWide = visit(browser, createWindow(storage), {
      anonymousSubject: true,
      context: { schemaVersion: 1, subject: userSubject }
    });
    assert.deepEqual(await subjects(browser, clientWide), [userSubject]);

    const perEvent = visit(browser, createWindow(storage), { anonymousSubject: true });
    perEvent.client.action("act_signed_in", new Date().toISOString(), {
      context: { schemaVersion: 1, subject: userSubject },
      name: "signed_in",
      status: "success"
    });
    const [eventSubject] = JSON.parse(perEvent.client.previewJson()).events.map((event) => event.attributes.context?.subject);
    assert.deepEqual(eventSubject, userSubject);
  });

  test(`${format}: when storage throws the ID lasts for the page only`, async () => {
    const blocked = createWindow();
    Object.defineProperty(blocked, "localStorage", { get: () => { throw new Error("SecurityError"); } });
    const first = await subjects(browser, visit(browser, blocked, { anonymousSubject: true }), 2);
    const second = await subjects(browser, visit(browser, blocked, { anonymousSubject: true }));
    assert.match(first[0].id, UUID);
    assert.deepEqual(first[1], first[0]);
    assert.notEqual(second[0].id, first[0].id);

    const full = createStorage();
    full.setItem = () => { throw new Error("QuotaExceededError"); };
    const page = await subjects(browser, visit(browser, createWindow(full), { anonymousSubject: true }), 2);
    assert.deepEqual(page[1], page[0]);
  });

  test(`${format}: pages without randomUUID build the ID from getRandomValues`, async () => {
    const insecure = createWindow();
    insecure.crypto = { getRandomValues: (bytes) => globalThis.crypto.getRandomValues(bytes) };
    const [subject] = await subjects(browser, visit(browser, insecure, { anonymousSubject: true }));
    assert.match(subject.id, UUID);

    const storage = createStorage();
    const noRandom = createWindow(storage);
    noRandom.crypto = {};
    assert.deepEqual(await subjects(browser, visit(browser, noRandom, { anonymousSubject: true })), [undefined]);
    assert.deepEqual(storage.writes, []);
  });

  test(`${format}: maxAgeDays must be a whole number from 1 to 395`, () => {
    for (const anonymousSubject of [{ maxAgeDays: 0 }, { maxAgeDays: 396 }, { maxAgeDays: 1.5 }, "yes", []]) {
      assert.throws(() => visit(browser, createWindow(), { anonymousSubject }), { code: "configuration_error" });
    }
    assert.throws(
      () => visit(browser, createWindow(), { anonymousSubject: true, client: visit(browser, createWindow()).client }),
      { code: "configuration_error" }
    );
  });
}
