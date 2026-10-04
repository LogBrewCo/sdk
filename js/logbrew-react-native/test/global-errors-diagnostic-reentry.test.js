import assert from "node:assert/strict";
import test from "node:test";
import {
  createClient,
  createErrorUtils,
  withInstalledPackage
} from "./global-errors-test-support.js";

test("recursive diagnostics stop after one callback and preserve handler delegation", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const client = createClient();
    const error = new Error("application error");
    let previousCalls = 0;
    const errorUtils = createErrorUtils(() => {
      previousCalls += 1;
      errorUtils.currentHandler()(error, false);
    });
    const diagnostics = [];
    const installation = installLogBrewReactNativeGlobalErrorHandler({
      client,
      errorUtils,
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
        if (diagnostics.length < 10) {
          errorUtils.currentHandler()(new Error("diagnostic callback failed"), false);
        }
      }
    });
    errorUtils.currentHandler()(error, false);
    assert.equal(diagnostics.length, 1);
    assert.equal(previousCalls, 1);
    assert.equal(client.issues.length, 1);
    assert.equal(installation.health().suppressedEvents, 2);
    assert.equal(installation.remove(), true);
  });
});

test("a failed capture emits one diagnostic even when its callback reports another error", async () => {
  await withInstalledPackage(async ({ installLogBrewReactNativeGlobalErrorHandler }) => {
    const client = createClient({ fail: true });
    let previousCalls = 0;
    const errorUtils = createErrorUtils(() => { previousCalls += 1; });
    const diagnostics = [];
    const installation = installLogBrewReactNativeGlobalErrorHandler({
      client,
      errorUtils,
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
        if (diagnostics.length < 10) {
          errorUtils.currentHandler()(new Error("diagnostic callback failed"), false);
        }
      }
    });
    errorUtils.currentHandler()(new Error("application error"), false);
    assert.deepEqual(diagnostics, [{ code: "capture_failed" }]);
    assert.equal(previousCalls, 1);
    assert.equal(installation.health().capturedEvents, 0);
    assert.equal(installation.health().suppressedEvents, 1);
    assert.equal(installation.remove(), true);
  });
});
