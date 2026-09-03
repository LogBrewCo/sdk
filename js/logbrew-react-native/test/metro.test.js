import assert from "node:assert/strict";
import test from "node:test";

import {
  createLogBrewMetroSerializer,
  getLogBrewExpoConfig,
  withLogBrewMetroConfig,
} from "../metro.js";

const DEBUG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function graph({ dev = false, hot = false } = {}) {
  return {
    dependencies: new Map(),
    transformOptions: { dev, hot },
  };
}

function serializerOptions() {
  return {
    createModuleId: () => 1,
    processModuleFilter: () => true,
    shouldAddToIgnoreList: () => false,
  };
}

function moduleCode(module) {
  return module.output?.[0]?.data?.code ?? "";
}

test("Metro wrapper composes an app serializer and injects one production Debug ID", async () => {
  const calls = [];
  const appSerializer = async (entryPoint, preModules, dependencyGraph, options) => {
    calls.push({ entryPoint, preModules, dependencyGraph, options });
    return {
      code: `${preModules.map(moduleCode).join("\n")}\nglobal.__appStarted=true;\n//@ sourceMappingURL=index.android.bundle.map\n`,
      map: JSON.stringify({
        version: 3,
        file: "index.android.bundle",
        sources: ["index.js"],
        names: [],
        mappings: "AAAA",
      }),
    };
  };
  const config = {
    serializer: {
      customSerializer: appSerializer,
      processModuleFilter: "preserved-filter",
    },
    transformer: { minifierPath: "preserved-minifier" },
  };

  const wrappedConfig = withLogBrewMetroConfig(config);
  const wrappedAgain = withLogBrewMetroConfig(wrappedConfig);
  const result = await wrappedConfig.serializer.customSerializer(
    "index.js",
    [{ path: "__prelude__", output: [] }],
    graph(),
    serializerOptions(),
  );

  assert.notEqual(wrappedConfig, config);
  assert.notEqual(wrappedConfig.serializer, config.serializer);
  assert.equal(config.serializer.customSerializer, appSerializer);
  assert.equal(wrappedConfig.serializer.processModuleFilter, "preserved-filter");
  assert.equal(wrappedConfig.transformer, config.transformer);
  assert.equal(wrappedAgain, wrappedConfig);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].preModules.map((module) => module.path), ["__prelude__", "__logbrew_debug_id__"]);

  const sourceMap = JSON.parse(result.map);
  assert.match(sourceMap.debug_id, DEBUG_ID_PATTERN);
  assert.equal(sourceMap.debugId, sourceMap.debug_id);
  assert.match(result.code, new RegExp(`debugId=${sourceMap.debug_id}`, "u"));
  assert.match(result.code, new RegExp(`logbrew-runtime-debug-id\\*/.*debugId=${sourceMap.debug_id}`, "u"));
  assert.match(result.code, /@logbrew\/react-native\/debug-ids/u);
  assert.doesNotMatch(result.code, /__LOGBREW_REACT_NATIVE_DEBUG_ID__/u);
  assert.ok(result.code.indexOf(`//# debugId=${sourceMap.debug_id}`) < result.code.indexOf("//@ sourceMappingURL="));
});

test("Metro wrapper leaves development serialization unchanged", async () => {
  const originalModules = [{ path: "__prelude__", output: [] }];
  let receivedModules;
  const appSerializer = (_entryPoint, preModules) => {
    receivedModules = preModules;
    return "development-bundle";
  };
  const serializer = createLogBrewMetroSerializer(appSerializer);

  const result = await serializer("index.js", originalModules, graph({ dev: true, hot: true }), serializerOptions());

  assert.equal(result, "development-bundle");
  assert.equal(receivedModules, originalModules);
});

test("Metro wrapper can be explicitly disabled without changing config", () => {
  const config = { serializer: {} };

  assert.equal(withLogBrewMetroConfig(config, { enabled: false }), config);
});

test("Metro wrapper creates a lazy default serializer for standard configs", () => {
  const config = { serializer: { customSerializer: null, processModuleFilter: () => true } };

  const wrappedConfig = withLogBrewMetroConfig(config);

  assert.equal(typeof wrappedConfig.serializer.customSerializer, "function");
  assert.equal(wrappedConfig.serializer.processModuleFilter, config.serializer.processModuleFilter);
});

test("Metro wrapper rejects production serializers that discard the Debug ID module", async () => {
  const serializer = createLogBrewMetroSerializer(() => ({
    code: "global.__appStarted=true;",
    map: JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }),
  }));

  await assert.rejects(
    serializer("index.js", [{ path: "__prelude__", output: [] }], graph(), serializerOptions()),
    (error) => error?.code === "configuration_error" && /must include the injected Debug ID module/u.test(error.message),
  );
});

test("Metro wrapper rejects custom serializers that already own Debug ID metadata", async () => {
  let calls = 0;
  const serializer = createLogBrewMetroSerializer((_entryPoint, preModules) => {
    calls += 1;
    return {
      code: `${preModules.map(moduleCode).join("\n")}\n//# debugId=11111111-2222-4333-8444-555555555555`,
      map: JSON.stringify({
        version: 3,
        sources: ["index.js"],
        names: [],
        mappings: "AAAA",
        debug_id: "11111111-2222-4333-8444-555555555555",
      }),
    };
  });

  await assert.rejects(
    serializer("index.js", [], graph(), serializerOptions()),
    (error) => error?.code === "configuration_error" && /already contains Debug ID metadata/u.test(error.message),
  );
  assert.equal(calls, 1);
});

test("Metro wrapper derives each reused production build from its current serializer result", async () => {
  let buildNumber = 0;
  const serializer = createLogBrewMetroSerializer((_entryPoint, preModules) => {
    buildNumber += 1;
    return {
      code: `${preModules.map(moduleCode).join("\n")}\nglobal.__buildNumber=${buildNumber};`,
      map: JSON.stringify({
        version: 3,
        file: `index-${buildNumber}.android.bundle`,
        sources: [`index-${buildNumber}.js`],
        names: [],
        mappings: "AAAA",
      }),
    };
  });

  const first = await serializer("index.js", [], graph(), serializerOptions());
  const second = await serializer("index.js", [], graph(), serializerOptions());
  const firstMap = JSON.parse(first.map);
  const secondMap = JSON.parse(second.map);

  assert.equal(buildNumber, 2);
  assert.notEqual(firstMap.debug_id, secondMap.debug_id);
  assert.match(first.code, new RegExp(`debugId=${firstMap.debug_id}`, "u"));
  assert.match(second.code, new RegExp(`debugId=${secondMap.debug_id}`, "u"));
  assert.doesNotMatch(second.code, new RegExp(firstMap.debug_id, "u"));
  assert.equal(secondMap.file, "index-2.android.bundle");
});

test("Expo config helper preserves existing pre-serialization plugins and options", () => {
  const existingPlugin = ({ premodules }) => premodules;
  const expectedConfig = { serializer: {} };
  let receivedProjectRoot;
  let receivedOptions;
  const getDefaultConfig = (projectRoot, options) => {
    receivedProjectRoot = projectRoot;
    receivedOptions = options;
    return expectedConfig;
  };

  const result = getLogBrewExpoConfig("/app", {
    getDefaultConfig,
    isCSSEnabled: true,
    unstable_beforeAssetSerializationPlugins: [existingPlugin],
  });

  assert.equal(result, expectedConfig);
  assert.equal(receivedProjectRoot, "/app");
  assert.equal(receivedOptions.isCSSEnabled, true);
  assert.equal("getDefaultConfig" in receivedOptions, false);
  assert.equal(receivedOptions.unstable_beforeAssetSerializationPlugins.length, 2);
  assert.equal(receivedOptions.unstable_beforeAssetSerializationPlugins[0], existingPlugin);

  const injectedModules = receivedOptions.unstable_beforeAssetSerializationPlugins[1]({
    debugId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    graph: graph(),
    premodules: [{ path: "__prelude__", output: [] }],
  });
  assert.deepEqual(injectedModules.map((module) => module.path), ["__prelude__", "__logbrew_debug_id__"]);
  assert.match(moduleCode(injectedModules[1]), /aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/u);
  assert.match(moduleCode(injectedModules[1]), /@logbrew\/react-native\/debug-ids/u);
  assert.doesNotMatch(moduleCode(injectedModules[1]), /__LOGBREW_REACT_NATIVE_DEBUG_ID__/u);
});

test("Expo plugin leaves serialization unchanged without a Debug ID and rejects malformed IDs", () => {
  const preModules = [{ path: "__prelude__", output: [] }];
  let plugin;
  getLogBrewExpoConfig("/app", {
    getDefaultConfig: (_projectRoot, options) => {
      plugin = options.unstable_beforeAssetSerializationPlugins[0];
      return { serializer: {} };
    },
  });

  assert.equal(plugin({ graph: graph({ dev: true }), premodules: preModules }), preModules);
  assert.throws(
    () => plugin({ debugId: "not-a-debug-id", graph: graph(), premodules: preModules }),
    (error) => error?.code === "configuration_error" && /valid Expo Debug ID/u.test(error.message),
  );
});

test("Metro wrapper gives Expo static serialization an actionable recovery path", async () => {
  const serializer = createLogBrewMetroSerializer(() => []);

  await assert.rejects(
    serializer("index.js", [], graph(), serializerOptions()),
    (error) =>
      error?.code === "configuration_error" &&
      /getLogBrewExpoConfig/u.test(error.message),
  );
});
