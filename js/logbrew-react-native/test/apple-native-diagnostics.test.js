import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = path.resolve(packageRoot, "../logbrew-js");
const projectId = "550e8400-e29b-41d4-a716-446655440000";

test("installs Apple diagnostics with an exact privacy-bounded native configuration", async () => {
  const calls = [];
  const nativeModule = {
    installNativeDiagnostics(configuration) {
      calls.push(configuration);
      return {
        acknowledged: 0,
        discarded: 0,
        lifecycle: "installed",
        pending: 2,
        status: "installed"
      };
    }
  };
  await withRuntime({ nativeModule }, async (runtime) => {
    const result = runtime.installLogBrewAppleNativeDiagnostics({
      clientKey: "LOGBREW_CLIENT_KEY",
      endpoint: "https://api.example.test/v1/events",
      environment: "production",
      fatalHandlerOwnership: "logbrew",
      hangThresholdSeconds: 2,
      projectId,
      release: "co.example.app@1.2.3+45",
      service: "ios-app"
    });

    assert.deepEqual(result, {
      acknowledged: 0,
      discarded: 0,
      lifecycle: "installed",
      pending: 2,
      status: "installed"
    });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(calls, [{
      apiKey: "LOGBREW_CLIENT_KEY",
      endpoint: "https://api.example.test/v1/events",
      environment: "production",
      fatalHandlerOwnership: "logbrew",
      hangThresholdSeconds: 2,
      projectId,
      release: "co.example.app@1.2.3+45",
      service: "ios-app"
    }]);
  });
});

test("requires explicit fatal-handler ownership and rejects ambiguous configuration", async () => {
  await withRuntime({ nativeModule: {} }, async (runtime) => {
    const valid = {
      clientKey: "LOGBREW_CLIENT_KEY",
      environment: "production",
      fatalHandlerOwnership: "logbrew",
      projectId,
      release: "co.example.app@1.2.3+45",
      service: "ios-app"
    };
    const cases = [
      [{ ...valid, fatalHandlerOwnership: undefined }, /fatalHandlerOwnership/u],
      [{ ...valid, apiKey: "SECOND_KEY" }, /mutually exclusive/u],
      [{ ...valid, hangThresholdSeconds: 0.5 }, /hangThresholdSeconds/u],
      [{ ...valid, projectId: projectId.toUpperCase() }, /lowercase UUID/u],
      [{ ...valid, unknown: true }, /unsupported key/u]
    ];
    for (const [configuration, message] of cases) {
      assert.throws(
        () => runtime.installLogBrewAppleNativeDiagnostics(configuration),
        (error) => error.code === "configuration_error" && message.test(error.message)
      );
    }
  });
});

test("requires a privacy-bounded HTTPS replay endpoint", async () => {
  await withRuntime({ nativeModule: {} }, async (runtime) => {
    const embeddedAuthValue = ["pass", "word"].join("");
    const valid = {
      clientKey: "LOGBREW_CLIENT_KEY",
      environment: "production",
      fatalHandlerOwnership: "logbrew",
      projectId,
      release: "co.example.app@1.2.3+45",
      service: "ios-app"
    };
    for (const endpoint of [
      "http://api.example.test/v1/events",
      `https://user:${embeddedAuthValue}@api.example.test/v1/events`,
      "https://api.example.test/v1/events?key=hidden",
      "https://api.example.test/v1/events#private",
      "https://api.example.test/v1/../events"
    ]) {
      assert.throws(
        () => runtime.installLogBrewAppleNativeDiagnostics({ ...valid, endpoint }),
        (error) => error.code === "configuration_error"
          && !error.message.includes(embeddedAuthValue)
          && !error.message.includes("hidden")
      );
    }
  });
});

test("fails clearly outside iOS or without the optional native subspec", async () => {
  await withRuntime({ nativeModule: undefined }, async (runtime) => {
    assert.throws(
      () => runtime.getLogBrewAppleNativeDiagnosticsStatus(),
      (error) => error.code === "native_diagnostics_unavailable"
        && /AppleDiagnostics CocoaPods subspec/u.test(error.message)
    );
  });
  await withRuntime({ nativeModule: {}, platform: "android" }, async (runtime) => {
    assert.throws(
      () => runtime.getLogBrewAppleNativeDiagnosticsStatus(),
      (error) => error.code === "unsupported_platform"
    );
  });
});

test("returns bounded status and replay receipts without exposing the client key", async () => {
  const nativeModule = {
    nativeDiagnosticsStatus() {
      return {
        acknowledged: 3,
        discarded: 1,
        lifecycle: "installed",
        pending: 0,
        status: "ready"
      };
    },
    replayNativeDiagnostics() {
      return Promise.resolve({
        acknowledged: 2,
        attempted: 3,
        discarded: 1,
        pending: 0,
        status: "replayed"
      });
    }
  };
  await withRuntime({ nativeModule }, async (runtime) => {
    assert.deepEqual(runtime.getLogBrewAppleNativeDiagnosticsStatus(), {
      acknowledged: 3,
      discarded: 1,
      lifecycle: "installed",
      pending: 0,
      status: "ready"
    });
    assert.deepEqual(await runtime.replayLogBrewAppleNativeDiagnostics(), {
      acknowledged: 2,
      attempted: 3,
      discarded: 1,
      pending: 0,
      status: "replayed"
    });
  });
});

test("updates and clears one privacy-bounded native crash investigation snapshot", async () => {
  const calls = [];
  const nativeModule = {
    setNativeDiagnosticsContext(context) {
      calls.push(context);
      return { status: context === null ? "cleared" : "updated" };
    }
  };
  await withRuntime({ nativeModule }, async (runtime) => {
    const context = {
      schemaVersion: 1,
      trace: {
        traceId: "11111111222233334444555555555555",
        spanId: "6666666677777777",
        parentSpanId: "8888888899999999",
        sampled: true
      },
      session: { id: "session_current", previousId: "session_previous" },
      subject: { id: "subject_01", kind: "user" },
      impact: {
        failedAction: "checkout.submit",
        userVisibleOutcome: "The order was not confirmed."
      }
    };

    assert.deepEqual(runtime.setLogBrewAppleNativeCrashContext(context), { status: "updated" });
    assert.deepEqual(runtime.setLogBrewAppleNativeCrashContext(null), { status: "cleared" });
    assert.equal(Object.isFrozen(runtime.setLogBrewAppleNativeCrashContext(context)), true);
    assert.deepEqual(calls, [context, null, context]);
  });
});

test("native client mirrors its validated breadcrumb history into Apple crash capture", async () => {
  const calls = [];
  const nativeModule = {
    setNativeDiagnosticsBreadcrumbs(snapshot) {
      calls.push(structuredClone(snapshot));
      return { status: snapshot === null ? "cleared" : "updated" };
    }
  };
  await withRuntime({ entry: "index.native.js", nativeModule }, async (runtime) => {
    const client = runtime.createLogBrewReactNativeClient({
      clientKey: "LOGBREW_CLIENT_KEY",
      persistentQueue: "disabled"
    });
    client.addBreadcrumb({
      category: "navigation",
      data: { sequence: 1 },
      level: "warn",
      message: "Checkout",
      type: "navigation"
    }, "2026-08-28T03:00:00Z");
    client.addBreadcrumb({ category: "ui.action" }, "2026-08-28T03:00:01Z");
    assert.equal(client.clearBreadcrumbs(), 2);

    assert.deepEqual(calls, [
      null,
      {
        breadcrumbs: [{
          category: "navigation",
          data: { sequence: 1 },
          level: "warning",
          message: "Checkout",
          timestamp: "2026-08-28T03:00:00Z",
          type: "navigation"
        }],
        schemaVersion: 1,
        truncated: false
      },
      {
        breadcrumbs: [
          {
            category: "navigation",
            data: { sequence: 1 },
            level: "warning",
            message: "Checkout",
            timestamp: "2026-08-28T03:00:00Z",
            type: "navigation"
          },
          { category: "ui.action", timestamp: "2026-08-28T03:00:01Z" }
        ],
        schemaVersion: 1,
        truncated: false
      },
      null
    ]);
  });
});

test("missing or not-installed Apple diagnostics do not break normal breadcrumbs", async () => {
  for (const nativeModule of [
    undefined,
    {
      setNativeDiagnosticsBreadcrumbs() {
        return { code: "native_diagnostics_not_installed", status: "error" };
      }
    }
  ]) {
    await withRuntime({ entry: "index.native.js", nativeModule }, async (runtime) => {
      const client = runtime.createLogBrewReactNativeClient({
        clientKey: "LOGBREW_CLIENT_KEY",
        persistentQueue: "disabled"
      });
      client.addBreadcrumb({ category: "navigation" }, "2026-08-28T03:00:00Z");
      client.issue("11111111-2222-4333-8444-555555555555", "2026-08-28T03:00:01Z", {
        level: "error",
        title: "Example"
      });
      const event = JSON.parse(client.previewJson()).events[0];
      assert.equal(event.attributes.breadcrumbs[0].category, "navigation");
    });
  }
});

test("native breadcrumb bridge errors never echo breadcrumb values", async () => {
  const privateValue = "DO_NOT_ECHO_THIS_BREADCRUMB";
  const nativeModule = {
    setNativeDiagnosticsBreadcrumbs(snapshot) {
      return snapshot === null
        ? { status: "cleared" }
        : { code: "native_diagnostics_failed", status: "error" };
    }
  };
  await withRuntime({ entry: "index.native.js", nativeModule }, async (runtime) => {
    const client = runtime.createLogBrewReactNativeClient({
      clientKey: "LOGBREW_CLIENT_KEY",
      persistentQueue: "disabled"
    });
    assert.throws(
      () => client.addBreadcrumb({ category: "ui", message: privateValue }),
      (error) => error.code === "native_diagnostics_failed"
        && !error.message.includes(privateValue)
    );
    client.issue("11111111-2222-4333-8444-555555555555", "2026-08-28T03:00:01Z", {
      level: "error",
      title: "Example"
    });
    assert.equal(JSON.parse(client.previewJson()).events[0].attributes.breadcrumbs, undefined);
  });
});

test("rejects broad malformed or identifying native crash context before bridging", async () => {
  const calls = [];
  const nativeModule = {
    setNativeDiagnosticsContext(context) {
      calls.push(context);
      return { status: "updated" };
    }
  };
  await withRuntime({ nativeModule }, async (runtime) => {
    for (const context of [
      undefined,
      { schemaVersion: 1, resource: { service: { name: "ios-app" } } },
      { schemaVersion: 1, tags: { feature: "checkout" } },
      { schemaVersion: 1, trace: { traceId: "0".repeat(32) } },
      { schemaVersion: 1, session: { id: "192.0.2.1" } },
      { schemaVersion: 1, subject: { id: "person@example.test", kind: "user" } },
      { schemaVersion: 1, subject: { id: "subject_01", kind: "identified" } },
      { schemaVersion: 1, impact: { affectedUserSegment: "cohort" } },
      { schemaVersion: 1, impact: { failedAction: "checkout.submit?email=person@example.test" } },
      { schemaVersion: 1, impact: { failedAction: "checkout\u0085submit" } },
      { schemaVersion: 1, impact: { failedAction: "checkout.submit", extra: "private" } }
    ]) {
      assert.throws(
        () => runtime.setLogBrewAppleNativeCrashContext(context),
        (error) => error.code === "configuration_error"
          && !error.message.includes("person@example.test")
      );
    }
    assert.deepEqual(calls, []);
  });
});

test("maps native failures to stable content-free SDK errors", async () => {
  const hiddenValue = "DO_NOT_ECHO_THIS_CLIENT_KEY";
  const nativeModule = {
    installNativeDiagnostics() {
      return { code: "crash_capture_owned", status: "error" };
    },
    replayNativeDiagnostics() {
      return Promise.reject(new Error(hiddenValue));
    }
  };
  await withRuntime({ nativeModule }, async (runtime) => {
    assert.throws(
      () => runtime.installLogBrewAppleNativeDiagnostics({
        clientKey: hiddenValue,
        environment: "production",
        fatalHandlerOwnership: "logbrew",
        projectId,
        release: "co.example.app@1.2.3+45",
        service: "ios-app"
      }),
      (error) => error.code === "crash_capture_owned"
        && !error.message.includes(hiddenValue)
    );
    await assert.rejects(
      runtime.replayLogBrewAppleNativeDiagnostics(),
      (error) => error.code === "native_diagnostics_failed"
        && !error.message.includes(hiddenValue)
    );
  });
});

test("keeps the native bridge version and public Apple diagnostics contract aligned", () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(packageRoot, "package.json"),
    "utf8"
  ));
  const nativeBridge = fs.readFileSync(
    path.join(
      packageRoot,
      "ios",
      "AppleDiagnostics",
      "LBRNAppleNativeDiagnostics.swift"
    ),
    "utf8"
  );
  const podspec = fs.readFileSync(
    path.join(packageRoot, "LogBrewReactNative.podspec"),
    "utf8"
  );
  const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8");

  assert.ok(
    nativeBridge.includes(
      `private static let sdkVersion = ${JSON.stringify(packageJson.version)}`
    )
  );
  assert.match(podspec, /:tag => "js\/logbrew-react-native\/v#\{spec\.version\}"/u);
  assert.match(podspec, /diagnostics\.dependency "KSCrash\/Recording", "2\.6\.0"/u);
  assert.match(podspec, /core\.source_files = "ios\/\*\*\/\*\.\{h,m,mm\}"/u);
  assert.match(podspec, /"ios\/AppleDiagnostics\/\*\*\/\*"/u);
  assert.match(readme, /@logbrew\/react-native\/expo/u);
  assert.match(readme, /LogBrewReactNative\/AppleNativeDiagnostics/u);
  assert.match(readme, /Expo Go cannot load this native\s+module/u);
  assert.match(readme, /fatalHandlerOwnership: "logbrew"/u);
  assert.match(readme, /only one integration may install native fatal capture/u);
  assert.match(readme, /Android native crash and ANR diagnostics/u);
  assert.match(readme, /logbrew debug-artifacts upload/u);
  assert.match(readme, /logbrew debug-artifacts lookup/u);
  assert.match(readme, /exact Mach-O UUID and architecture lookup\s+succeeds/u);
  assert.match(readme, /setLogBrewAppleNativeCrashContext/u);
  assert.match(readme, /opaque app-owned identifiers/u);
});

test("matches the React Native New Architecture promise selector", () => {
  const nativeModule = fs.readFileSync(
    path.join(
      packageRoot,
      "ios",
      "AppleDiagnostics",
      "LBRNAppleDiagnosticsModule.mm"
    ),
    "utf8"
  );

  assert.match(
    nativeModule,
    /replayNativeDiagnostics:\(RCTPromiseResolveBlock\)resolve\s+reject:/u
  );
  assert.match(nativeModule, /setNativeDiagnosticsContext:\(NSDictionary \*\)context/u);
  assert.match(nativeModule, /setNativeDiagnosticsBreadcrumbs:\(NSDictionary \*\)snapshot/u);
  assert.doesNotMatch(nativeModule, /replayNativeDiagnostics:[\s\S]*?rejecter:/u);

  const spec = fs.readFileSync(
    path.join(packageRoot, "src", "NativeLogBrewAppleDiagnostics.ts"),
    "utf8"
  );
  assert.match(spec, /setNativeDiagnosticsBreadcrumbs\(/u);
});

test("namespaces embedded Swift Objective-C classes for safe package coexistence", () => {
  const generatedCrashApi = fs.readFileSync(
    path.join(
      packageRoot,
      "ios",
      "GeneratedAppleDiagnostics",
      "LogBrewCrash",
      "NativeCrashPublic.swift"
    ),
    "utf8"
  );

  assert.doesNotMatch(generatedCrashApi, /@objc\(LBW/u);
  assert.match(generatedCrashApi, /@objc\(LBRNAppleNativeCrashConfiguration\)/u);
});

test("keeps native storage project-scoped and the endpoint fail-closed", () => {
  const nativeBridge = fs.readFileSync(
    path.join(
      packageRoot,
      "ios",
      "AppleDiagnostics",
      "LBRNAppleNativeDiagnostics.swift"
    ),
    "utf8"
  );

  assert.match(nativeBridge, /prepareStorageDirectory\(\s*projectId:/u);
  assert.match(nativeBridge, /LogBrewAppleDiagnostics-\\\(projectId\)/u);
  assert.match(nativeBridge, /components\.scheme == "https"/u);
  assert.match(nativeBridge, /components\.user == nil/u);
  assert.match(nativeBridge, /components\.query == nil/u);
  assert.match(nativeBridge, /components\.fragment == nil/u);
});

async function withRuntime({ entry = "apple-native-diagnostics.js", nativeModule, platform = "ios" }, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-rn-apple-diagnostics-"));
  globalThis.__LOGBREW_APPLE_DIAGNOSTICS_TEST_MODULE__ = nativeModule;
  try {
    const nodeModules = path.join(root, "node_modules");
    const installedPackage = path.join(nodeModules, "@logbrew", "react-native");
    fs.mkdirSync(installedPackage, { recursive: true });
    const packageFiles = entry === "index.native.js"
      ? [
          "apple-native-diagnostics.js",
          "android-native-diagnostics.js",
          "fatal-replay.cjs",
          "global-errors.cjs",
          "global-errors.js",
          "global-errors.native.js",
          "index.cjs",
          "index.js",
          "index.native.js",
          "metadata.cjs",
          "persistent-delivery.native.js",
          "promise-rejections.cjs"
        ]
      : ["apple-native-diagnostics.js"];
    for (const file of packageFiles) {
      fs.copyFileSync(path.join(packageRoot, file), path.join(installedPackage, file));
    }
    fs.writeFileSync(
      path.join(installedPackage, "package.json"),
      JSON.stringify({ name: "@logbrew/react-native", type: "module" }),
      "utf8"
    );
    fs.symlinkSync(sdkRoot, path.join(nodeModules, "@logbrew", "sdk"), "dir");

    const reactRoot = path.join(nodeModules, "react");
    fs.mkdirSync(reactRoot, { recursive: true });
    fs.writeFileSync(
      path.join(reactRoot, "index.cjs"),
      "module.exports={createContext:()=>({Provider:{}}),createElement:()=>null,useContext:()=>null,useMemo:(value)=>value()};",
      "utf8"
    );
    fs.writeFileSync(
      path.join(reactRoot, "package.json"),
      JSON.stringify({ name: "react", main: "index.cjs" }),
      "utf8"
    );

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
        "const nativeModule = globalThis.__LOGBREW_APPLE_DIAGNOSTICS_TEST_MODULE__;",
        `export const Platform = {OS: ${JSON.stringify(platform)}};`,
        "export const AppState = {currentState: 'active', addEventListener(){return {remove(){}}}};",
        "export const NativeModules = nativeModule ? {LogBrewAppleDiagnostics: nativeModule} : {};",
        "export const TurboModuleRegistry = {get(name){return name === 'LogBrewAppleDiagnostics' ? nativeModule : undefined}};"
      ].join("\n"),
      "utf8"
    );
    const runtime = await import(pathToFileURL(
      path.join(installedPackage, entry)
    ));
    await callback(runtime);
  } finally {
    delete globalThis.__LOGBREW_APPLE_DIAGNOSTICS_TEST_MODULE__;
    fs.rmSync(root, { force: true, recursive: true });
  }
}
