import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = path.resolve(packageRoot, "../logbrew-js");

test("linked native queue replays an exact event after a JavaScript runtime restart", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore }) => {
    const firstRuntime = await importRuntime("first", true);
    const firstClient = firstRuntime.createLogBrewReactNativeClient({
      automaticDelivery: false,
      clientKey: "LOGBREW_CLIENT_KEY",
      sdkName: "react-native-restart-test",
      sdkVersion: "0.1.0"
    });
    addOfflineLog(firstClient);

    assert.equal(firstClient.deliveryHealth().storage, "persistent");
    assert.equal(firstClient.pendingEvents(), 1);
    assert.equal(nativeStore.records("LOGBREW_CLIENT_KEY").length, 1);

    const sentBodies = [];
    const secondRuntime = await importRuntime("second", true);
    const secondClient = secondRuntime.createLogBrewReactNativeClient({
      automaticDelivery: false,
      clientKey: "LOGBREW_CLIENT_KEY",
      sdkName: "react-native-restart-test",
      sdkVersion: "0.1.0",
      transport: {
        async send(_key, body) {
          sentBodies.push(body);
          return { attempts: 1, statusCode: 202 };
        }
      }
    });

    assert.equal(secondClient.deliveryHealth().storage, "persistent");
    assert.equal(secondClient.deliveryHealth().hydratedEvents, 1);
    assert.equal(secondClient.pendingEvents(), 1);
    await secondClient.flush();

    assert.equal(sentBodies.length, 1);
    assert.equal(JSON.parse(sentBodies[0]).events[0].id, "evt_rn_offline_restart");
    assert.equal(nativeStore.records("LOGBREW_CLIENT_KEY").length, 0);
    await secondClient.shutdown();

    const thirdRuntime = await importRuntime("third", true);
    const thirdClient = thirdRuntime.createLogBrewReactNativeClient({
      automaticDelivery: false,
      clientKey: "LOGBREW_CLIENT_KEY",
      sdkName: "react-native-restart-test",
      sdkVersion: "0.1.0"
    });
    assert.equal(thirdClient.deliveryHealth().hydratedEvents, 0);
    assert.equal(thirdClient.pendingEvents(), 0);
  });
});

test("native queue auto fallback is observable and required mode fails closed", async () => {
  await withNativeRuntimes(async ({ importRuntime }) => {
    const autoRuntime = await importRuntime("auto-fallback", false);
    const memoryClient = autoRuntime.createLogBrewReactNativeClient({
      automaticDelivery: false,
      clientKey: "LOGBREW_CLIENT_KEY"
    });
    assert.equal(memoryClient.deliveryHealth().storage, "memory");
    assert.throws(
      () => autoRuntime.createLogBrewReactNativeClient({
        automaticDelivery: false,
        clientKey: "LOGBREW_INVALID_CONFIG_KEY",
        maxQueueSize: 0
      }),
      (error) => error.code === "validation_error"
        && /maxQueueSize must be a positive integer/u.test(error.message)
    );

    const requiredRuntime = await importRuntime("required-missing", false);
    assert.throws(
      () => requiredRuntime.createLogBrewReactNativeClient({
        automaticDelivery: false,
        clientKey: "DO_NOT_EXPOSE_THIS_KEY",
        persistentQueue: "required"
      }),
      (error) => error.code === "configuration_error"
        && /requires the linked LogBrew native module/u.test(error.message)
        && !error.message.includes("DO_NOT_EXPOSE_THIS_KEY")
    );
  });
});

test("an older linked native binary falls back in auto mode and fails clearly when required", async () => {
  await withNativeRuntimes(async ({ importRuntime }) => {
    const autoRuntime = await importRuntime("legacy-auto", "legacy");
    const memoryClient = autoRuntime.createLogBrewReactNativeClient({
      automaticDelivery: false,
      clientKey: "LOGBREW_CLIENT_KEY"
    });
    assert.equal(memoryClient.deliveryHealth().storage, "memory");

    const requiredRuntime = await importRuntime("legacy-required", "legacy");
    assert.throws(
      () => requiredRuntime.createLogBrewReactNativeClient({
        automaticDelivery: false,
        clientKey: "LOGBREW_CLIENT_KEY",
        persistentQueue: "required"
      }),
      /requires the linked LogBrew native module/u
    );
  });
});

test("failed native hydration closes its handle and permits same-key recovery", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore }) => {
    nativeStore.seed("LOGBREW_CLIENT_KEY", {
      eventBytes: 8,
      serializedEvent: "not-json"
    });
    const runtime = await importRuntime("failed-hydration", true);
    assert.throws(
      () => runtime.createLogBrewReactNativeClient({
        automaticDelivery: false,
        clientKey: "LOGBREW_CLIENT_KEY"
      }),
      (error) => error.code === "persistence_error"
    );
    assert.deepEqual(nativeStore.calls.slice(-2), [
      ["load", "LOGBREW_CLIENT_KEY"],
      ["close", "LOGBREW_CLIENT_KEY"]
    ]);

    runtime.purgeLogBrewReactNativePersistentQueue({
      clientKey: "LOGBREW_CLIENT_KEY"
    });
    const recovered = runtime.createLogBrewReactNativeClient({
      automaticDelivery: false,
      clientKey: "LOGBREW_CLIENT_KEY",
      transport: {
        async send() {
          return { attempts: 1, statusCode: 202 };
        }
      }
    });
    assert.equal(recovered.pendingEvents(), 0);
    await recovered.shutdown();
  });
});

test("native persistence rejects queue limits above its durable bounds at startup", async () => {
  await withNativeRuntimes(async ({ importRuntime }) => {
    const runtime = await importRuntime("bounded", true);
    assert.throws(
      () => runtime.createLogBrewReactNativeClient({
        automaticDelivery: false,
        clientKey: "LOGBREW_CLIENT_KEY",
        maxQueueBytes: 4 * 1024 * 1024 + 1
      }),
      /maxQueueBytes must be at most 4194304/u
    );
    assert.throws(
      () => runtime.createLogBrewReactNativeClient({
        automaticDelivery: false,
        clientKey: "LOGBREW_CLIENT_KEY",
        maxQueueSize: 1001
      }),
      /maxQueueSize must be at most 1000/u
    );

    const memoryClient = runtime.createLogBrewReactNativeClient({
      automaticDelivery: false,
      clientKey: "LOGBREW_CLIENT_KEY",
      maxQueueBytes: 4 * 1024 * 1024 + 1,
      maxQueueSize: 1001,
      persistentQueue: "disabled"
    });
    assert.equal(memoryClient.deliveryHealth().storage, "memory");
  });
});

test("disabled native persistence stays memory-only and never touches the store", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore }) => {
    const runtime = await importRuntime("disabled", true);
    const client = runtime.createLogBrewReactNativeClient({
      automaticDelivery: false,
      clientKey: "LOGBREW_CLIENT_KEY",
      persistentQueue: "disabled"
    });
    addOfflineLog(client);

    assert.equal(client.deliveryHealth().storage, "memory");
    assert.equal(nativeStore.calls.length, 0);
  });
});

test("explicit eventStore remains available without invoking the native queue", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore }) => {
    const runtime = await importRuntime("explicit-store", true);
    const records = [];
    const eventStore = {
      load() {
        return [];
      },
      append(record) {
        records.push(record);
      },
      acknowledge(count) {
        records.splice(0, count);
      },
      purge() {
        records.splice(0, records.length);
      },
      close() {}
    };
    assert.throws(
      () => runtime.createLogBrewReactNativeClient({
        automaticDelivery: false,
        clientKey: "LOGBREW_CLIENT_KEY",
        eventStore,
        persistentQueue: "auto"
      }),
      /eventStore and persistentQueue are mutually exclusive/u
    );
    const client = runtime.createLogBrewReactNativeClient({
      automaticDelivery: false,
      clientKey: "LOGBREW_CLIENT_KEY",
      eventStore
    });
    addOfflineLog(client);

    assert.equal(client.deliveryHealth().storage, "persistent");
    assert.equal(records.length, 1);
    assert.equal(nativeStore.calls.length, 0);
  });
});

test("purge requires an inactive queue owner and clears the selected key only", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore }) => {
    const runtime = await importRuntime("purge", true);
    const client = runtime.createLogBrewReactNativeClient({
      automaticDelivery: false,
      clientKey: "LOGBREW_CLIENT_KEY",
      transport: {
        async send() {
          return { attempts: 1, statusCode: 202 };
        }
      }
    });
    addOfflineLog(client);
    assert.throws(
      () => runtime.purgeLogBrewReactNativePersistentQueue({
        clientKey: "LOGBREW_CLIENT_KEY"
      }),
      /while its client is active/u
    );
    await client.shutdown();

    nativeStore.seed("LOGBREW_CLIENT_KEY", serializedOfflineRecord());
    nativeStore.seed("OTHER_CLIENT_KEY", serializedOfflineRecord("evt_other_key"));
    runtime.purgeLogBrewReactNativePersistentQueue({
      clientKey: "LOGBREW_CLIENT_KEY"
    });

    assert.equal(nativeStore.records("LOGBREW_CLIENT_KEY").length, 0);
    assert.equal(nativeStore.records("OTHER_CLIENT_KEY").length, 1);
    assert.deepEqual(nativeStore.calls.slice(-2), [
      ["purge", "LOGBREW_CLIENT_KEY"],
      ["close", "LOGBREW_CLIENT_KEY"]
    ]);
  });
});

test("public documentation distinguishes durable, fallback, recovery, and duplicate semantics", () => {
  const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8");
  assert.match(readme, /Offline And Restart Delivery/u);
  assert.match(readme, /persistentQueue: "required"/u);
  assert.match(readme, /Expo Go and an older app binary/u);
  assert.match(readme, /health\.storage !== "persistent"/u);
  assert.match(readme, /commits which records were accepted before removing/u);
  assert.match(readme, /duplicate but cannot silently lose/u);
  assert.match(readme, /apps must tolerate duplicates/u);
  assert.match(readme, /1,000 events and 4 MiB/u);
  assert.match(readme, /client key is\s+not written to disk/iu);
  assert.match(readme, /purgeLogBrewReactNativePersistentQueue/u);
  assert.match(readme, /does not provide mathematically exactly-once\s+delivery/u);
});

function addOfflineLog(client) {
  client.log("evt_rn_offline_restart", "2026-07-31T08:30:00.000Z", {
    level: "error",
    message: "Offline restart delivery proof",
    metadata: {
      runtime: "react-native"
    }
  });
}

function serializedOfflineRecord(id = "evt_rn_offline_restart") {
  const serializedEvent = JSON.stringify({
    type: "log",
    id,
    timestamp: "2026-07-31T08:30:00.000Z",
    attributes: {
      level: "error",
      message: "Offline restart delivery proof",
      metadata: {
        runtime: "react-native"
      }
    }
  });
  return {
    eventBytes: Buffer.byteLength(serializedEvent),
    serializedEvent
  };
}

async function withNativeRuntimes(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-rn-native-delivery-"));
  const nativeStore = createNativeStore();
  globalThis.__LOGBREW_REACT_NATIVE_TEST_STORE__ = nativeStore;
  try {
    await callback({
      nativeStore,
      async importRuntime(name, linked) {
        const packageDir = installRuntime(root, name, linked);
        return import(pathToFileURL(path.join(packageDir, "index.native.js")));
      }
    });
  } finally {
    delete globalThis.__LOGBREW_REACT_NATIVE_TEST_STORE__;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function installRuntime(root, name, linked) {
  const nodeModules = path.join(root, name, "node_modules");
  const packageDir = path.join(nodeModules, "@logbrew", "react-native");
  fs.mkdirSync(path.dirname(packageDir), { recursive: true });
  fs.cpSync(packageRoot, packageDir, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`)
  });
  fs.symlinkSync(sdkRoot, path.join(nodeModules, "@logbrew", "sdk"), "dir");

  const reactDir = path.join(nodeModules, "react");
  fs.mkdirSync(reactDir, { recursive: true });
  fs.writeFileSync(
    path.join(reactDir, "package.json"),
    JSON.stringify({
      name: "react",
      version: "18.0.0",
      type: "module",
      exports: {
        import: "./index.js",
        require: "./index.cjs"
      }
    }),
    "utf8"
  );
  const reactSource = "{createContext(value){return {_currentValue:value}},createElement(){return {}},useContext(context){return context._currentValue},useMemo(factory){return factory()}}";
  fs.writeFileSync(
    path.join(reactDir, "index.js"),
    `export default ${reactSource};\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(reactDir, "index.cjs"),
    `module.exports=${reactSource};\n`,
    "utf8"
  );

  const reactNativeDir = path.join(nodeModules, "react-native");
  fs.mkdirSync(reactNativeDir, { recursive: true });
  fs.writeFileSync(
    path.join(reactNativeDir, "package.json"),
    JSON.stringify({ name: "react-native", version: "0.83.0", type: "module", main: "index.js" }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(reactNativeDir, "index.js"),
    [
      "const linked = " + JSON.stringify(linked) + ";",
      "const store = linked === true ? globalThis.__LOGBREW_REACT_NATIVE_TEST_STORE__ : linked === 'legacy' ? {readFatalRecord(){return {status: 'empty'}}} : undefined;",
      "export const AppState = {currentState: 'active'};",
      "export const Platform = {OS: 'ios', Version: '26.0'};",
      "export const NativeModules = store ? {LogBrewFatalStore: store} : {};",
      "export const TurboModuleRegistry = {get(name){return name === 'LogBrewFatalStore' ? store : undefined}};"
    ].join("\n"),
    "utf8"
  );
  return packageDir;
}

function createNativeStore() {
  const queues = new Map();
  const calls = [];
  const queue = (key) => {
    if (!queues.has(key)) {
      queues.set(key, []);
    }
    return queues.get(key);
  };
  return {
    calls,
    records(key) {
      return queue(key);
    },
    seed(key, record) {
      queue(key).push({ ...record });
    },
    loadEventRecords(key) {
      calls.push(["load", key]);
      return {
        status: "loaded",
        records: queue(key).map((record) => ({ ...record }))
      };
    },
    appendEventRecord(key, serializedEvent, eventBytes) {
      calls.push(["append", key]);
      queue(key).push({ serializedEvent, eventBytes });
      return { status: "appended" };
    },
    acknowledgeEventRecords(key, count) {
      calls.push(["acknowledge", key, count]);
      if (!Number.isSafeInteger(count) || count < 0 || count > queue(key).length) {
        return { status: "storage_error" };
      }
      queue(key).splice(0, count);
      return { status: "acknowledged" };
    },
    purgeEventRecords(key) {
      calls.push(["purge", key]);
      queue(key).splice(0, queue(key).length);
      return { status: "purged" };
    },
    closeEventStore(key) {
      calls.push(["close", key]);
      return { status: "closed" };
    }
  };
}
