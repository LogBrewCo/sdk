import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsDir = path.resolve(packageDir, "..");

// Runs a consumer against the package with a minimal React stand-in, from both module formats.
function runConsumer(source, extension) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-react-root-"));
  try {
    const scope = path.join(root, "node_modules", "@logbrew");
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(path.join(jsDir, "logbrew-js"), path.join(scope, "sdk"), "dir");
    fs.symlinkSync(packageDir, path.join(scope, "react"), "dir");
    const react = path.join(root, "node_modules", "react");
    fs.mkdirSync(react, { recursive: true });
    fs.writeFileSync(path.join(react, "package.json"), JSON.stringify({ name: "react", main: "index.js" }));
    fs.writeFileSync(path.join(react, "index.js"), [
      "class Component { constructor(props) { this.props = props; } setState() {} }",
      "module.exports = { Component, createContext() { return {}; }, createElement() { return null; }, useContext() {}, useEffect() {}, useRef() { return {}; } };",
      ""
    ].join("\n"));
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
