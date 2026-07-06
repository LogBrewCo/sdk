import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = path.resolve(packageRoot, "../logbrew-js");

async function withInstalledPackage(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-rn-source-map-"));
  const nodeModules = path.join(root, "node_modules");
  const packageDir = path.join(nodeModules, "@logbrew", "react-native");
  try {
    fs.mkdirSync(path.dirname(packageDir), { recursive: true });
    fs.cpSync(packageRoot, packageDir, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`)
    });
    fs.symlinkSync(sdkRoot, path.join(nodeModules, "@logbrew", "sdk"), "dir");
    const reactDir = path.join(nodeModules, "react");
    fs.mkdirSync(reactDir, { recursive: true });
    fs.writeFileSync(path.join(reactDir, "package.json"), JSON.stringify({ name: "react", version: "18.0.0", main: "index.cjs" }), "utf8");
    fs.writeFileSync(path.join(reactDir, "index.cjs"), "module.exports={createContext(value){return {_currentValue:value,Provider(){},Consumer(){}}},createElement(type,props,...children){return {type,props:{...(props||{}),children}}}};\n", "utf8");
    return await callback(await import(pathToFileURL(path.join(packageDir, "index.js"))));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("React Native error events attach privacy-bounded release artifact metadata", async () => {
  await withInstalledPackage(async ({ createReactNativeErrorEvent, createReactNativeTraceContext }) => {
    const debugId = "11111111-2222-4333-8444-555555555555";
    const trace = createReactNativeTraceContext({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      spanId: "b7ad6b7169203331"
    });
    const error = new TypeError("Checkout failed with hidden email hidden@example.test");
    error.stack = "TypeError: Checkout failed with hidden email hidden@example.test\n    at checkout (https://static.example.test/react-native/index.android.bundle?email=hidden@example.test#pay:12:34)";

    const event = createReactNativeErrorEvent(error, {
      appState: { currentState: "active" },
      debugIdMap: { "https://static.example.test/react-native/index.android.bundle?email=hidden@example.test#pay": debugId },
      environment: "production",
      platform: { OS: "ios" },
      release: "2026.07.06-rn",
      runtime: "react-native",
      screen: "Checkout",
      service: "checkout-mobile",
      trace
    });
    const metadata = event.attributes.metadata;
    const serialized = JSON.stringify(event.attributes);

    assert.equal(event.attributes.title, "React Native error: Checkout failed with hidden email hidden@example.test");
    assert.equal(metadata.source, "react-native.error");
    assert.equal(metadata.releaseArtifactDebugId, debugId);
    assert.equal(metadata.releaseArtifactCodeFile, "/react-native/index.android.bundle");
    assert.equal(metadata.errorFrameFile, "/react-native/index.android.bundle");
    assert.equal(metadata.issueGroupingKey, "react-native.error:TypeError:/react-native/index.android.bundle");
    assert.equal(metadata.errorFrameLine, 12);
    assert.equal(metadata.errorFrameColumn, 34);
    assert.equal(metadata.release, "2026.07.06-rn");
    assert.equal(metadata.environment, "production");
    assert.equal(metadata.service, "checkout-mobile");
    assert.equal(metadata.runtime, "react-native");
    assert.equal(metadata.platform, "ios");
    assert.equal(metadata.appState, "active");
    assert.equal(metadata.screen, "Checkout");
    assert.equal(metadata.traceId, trace.traceId);
    assert.equal(metadata.spanId, trace.spanId);
    assert.equal(metadata.parentSpanId, trace.parentSpanId);
    assert.equal(metadata.errorName, "TypeError");
    assert.equal(metadata.errorValueType, "object");
    assert.equal(serialized.includes("static.example.test"), false);
    assert.equal(serialized.includes("email=hidden"), false);
    assert.equal(serialized.includes("#pay"), false);
    assert.equal(serialized.includes("errorStack"), false);
  });
});
