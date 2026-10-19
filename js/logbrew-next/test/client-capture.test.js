import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsDir = path.resolve(packageDir, "..");

function runClientConsumer(source, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-next-client-"));
  try {
    const scope = path.join(root, "node_modules", "@logbrew");
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(path.join(jsDir, "logbrew-js"), path.join(scope, "sdk"), "dir");
    fs.symlinkSync(path.join(jsDir, "logbrew-node"), path.join(scope, "node"), "dir");
    fs.symlinkSync(packageDir, path.join(scope, "next"), "dir");
    const react = path.join(root, "node_modules", "react");
    fs.mkdirSync(react, { recursive: true });
    fs.writeFileSync(path.join(react, "package.json"), JSON.stringify({ name: "react", main: "index.js" }));
    fs.writeFileSync(path.join(react, "index.js"), "module.exports = { useEffect() {}, useRef() { return {}; } };\n");
    fs.writeFileSync(path.join(root, "consumer.mjs"), source);
    return spawnSync(process.execPath, ["--preserve-symlinks", path.join(root, "consumer.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the Next.js browser client sends error-boundary and window errors with release and environment", () => {
  const result = runClientConsumer(`
    import assert from "node:assert/strict";
    import {
      captureNextClientError,
      createLogBrewNextBrowserClient,
      installLogBrewNextClientErrorCapture
    } from "@logbrew/next/client";

    const sent = [];
    globalThis.fetch = async (url, init) => { sent.push({ url, init }); return { status: 202 }; };
    const client = createLogBrewNextBrowserClient({ clientKey: "LOGBREW_CLIENT_KEY" });
    await captureNextClientError(client, Object.assign(new RangeError("cart total failed"), { digest: "abc123" }), {
      routeTemplate: "/cart/[cartId]"
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].init.keepalive, true);
    const boundary = JSON.parse(sent[0].init.body).events[0].attributes;
    assert.deepEqual(boundary.exception, { type: "RangeError", mechanism: { type: "nextjs.error_boundary", handled: false } });
    assert.equal(boundary.metadata.errorDigest, "abc123");
    assert.equal(boundary.metadata.routeTemplate, "/cart/[cartId]");
    assert.deepEqual(boundary.context.resource.deployment, { environment: "preview", release: "9c1e7aa" });

    const listeners = new Map();
    const browserWindow = {
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); }
    };
    const capture = installLogBrewNextClientErrorCapture({ client, browserWindow });
    listeners.get("error")({ error: new TypeError("button handler failed") });
    listeners.get("unhandledrejection")({ reason: new Error("save failed") });
    listeners.get("pagehide")();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    const mechanisms = sent.slice(1).flatMap(({ init }) => JSON.parse(init.body).events)
      .map((event) => event.attributes.exception.mechanism.type);
    assert.deepEqual(mechanisms, ["nextjs.window_error", "nextjs.unhandled_rejection"]);
    capture.uninstall();
    assert.equal(listeners.size, 0);
    await client.shutdown();
  `, { NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: "9c1e7aa", NEXT_PUBLIC_VERCEL_ENV: "preview" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("transport: null keeps the browser client manual, and LOGBREW variables win over Vercel ones", () => {
  const result = runClientConsumer(`
    import assert from "node:assert/strict";
    import { createLogBrewNextBrowserClient } from "@logbrew/next/client";

    const client = createLogBrewNextBrowserClient({ clientKey: "LOGBREW_CLIENT_KEY", transport: null });
    assert.equal(client.automaticDelivery, false);
    client.log("evt_log", "2026-06-02T10:00:00Z", { message: "ready", level: "info" });
    const event = JSON.parse(client.previewJson()).events[0];
    assert.deepEqual(event.attributes.context.resource.deployment, { environment: "production", release: "web@2.0.0" });
  `, {
    NEXT_PUBLIC_LOGBREW_RELEASE: "web@2.0.0",
    NEXT_PUBLIC_LOGBREW_ENVIRONMENT: "production",
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: "9c1e7aa",
    NEXT_PUBLIC_VERCEL_ENV: "preview"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("server clients read release and environment from LOGBREW and Vercel variables", () => {
  const result = runClientConsumer(`
    import assert from "node:assert/strict";
    import { createLogBrewNextClient } from "@logbrew/next";

    const client = createLogBrewNextClient({ serverApiKey: "LOGBREW_SERVER_API_KEY" });
    client.log("evt_log", "2026-06-02T10:00:00Z", { message: "ready", level: "info" });
    const event = JSON.parse(client.previewJson()).events[0];
    assert.deepEqual(event.attributes.context.resource.deployment, { environment: "production", release: "api@3.1.0" });
    assert.deepEqual(event.attributes.context.resource.service, { name: "storefront" });
  `, { LOGBREW_RELEASE: "api@3.1.0", VERCEL_GIT_COMMIT_SHA: "9c1e7aa", VERCEL_ENV: "production", LOGBREW_SERVICE_NAME: "storefront" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
