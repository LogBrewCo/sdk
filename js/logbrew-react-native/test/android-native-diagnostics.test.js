import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = path.resolve(packageRoot, "../logbrew-js");
const projectId = "550e8400-e29b-41d4-a716-446655440000";

test("installs Android crash and ANR capture with one bounded durable configuration", async () => {
  const calls = [];
  const nativeModule = {
    installAndroidDiagnostics(configuration) {
      calls.push(configuration);
      return { pending: 1, status: "installed" };
    }
  };
  await withRuntime(nativeModule, async (runtime) => {
    const receipt = runtime.installLogBrewAndroidNativeDiagnostics({
      anrThresholdMs: 5000,
      clientKey: "LOGBREW_CLIENT_KEY",
      environment: "production",
      fatalHandlerOwnership: "logbrew",
      projectId,
      release: "com.example.app@1.2.3+45",
      service: "android-app"
    });

    assert.deepEqual(receipt, { pending: 1, status: "installed" });
    assert.equal(Object.isFrozen(receipt), true);
    assert.deepEqual(calls, [{
      anrThresholdMs: 5000,
      clientKey: "LOGBREW_CLIENT_KEY",
      environment: "production",
      fatalHandlerOwnership: "logbrew",
      projectId,
      release: "com.example.app@1.2.3+45",
      service: "android-app"
    }]);
  });
});

test("requires exclusive ownership and rejects unbounded or identifying configuration", async () => {
  await withRuntime({}, async (runtime) => {
    const valid = {
      clientKey: "LOGBREW_CLIENT_KEY",
      environment: "production",
      fatalHandlerOwnership: "logbrew",
      projectId,
      release: "com.example.app@1.2.3+45",
      service: "android-app"
    };
    const cases = [
      [{ ...valid, fatalHandlerOwnership: undefined }, /fatalHandlerOwnership/u],
      [{ ...valid, fatalHandlerOwnership: "shared" }, /fatalHandlerOwnership/u],
      [{ ...valid, anrThresholdMs: 1999 }, /anrThresholdMs/u],
      [{ ...valid, anrThresholdMs: 60001 }, /anrThresholdMs/u],
      [{ ...valid, projectId: projectId.toUpperCase() }, /lowercase UUID/u],
      [{ ...valid, service: "person@example.test" }, /service/u],
      [{ ...valid, extra: "private" }, /unsupported key/u]
    ];
    for (const [configuration, message] of cases) {
      assert.throws(
        () => runtime.installLogBrewAndroidNativeDiagnostics(configuration),
        (error) => error.code === "configuration_error"
          && message.test(error.message)
          && !error.message.includes("person@example.test")
      );
    }
  });
});

test("returns content-free status and rollback receipts", async () => {
  const nativeModule = {
    androidDiagnosticsStatus() {
      return { pending: 2, status: "ready" };
    },
    uninstallAndroidDiagnostics() {
      return { pending: 2, status: "uninstalled" };
    }
  };
  await withRuntime(nativeModule, async (runtime) => {
    assert.deepEqual(runtime.getLogBrewAndroidNativeDiagnosticsStatus(), {
      pending: 2,
      status: "ready"
    });
    assert.deepEqual(runtime.uninstallLogBrewAndroidNativeDiagnostics(), {
      pending: 2,
      status: "uninstalled"
    });
  });
});

test("maps native failures without echoing configuration values", async () => {
  const hidden = "DO_NOT_ECHO_THIS_CLIENT_KEY";
  await withRuntime({
    installAndroidDiagnostics() {
      return { code: "android_diagnostics_owned", status: "error" };
    }
  }, async (runtime) => {
    assert.throws(
      () => runtime.installLogBrewAndroidNativeDiagnostics({
        clientKey: hidden,
        environment: "production",
        fatalHandlerOwnership: "logbrew",
        projectId,
        release: "com.example.app@1.2.3+45",
        service: "android-app"
      }),
      (error) => error.code === "android_diagnostics_owned"
        && !error.message.includes(hidden)
    );
  });
});

test("ships linked Android capture, symbol upload, rollback, and migration instructions", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8");
  const gradle = fs.readFileSync(path.join(packageRoot, "android", "build.gradle"), "utf8");

  assert.match(readme, /installLogBrewAndroidNativeDiagnostics/u);
  assert.match(readme, /ANR/u);
  assert.match(readme, /next launch/u);
  assert.match(readme, /logbrew debug-artifacts upload/u);
  assert.match(readme, /exact-release Android\s+symbols/u);
  assert.match(readme, /uninstallLogBrewAndroidNativeDiagnostics/u);
  assert.doesNotMatch(readme, /Android native crash and ANR capture are not included/u);
  assert.match(gradle, /externalNativeBuild/u);
  assert.equal(packageJson.files.includes("android-native-diagnostics.js"), true);
});

async function withRuntime(nativeModule, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-rn-android-diagnostics-"));
  globalThis.__LOGBREW_ANDROID_DIAGNOSTICS_TEST_MODULE__ = nativeModule;
  try {
    const nodeModules = path.join(root, "node_modules");
    const installedPackage = path.join(nodeModules, "@logbrew", "react-native");
    fs.mkdirSync(installedPackage, { recursive: true });
    for (const file of ["android-native-diagnostics.js"]) {
      fs.copyFileSync(path.join(packageRoot, file), path.join(installedPackage, file));
    }
    fs.writeFileSync(
      path.join(installedPackage, "package.json"),
      JSON.stringify({ name: "@logbrew/react-native", type: "module" }),
      "utf8"
    );
    fs.symlinkSync(sdkRoot, path.join(nodeModules, "@logbrew", "sdk"), "dir");
    const reactNativeRoot = path.join(nodeModules, "react-native");
    fs.mkdirSync(reactNativeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(reactNativeRoot, "package.json"),
      JSON.stringify({ name: "react-native", type: "module", main: "index.js" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(reactNativeRoot, "index.js"),
      [
        "const nativeModule = globalThis.__LOGBREW_ANDROID_DIAGNOSTICS_TEST_MODULE__;",
        "export const Platform = {OS: 'android'};",
        "export const NativeModules = nativeModule ? {LogBrewFatalStore: nativeModule} : {};",
        "export const TurboModuleRegistry = {get(name){return name === 'LogBrewFatalStore' ? nativeModule : undefined}};"
      ].join("\n"),
      "utf8"
    );
    await callback(await import(pathToFileURL(
      path.join(installedPackage, "android-native-diagnostics.js")
    )));
  } finally {
    delete globalThis.__LOGBREW_ANDROID_DIAGNOSTICS_TEST_MODULE__;
    fs.rmSync(root, { force: true, recursive: true });
  }
}
