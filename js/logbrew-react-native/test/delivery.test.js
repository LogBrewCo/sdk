import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = path.resolve(packageRoot, "../logbrew-js");

async function withInstalledPackage(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-rn-delivery-"));
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
    fs.writeFileSync(
      path.join(reactDir, "package.json"),
      JSON.stringify({ name: "react", version: "18.0.0", main: "index.cjs" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(reactDir, "index.cjs"),
      "module.exports={createContext(value){return {_currentValue:value,Provider:function Provider(){},Consumer:function Consumer(){}}},createElement(type,props,...children){return {type,props:{...(props||{}),children}}},useContext(context){return context._currentValue},useMemo(factory){return factory()}};\n",
      "utf8"
    );

    const native = await import(pathToFileURL(path.join(packageDir, "index.js")));
    return await callback(native);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function addSetupLog(client, id = "evt_react_native_setup") {
  client.log(id, "2026-07-30T12:00:00Z", {
    level: "info",
    message: "React Native setup check",
    metadata: {
      environment: "development",
      service: "mobile-app"
    }
  });
}

function acceptedResponse(retryAfter = null) {
  return {
    status: 202,
    headers: {
      get(name) {
        return name.toLowerCase() === "retry-after" ? retryAfter : null;
      }
    }
  };
}

test("React Native fetch transport performs hosted delivery with the configured client transport", async () => {
  await withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createReactNativeFetchTransport
  }) => {
    const requests = [];
    const transport = createReactNativeFetchTransport({
      async fetchImpl(endpoint, init) {
        requests.push({ endpoint, init });
        return acceptedResponse("2");
      }
    });
    const client = createLogBrewReactNativeClient({
      automaticDelivery: false,
      clientKey: "LOGBREW_CLIENT_KEY",
      sdkName: "react-native-delivery-test",
      sdkVersion: "0.1.0",
      transport
    });

    addSetupLog(client);
    const response = await client.flush();

    assert.deepEqual(response, {
      attempts: 1,
      batches: 1,
      statusCode: 202
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].endpoint, "https://api.logbrew.co/v1/events");
    assert.deepEqual(requests[0].init.headers, {
      authorization: "Bearer LOGBREW_CLIENT_KEY",
      "content-type": "application/json"
    });
    assert.equal(requests[0].init.keepalive, undefined);
    assert.equal(requests[0].init.method, "POST");
    assert.match(requests[0].init.body, /React Native setup check/u);
    assert.equal(client.pendingEvents(), 0);
    assert.equal(client.deliveryHealth().lastOutcome, "accepted");
  });
});

test("React Native fetch transport forwards Retry-After without exposing fetch failures", async () => {
  await withInstalledPackage(async ({
    createReactNativeFetchTransport
  }) => {
    const rateLimited = createReactNativeFetchTransport({
      fetchImpl: async () => ({
        status: 429,
        headers: {
          get(name) {
            return name.toLowerCase() === "retry-after" ? "3" : null;
          }
        }
      })
    });
    assert.deepEqual(
      await rateLimited.send("LOGBREW_CLIENT_KEY", "{}"),
      { attempts: 1, retryAfterMs: 3000, statusCode: 429 }
    );

    const failed = createReactNativeFetchTransport({
      fetchImpl: async () => {
        throw new Error("do-not-copy-fetch-detail");
      }
    });
    await assert.rejects(
      failed.send("LOGBREW_CLIENT_KEY", "{}"),
      (error) => error.code === "network_failure"
        && error.retryable === true
        && !error.message.includes("do-not-copy-fetch-detail")
    );
  });
});

test("React Native client uses core automatic delivery instead of app-owned flush intervals", async () => {
  await withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createReactNativeFetchTransport
  }) => {
    let sends = 0;
    const client = createLogBrewReactNativeClient({
      clientKey: "LOGBREW_CLIENT_KEY",
      deliveryQueueThreshold: 1,
      sdkName: "react-native-automatic-delivery-test",
      sdkVersion: "0.1.0",
      transport: createReactNativeFetchTransport({
        fetchImpl: async () => {
          sends += 1;
          return acceptedResponse();
        }
      })
    });

    addSetupLog(client, "evt_react_native_automatic_setup");
    await waitFor(() => client.pendingEvents() === 0);

    assert.equal(sends, 1);
    assert.equal(client.deliveryHealth().automaticDelivery, true);
    assert.equal(client.deliveryHealth().lastOutcome, "accepted");
  });
});

test("app-state listener can flush configured delivery before the app backgrounds", async () => {
  await withInstalledPackage(async ({
    createAppStateListener,
    createLogBrewReactNativeClient,
    createReactNativeFetchTransport
  }) => {
    let listener;
    let removed = false;
    let sends = 0;
    const appState = {
      currentState: "active",
      addEventListener(_name, nextListener) {
        listener = nextListener;
        return {
          remove() {
            removed = true;
          }
        };
      }
    };
    const client = createLogBrewReactNativeClient({
      automaticDelivery: false,
      clientKey: "LOGBREW_CLIENT_KEY",
      sdkName: "react-native-background-delivery-test",
      sdkVersion: "0.1.0",
      transport: createReactNativeFetchTransport({
        fetchImpl: async () => {
          sends += 1;
          return acceptedResponse();
        }
      })
    });
    addSetupLog(client, "evt_react_native_background_setup");

    const remove = createAppStateListener(client, appState, {
      flushOnBackground: true,
      id: "evt_react_native_background_state",
      timestamp: "2026-07-30T12:00:01Z"
    });
    listener("background");
    await waitFor(() => client.pendingEvents() === 0);

    assert.equal(sends, 1);
    remove();
    assert.equal(removed, true);
  });
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  assert.fail("condition was not met");
}
