import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = path.resolve(packageRoot, "../logbrew-js");
const CLIENT_KEY = "LOGBREW_CLIENT_KEY";

test("native entry creates secure trace identifiers without Web Crypto", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore }) => {
    await withoutWebCrypto(async () => {
      const trace = (await importRuntime("secure-random", true)).createReactNativeTraceContext();
      assert.match(trace.traceId, /^[0-9a-f]{32}$/u);
      assert.match(trace.spanId, /^[0-9a-f]{16}$/u);
      assert.deepEqual(nativeStore.randomLengths, [16, 8]);
    });
  });
});

test("managed and unlinked runtimes use Expo Crypto or fail closed", async () => {
  await withNativeRuntimes(async ({ importRuntime }) => {
    await withoutWebCrypto(async () => {
      const lengths = [];
      globalThis.expo = { modules: { ExpoCrypto: { getRandomValues(bytes) {
        lengths.push(bytes.length);
        bytes.fill(0xcd);
      } } } };
      const managed = await importRuntime("expo-random", false);
      assert.match(managed.createReactNativeTraceContext().traceId, /^(?:cd){16}$/u);
      assert.deepEqual(lengths, [16, 8]);
      delete globalThis.expo;
      assert.throws(() => managed.createReactNativeTraceContext(), /secure random values are unavailable/u);
    });
  });
});

async function withoutWebCrypto(callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  try {
    return await callback();
  } finally {
    delete globalThis.expo;
    if (descriptor) {
      Object.defineProperty(globalThis, "crypto", descriptor);
    } else {
      delete globalThis.crypto;
    }
  }
}

test("linked native queue replays restart and same-process native records", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore, nativeWakeup }) => {
    const firstRuntime = await importRuntime("first", true);
    const firstClient = nativeClient(firstRuntime);
    addOfflineLog(firstClient);

    assert.equal(firstClient.deliveryHealth().storage, "persistent");
    assert.equal(firstClient.pendingEvents(), 1);
    assert.equal(nativeStore.records(CLIENT_KEY).length, 1);

    const sentBodies = [];
    const secondRuntime = await importRuntime("second", true, "android");
    const secondClient = nativeClient(secondRuntime, {
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
    assert.equal(nativeStore.records(CLIENT_KEY).length, 0);
    nativeStore.seed(CLIENT_KEY, serializedOfflineRecord("evt_native_anr"));
    secondClient.log("evt_after_anr", "2026-07-31T08:30:01.000Z", {
      level: "info", message: "main thread recovered"
    });
    nativeWakeup();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.deepEqual(JSON.parse(sentBodies[1]).events.map(({ id }) => id), [
      "evt_native_anr", "evt_after_anr"
    ]);
    await secondClient.shutdown();

    const thirdRuntime = await importRuntime("third", true);
    const thirdClient = nativeClient(thirdRuntime);
    assert.equal(thirdClient.deliveryHealth().hydratedEvents, 0);
    assert.equal(thirdClient.pendingEvents(), 0);
  });
});

test("native queue auto fallback is observable and required mode fails closed", async () => {
  await withNativeRuntimes(async ({ importRuntime }) => {
    const autoRuntime = await importRuntime("auto-fallback", false);
    const memoryClient = nativeClient(autoRuntime);
    assert.equal(memoryClient.deliveryHealth().storage, "memory");
    assert.throws(
      () => nativeClient(autoRuntime, {
        clientKey: "LOGBREW_INVALID_CONFIG_KEY",
        maxQueueSize: 0
      }),
      (error) => error.code === "validation_error"
        && /maxQueueSize must be a positive integer/u.test(error.message)
    );

    const requiredRuntime = await importRuntime("required-missing", false);
    assert.throws(
      () => nativeClient(requiredRuntime, {
        clientKey: "DO_NOT_EXPOSE_THIS_KEY",
        persistentQueue: "required"
      }),
      (error) => error.code === "configuration_error"
        && /requires the linked LogBrew native module/u.test(error.message)
        && !error.message.includes("DO_NOT_EXPOSE_THIS_KEY")
    );
  });
});

test("durable fatal reports survive rejected delivery and restart until accepted delivery removes them", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore }) => {
    const firstRuntime = await importRuntime("fatal-delivery-first", true);
    const first = nativeClient(firstRuntime);
    let handler = () => {};
    const errorUtils = {
      getGlobalHandler() { return handler; },
      setGlobalHandler(value) { handler = value; }
    };
    const installation = firstRuntime.installLogBrewReactNativeGlobalErrorHandler({ client: first, errorUtils });
    handler(new TypeError("private application detail"), true);
    const saved = nativeStore.records(CLIENT_KEY);
    assert.equal(saved.length, 1);
    const id = JSON.parse(saved[0].serializedEvent).id;
    assert.match(id, /^evt_rn_fatal_/u);
    const rejectedBodies = [];
    await assert.rejects(first.flush({ async send(_key, body) {
      rejectedBodies.push(body);
      return { attempts: 1, statusCode: 503 };
    } }));
    assert.equal(nativeStore.records(CLIENT_KEY).length, 1);
    assert.equal(JSON.parse(rejectedBodies[0]).events[0].id, id);
    installation.remove();
    const restartedRuntime = await importRuntime("fatal-delivery-restart", true);
    const restarted = nativeClient(restartedRuntime);
    const acceptedBodies = [];
    await restarted.flush({ async send(_key, body) {
      acceptedBodies.push(body);
      assert.equal(nativeStore.records(CLIENT_KEY).length, 1);
      return { attempts: 1, statusCode: 202 };
    } });
    assert.equal(JSON.parse(acceptedBodies[0]).events[0].id, id);
    assert.equal(nativeStore.records(CLIENT_KEY).length, 0);
    assert.equal(JSON.stringify(acceptedBodies).includes("private application detail"), false);
    const finalRuntime = await importRuntime("fatal-delivery-empty", true);
    assert.equal(nativeClient(finalRuntime).pendingEvents(), 0);
  });
});

test("a fatal at a full durable queue evicts the oldest non-fatal record across restart", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore }) => {
    const runtime = await importRuntime("fatal-eviction-first", true, "android");
    const client = nativeClient(runtime, { maxQueueSize: 2 });
    addOfflineLog(client);
    client.log("evt_rn_kept", "2026-07-31T08:30:01.000Z", { level: "info", message: "kept" });
    let handler = () => {};
    const installation = runtime.installLogBrewReactNativeGlobalErrorHandler({
      client,
      errorUtils: { getGlobalHandler() { return handler; }, setGlobalHandler(value) { handler = value; } }
    });

    handler(new TypeError("private application detail"), true);

    assert.equal(installation.fatalHealth().lastOutcome, "stored");
    assert.equal(client.deliveryHealth().droppedByReason.evicted_for_fatal, 1);
    const ids = nativeStore.records(CLIENT_KEY).map(({ serializedEvent }) => JSON.parse(serializedEvent).id);
    assert.equal(ids[0], "evt_rn_kept");
    assert.match(ids[1], /^evt_rn_fatal_/u);
    assert.deepEqual(nativeStore.calls.filter(([name]) => name === "remove"), [["remove", CLIENT_KEY, [0]]]);
    installation.remove();
    const restarted = nativeClient(await importRuntime("fatal-eviction-restart", true), { maxQueueSize: 2 });
    assert.deepEqual(JSON.parse(restarted.previewJson()).events.map(({ id }) => id), ids);
  });
});

test("a Hermes fatal crash replays once per stable ID with correlation after a kill during replay", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore }) => {
    const debugId = "11111111-2222-4333-8444-555555555555";
    const registry = Symbol.for("@logbrew/react-native/debug-ids");
    globalThis[registry] = { "Error\n    at global (address at index.android.bundle:1:1)": debugId };
    const context = {
      schemaVersion: 1,
      resource: { deployment: { environment: "production", release: "com.example.app@1.2.3+45" } },
      session: { id: "session_123" }
    };
    try {
      const crashed = await importRuntime("fatal-crash", true, "android");
      const client = nativeClient(crashed, { context });
      crashed.captureDefaultScreenView(client, "Checkout");
      let handler = () => {};
      const terminated = [];
      crashed.installLogBrewReactNativeGlobalErrorHandler({
        client,
        errorUtils: { getGlobalHandler: () => handler, setGlobalHandler(value) { handler = value; } }
      });
      handler = ((capture) => (error, isFatal) => {
        capture(error, isFatal);
        terminated.push(nativeStore.records(CLIENT_KEY).length);
      })(handler);
      const error = new TypeError("card 4111 1111 1111 1111 rejected");
      error.stack = [
        "TypeError: card 4111 1111 1111 1111 rejected",
        "    at submitOrder (address at /data/user/0/com.example.app/files/index.android.bundle:1:53210)",
        "    at onPress (address at index.android.bundle:1:9001)"
      ].join("\n");
      handler(error, true);

      assert.deepEqual(terminated, [2]);
      const stored = nativeStore.records(CLIENT_KEY)[1].serializedEvent;
      // The Android module recognizes persisted JavaScript fatal reports by this prefix.
      assert.ok(stored.startsWith("{\"type\":\"issue\",\"id\":\"evt_rn_fatal_"));
      const fatal = JSON.parse(stored);
      assert.equal(fatal.attributes.level, "critical");
      assert.deepEqual(fatal.attributes.exception.mechanism, { type: "react_native_error_utils", handled: false });
      assert.deepEqual(fatal.attributes.stackFrames, [
        { filename: "index.android.bundle", line: 1, column: 53211, function: "submitOrder", debugId },
        { filename: "index.android.bundle", line: 1, column: 9002, function: "onPress", debugId }
      ]);
      assert.equal(fatal.attributes.exceptionChain.entries[0].messageState, "redacted");
      assert.equal(fatal.attributes.metadata.lastRoute, "screen:Checkout");
      assert.equal(fatal.attributes.breadcrumbs.at(-1).message, "screen:Checkout");
      assert.deepEqual(fatal.attributes.context.session, { id: "session_123" });
      assert.equal(fatal.attributes.context.resource.deployment.release, "com.example.app@1.2.3+45");
      for (const forbidden of ["4111", "rejected", "/data/", "com.example.app/files"]) {
        assert.equal(stored.includes(forbidden), false, forbidden);
      }

      const killedBodies = [];
      const killed = nativeClient(await importRuntime("replay-killed", true, "android"));
      void killed.flush({ send(_key, body) {
        killedBodies.push(body);
        return new Promise(() => {});
      } });
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.equal(killedBodies.length, 1);
      assert.equal(nativeStore.records(CLIENT_KEY).length, 2);

      const acceptedBodies = [];
      const relaunched = nativeClient(await importRuntime("replay-relaunched", true, "android"));
      await relaunched.flush({ async send(_key, body) {
        acceptedBodies.push(body);
        return { attempts: 1, statusCode: 202 };
      } });
      const ids = (body) => JSON.parse(body).events.map(({ id }) => id);
      assert.deepEqual(ids(acceptedBodies[0]), ids(killedBodies[0]));
      assert.equal(ids(acceptedBodies[0])[1], fatal.id);
      assert.equal(JSON.parse(acceptedBodies[0]).events[1].attributes.stackFrames[0].debugId, debugId);
      assert.equal(nativeStore.records(CLIENT_KEY).length, 0);
      assert.equal(nativeClient(await importRuntime("replay-empty", true, "android")).pendingEvents(), 0);
    } finally {
      delete globalThis[registry];
    }
  });
});

test("an older linked native binary falls back in auto mode and fails clearly when required", async () => {
  await withNativeRuntimes(async ({ importRuntime }) => {
    const autoRuntime = await importRuntime("legacy-auto", "legacy");
    const memoryClient = nativeClient(autoRuntime);
    assert.equal(memoryClient.deliveryHealth().storage, "memory");

    const requiredRuntime = await importRuntime("legacy-required", "legacy");
    assert.throws(
      () => nativeClient(requiredRuntime, {
        persistentQueue: "required"
      }),
      /requires the linked LogBrew native module/u
    );
  });
});

test("failed native hydration closes its handle and permits same-key recovery", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore }) => {
    nativeStore.seed(CLIENT_KEY, {
      eventBytes: 8,
      serializedEvent: "not-json"
    });
    const runtime = await importRuntime("failed-hydration", true);
    assert.throws(
      () => nativeClient(runtime),
      (error) => error.code === "persistence_error"
    );
    assert.deepEqual(nativeStore.calls.slice(-2), [
      ["load", CLIENT_KEY],
      ["close", CLIENT_KEY]
    ]);

    runtime.purgeLogBrewReactNativePersistentQueue({
      clientKey: CLIENT_KEY
    });
    const recovered = nativeClient(runtime, {
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
      () => nativeClient(runtime, {
        maxQueueBytes: 4 * 1024 * 1024 + 1
      }),
      /maxQueueBytes must be at most 4194304/u
    );
    assert.throws(
      () => nativeClient(runtime, {
        maxQueueSize: 1001
      }),
      /maxQueueSize must be at most 1000/u
    );

    const memoryClient = nativeClient(runtime, {
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
    const client = nativeClient(runtime, {
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
      () => nativeClient(runtime, {
        eventStore,
        persistentQueue: "auto"
      }),
      /eventStore and persistentQueue are mutually exclusive/u
    );
    const client = nativeClient(runtime, { eventStore });
    addOfflineLog(client);

    assert.equal(client.deliveryHealth().storage, "persistent");
    assert.equal(records.length, 1);
    assert.equal(nativeStore.calls.length, 0);
  });
});

test("purge requires an inactive queue owner and clears the selected key only", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore }) => {
    const runtime = await importRuntime("purge", true);
    const client = nativeClient(runtime, {
      transport: {
        async send() {
          return { attempts: 1, statusCode: 202 };
        }
      }
    });
    addOfflineLog(client);
    assert.throws(
      () => runtime.purgeLogBrewReactNativePersistentQueue({
        clientKey: CLIENT_KEY
      }),
      /while its client is active/u
    );
    await client.shutdown();

    nativeStore.seed(CLIENT_KEY, serializedOfflineRecord());
    nativeStore.seed("OTHER_CLIENT_KEY", serializedOfflineRecord("evt_other_key"));
    runtime.purgeLogBrewReactNativePersistentQueue({
      clientKey: CLIENT_KEY
    });

    assert.equal(nativeStore.records(CLIENT_KEY).length, 0);
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
  assert.match(readme, /platform's\s+cryptographic random source/iu);
  assert.match(readme, /never falls back to `Math\.random`/u);
});

test("terminal native close failure removes the Android delivery subscription", async () => {
  await withNativeRuntimes(async ({ importRuntime, nativeStore, listenerCount }) => {
    const runtime = await importRuntime("android-close-failure", true, "android");
    const client = nativeClient(runtime, {
      transport: { async send() { return { attempts: 1, statusCode: 202 }; } }
    });
    addOfflineLog(client);
    assert.equal(listenerCount(), 1);
    nativeStore.closeEventStore = () => ({ status: "storage_error" });
    await assert.rejects(client.shutdown(), (error) => error.code === "persistence_error");
    assert.equal(client.deliveryHealth().lifecycle, "closed");
    assert.equal(listenerCount(), 0);
    assert.equal(nativeStore.records(CLIENT_KEY).length, 0);
  });
});

test("retryable shutdown failure retains Android wakeups until recovery", async () => {
  await withNativeRuntimes(async ({ importRuntime, listenerCount, nativeWakeup }) => {
    let offline = true;
    const bodies = [];
    const runtime = await importRuntime("android-shutdown-retry", true, "android");
    const client = nativeClient(runtime, {
      transport: {
        async send(_key, body) {
          if (offline) {
            throw new Error("offline");
          }
          bodies.push(JSON.parse(body));
          return { attempts: 1, statusCode: 202 };
        }
      }
    });
    addOfflineLog(client);
    await assert.rejects(client.shutdown(), /offline/u);
    assert.equal(client.deliveryHealth().lifecycle, "active");
    assert.equal(listenerCount(), 1);
    offline = false;
    nativeWakeup();
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].events[0].id, "evt_rn_offline_restart");
    await client.shutdown();
    assert.equal(listenerCount(), 0);
  });
});

function nativeClient(runtime, overrides = {}) {
  return runtime.createLogBrewReactNativeClient({
    automaticDelivery: false,
    clientKey: CLIENT_KEY,
    sdkName: "react-native-restart-test",
    sdkVersion: "0.1.0",
    ...overrides
  });
}

function addOfflineLog(client) {
  client.log("evt_rn_offline_restart", "2026-07-31T08:30:00.000Z", {
    level: "error",
    message: "Offline restart delivery proof",
    metadata: { runtime: "react-native" }
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
      metadata: { runtime: "react-native" }
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
  const listeners = new Set();
  globalThis.__LOGBREW_REACT_NATIVE_TEST_STORE__ = nativeStore;
  globalThis.__LOGBREW_REACT_NATIVE_TEST_EMITTER__ = {
    addListener(_name, listener) {
      listeners.add(listener);
      return { remove() { listeners.delete(listener); } };
    }
  };
  try {
    await callback({
      nativeStore,
      listenerCount() {
        return listeners.size;
      },
      nativeWakeup() {
        for (const listener of listeners) {
          listener();
        }
      },
      async importRuntime(name, linked, platform = "ios") {
        const packageDir = installRuntime(root, name, linked, platform);
        return import(pathToFileURL(path.join(packageDir, "index.native.js")));
      }
    });
  } finally {
    delete globalThis[Symbol.for("co.logbrew.react-native.secure-random-hex")];
    delete globalThis.__LOGBREW_REACT_NATIVE_TEST_EMITTER__;
    delete globalThis.__LOGBREW_REACT_NATIVE_TEST_STORE__;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function installRuntime(root, name, linked, platform) {
  const nodeModules = path.join(root, name, "node_modules");
  const packageDir = path.join(nodeModules, "@logbrew", "react-native");
  fs.mkdirSync(path.dirname(packageDir), { recursive: true });
  fs.cpSync(packageRoot, packageDir, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`)
  });
  fs.symlinkSync(sdkRoot, path.join(nodeModules, "@logbrew", "sdk"), "dir");

  const reactDir = path.join(nodeModules, "react");
  const reactSource = "{createContext(value){return {_currentValue:value}},createElement(){return {}},useContext(context){return context._currentValue},useMemo(factory){return factory()}}";
  writePackage(reactDir, {
    name: "react", version: "18.0.0", type: "module",
    exports: { import: "./index.js", require: "./index.cjs" }
  }, { "index.js": `export default ${reactSource};\n`, "index.cjs": `module.exports=${reactSource};\n` });

  const reactNativeDir = path.join(nodeModules, "react-native");
  writePackage(
    reactNativeDir,
    { name: "react-native", version: "0.83.0", type: "module", main: "index.js" },
    { "index.js": [
      `const linked = ${JSON.stringify(linked)};`,
      "const store = linked === true ? globalThis.__LOGBREW_REACT_NATIVE_TEST_STORE__ : linked === 'legacy' ? {readFatalRecord(){return {status: 'empty'}}} : undefined;",
      "export const AppState = {currentState: 'active'};",
      "export const DeviceEventEmitter = globalThis.__LOGBREW_REACT_NATIVE_TEST_EMITTER__;",
      `export const Platform = {OS: ${JSON.stringify(platform)}, Version: '26.0'};`,
      "export const NativeModules = store ? {LogBrewFatalStore: store} : {};",
      "export const TurboModuleRegistry = {get(name){return name === 'LogBrewFatalStore' ? store : undefined}};"
    ].join("\n") }
  );
  return packageDir;
}

function writePackage(directory, manifest, sources) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest), "utf8");
  for (const [name, source] of Object.entries(sources)) {
    fs.writeFileSync(path.join(directory, name), source, "utf8");
  }
}

function createNativeStore() {
  const queues = new Map();
  const calls = [];
  const randomLengths = [];
  const queue = (key) => {
    if (!queues.has(key)) {
      queues.set(key, []);
    }
    return queues.get(key);
  };
  return {
    calls,
    randomLengths,
    records(key) {
      return queue(key);
    },
    seed(key, record) {
      queue(key).push({ ...record });
    },
    secureRandomHex(length) {
      randomLengths.push(length);
      return "ab".repeat(length);
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
    removeEventRecords(key, indexes) {
      calls.push(["remove", key, indexes]);
      queues.set(key, queue(key).filter((_, index) => !indexes.includes(index)));
      return { status: "removed" };
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
