import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsDir = path.resolve(packageDir, "..");

const inertReact = [
  "class Component { constructor(props) { this.props = props; } setState() {} }",
  "module.exports = { Component, createContext() { return {}; }, createElement() { return null; }, useContext() {}, useEffect() {}, useRef() { return {}; } };",
  ""
].join("\n");

// Runs each effect at once, as React does after a commit, and provides the client from globalThis.
const effectReact = [
  "class Component { constructor(props) { this.props = props; } setState() {} }",
  "module.exports = { Component, createContext() { return {}; }, createElement() { return null; },",
  "  useContext() { return globalThis.logbrewClient; }, useEffect(effect) { effect(); }, useRef(current) { return { current }; } };",
  ""
].join("\n");

// Runs a consumer against the package with a minimal React stand-in, from both module formats.
function runConsumer(source, extension, reactSource = inertReact) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-react-root-"));
  try {
    const scope = path.join(root, "node_modules", "@logbrew");
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(path.join(jsDir, "logbrew-js"), path.join(scope, "sdk"), "dir");
    fs.symlinkSync(packageDir, path.join(scope, "react"), "dir");
    fs.symlinkSync(path.join(jsDir, "logbrew-browser"), path.join(scope, "browser"), "dir");
    const react = path.join(root, "node_modules", "react");
    fs.mkdirSync(react, { recursive: true });
    fs.writeFileSync(path.join(react, "package.json"), JSON.stringify({ name: "react", main: "index.js" }));
    fs.writeFileSync(path.join(react, "index.js"), reactSource);
    fs.writeFileSync(path.join(root, `consumer.${extension}`), source);
    return spawnSync(process.execPath, ["--preserve-symlinks", path.join(root, `consumer.${extension}`)], {
      cwd: root,
      encoding: "utf8"
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const scenario = `
  const client = new LogBrewClient({ apiKey: "LOGBREW_CLIENT_KEY" });
  const logged = [];
  const fromApp = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args[0]); };
  try {
    const options = createLogBrewReactRootOptions(client, {
      onRecoverableError: (error, info) => { fromApp.push([error.message, info.componentStack]); }
    });
    options.onUncaughtError(new TypeError("cart crashed"), { componentStack: "\\n    in Cart" });
    options.onCaughtError(new RangeError("price out of range"), { componentStack: "\\n    in Price", errorBoundary: {} });
    options.onCaughtError(new Error("boundary already reported"), {
      componentStack: "\\n    in Checkout",
      errorBoundary: new LogBrewErrorBoundary({ client })
    });
    options.onRecoverableError(new Error("hydration mismatch"), { componentStack: "\\n    in Header" });
  } finally {
    console.error = original;
  }
  const events = JSON.parse(client.previewJson()).events.map(({ attributes }) => ({
    componentStack: attributes.metadata.componentStack,
    handled: attributes.exception.mechanism.handled,
    level: attributes.level,
    mechanism: attributes.exception.mechanism.type,
    type: attributes.exception.type
  }));
  assert.deepEqual(events, [
    { componentStack: "\\n    in Cart", handled: false, level: "error", mechanism: "react.uncaught_error", type: "TypeError" },
    { componentStack: "\\n    in Price", handled: true, level: "error", mechanism: "react.caught_error", type: "RangeError" },
    { componentStack: "\\n    in Header", handled: true, level: "warning", mechanism: "react.recoverable_error", type: "Error" }
  ]);
  assert.equal(logged.length, 3, "React's default console reporting stays on unless the app passes its own handler");
  assert.deepEqual(fromApp, [["hydration mismatch", "\\n    in Header"]]);
`;

test("React 19 root options report uncaught, caught, and recoverable errors (ESM)", () => {
  const result = runConsumer(`
    import assert from "node:assert/strict";
    import { LogBrewClient } from "@logbrew/sdk";
    import { LogBrewErrorBoundary, createLogBrewReactRootOptions } from "@logbrew/react";
    ${scenario}
  `, "mjs");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("React 19 root options report uncaught, caught, and recoverable errors (CommonJS)", () => {
  const result = runConsumer(`
    const assert = require("node:assert/strict");
    const { LogBrewClient } = require("@logbrew/sdk");
    const { LogBrewErrorBoundary, createLogBrewReactRootOptions } = require("@logbrew/react");
    ${scenario}
  `, "cjs");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("a failing capture never breaks React's error reporting", () => {
  const result = runConsumer(`
    import assert from "node:assert/strict";
    import { createLogBrewReactRootOptions } from "@logbrew/react";
    const seen = [];
    const options = createLogBrewReactRootOptions({ issue() { throw new Error("queue full"); } }, {
      onUncaughtError: (error) => { seen.push(error.message); }
    });
    options.onUncaughtError(new Error("render failed"), { componentStack: "" });
    assert.deepEqual(seen, ["render failed"]);
  `, "mjs");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("the React Router navigation hook accepts a trace ID alone and never throws into the page", () => {
  const result = runConsumer(`
    import assert from "node:assert/strict";
    import { LogBrewClient } from "@logbrew/sdk";
    import { useLogBrewReactRouterNavigation } from "@logbrew/react";

    const client = new LogBrewClient({ apiKey: "LOGBREW_CLIENT_KEY" });
    globalThis.logbrewClient = client;
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    useLogBrewReactRouterNavigation({ location: "/orders/sample", routeTemplate: "/orders/:orderId", traceId });
    useLogBrewReactRouterNavigation({ location: "/settings", routeTemplate: "/settings" });
    useLogBrewReactRouterNavigation({ location: "/help", routeTemplate: "/help", traceparent: "malformed" });

    const spans = JSON.parse(client.previewJson()).events.map(({ attributes }) => attributes);
    assert.deepEqual(spans.map(({ name }) => name), ["react.route /orders/:orderId", "react.route /settings"]);
    assert.equal(spans[0].traceId, traceId);
    assert.match(spans[0].spanId, /^[0-9a-f]{16}$/u);
    assert.match(spans[1].traceId, /^[0-9a-f]{32}$/u);
  `, "mjs", effectReact);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

const slowRouteScenario = `
  const slashes = "/".repeat(50000);
  const started = performance.now();
  const template = createReactRouterRouteTemplate([
    { route: { path: slashes + "shop" } },
    { route: { path: "items" + slashes + "list" } }
  ]);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 100, "route template took " + elapsed + " ms");
  assert.equal(template, slashes + "shop/items" + slashes + "list");
  assert.equal(createReactRouterRouteTemplate([{ route: { path: "/shop//" } }, { route: { path: "items//" } }]), "/shop/items");
`;

test("React Router route templates stay fast on long slash runs (ESM)", () => {
  const result = runConsumer(`
    import assert from "node:assert/strict";
    import { createReactRouterRouteTemplate } from "@logbrew/react";
    ${slowRouteScenario}
  `, "mjs");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("React Router route templates stay fast on long slash runs (CommonJS)", () => {
  const result = runConsumer(`
    const assert = require("node:assert/strict");
    const { createReactRouterRouteTemplate } = require("@logbrew/react");
    ${slowRouteScenario}
  `, "cjs");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("React events carry the router trace and 1 tab session, and 2 identical errors get different IDs", () => {
  const result = runConsumer(`
    import assert from "node:assert/strict";
    import { captureReactError, captureReactRouterNavigation, createLogBrewReactClient } from "@logbrew/react";
    const client = createLogBrewReactClient({ clientKey: "LOGBREW_CLIENT_KEY" });
    captureReactRouterNavigation(client, {
      routeTemplate: "/checkout/:cartId",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    });
    captureReactError(client, new Error("payment declined"));
    captureReactError(client, new Error("payment declined"));
    client.log("evt_react_log_test", "2026-11-24T10:00:00Z", { level: "warn", message: "payment step failing" });
    const [span, first, second, log] = JSON.parse(client.previewJson()).events;
    assert.notEqual(first.id, second.id);
    assert.match(first.id, /^evt_react_error_payment_declined_[0-9a-f]{32}$/u);
    for (const event of [first, second, log]) {
      assert.deepEqual(event.attributes.context.trace, { traceId: span.attributes.traceId, spanId: span.attributes.spanId });
    }
    const sessionIds = new Set([span, first, second, log].map((event) => event.attributes.context.session.id));
    assert.equal(sessionIds.size, 1);
    assert.match([...sessionIds][0], /^[0-9a-f]{32}$/u);
    const off = createLogBrewReactClient({ clientKey: "LOGBREW_CLIENT_KEY", session: false });
    off.log("evt_react_log_off", "2026-11-24T10:00:00Z", { level: "info", message: "opened" });
    assert.equal(JSON.parse(off.previewJson()).events[0].attributes.context, undefined);
  `, "mjs");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("the browser hook's fetch option sends request timings as spans and metrics", () => {
  const result = runConsumer(`
    import assert from "node:assert/strict";
    import { createLogBrewReactClient } from "@logbrew/react";
    import { useLogBrewBrowserInstrumentation } from "@logbrew/react/browser";
    const client = createLogBrewReactClient({ clientKey: "LOGBREW_CLIENT_KEY" });
    globalThis.logbrewClient = client;
    const browserWindow = {
      addEventListener() {},
      fetch: async () => ({ headers: new Headers(), status: 200 }),
      location: { hash: "", href: "https://shop.example.test/checkout", pathname: "/checkout", search: "" },
      removeEventListener() {}
    };
    useLogBrewBrowserInstrumentation({ browserWindow, fetch: true, interactionTiming: false, raiseCaptureErrors: true });
    await browserWindow.fetch("/api/cart");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const events = JSON.parse(client.previewJson()).events;
    assert.deepEqual(events.map(({ type }) => type), ["span", "metric"]);
    assert.equal(events[1].attributes.name, "http.client.duration");
  `, "mjs", effectReact);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
