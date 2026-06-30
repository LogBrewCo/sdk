import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = path.resolve(packageRoot, "../logbrew-js");

async function withInstalledPackage(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-rn-instrumentation-"));
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
      "module.exports={createContext(value){return {_currentValue:value,Provider:function Provider(){},Consumer:function Consumer(){}}},createElement(type,props,...children){return {type,props:{...(props||{}),children}}}};\n",
      "utf8"
    );

    const native = await import(pathToFileURL(path.join(packageDir, "index.js")));
    const instrumentation = await import(pathToFileURL(path.join(packageDir, "instrumentation.js")));
    const resourceFetch = await import(pathToFileURL(path.join(packageDir, "resource-fetch.js")));
    return await callback({ ...native, ...instrumentation, ...resourceFetch });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeClient(createLogBrewReactNativeClient) {
  return createLogBrewReactNativeClient({
    clientKey: "LOGBREW_CLIENT_KEY",
    sdkName: "react-native-instrumentation-test",
    sdkVersion: "0.1.0"
  });
}

function makeTrace(createReactNativeTraceContext) {
  return createReactNativeTraceContext({
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    spanId: "b7ad6b7169203331"
  });
}

test("React Native instrumentation can opt into reversible global fetch spans", async () => {
  await withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createLogBrewReactNativeInstrumentation,
    createReactNativeTraceContext
  }) => {
    const client = makeClient(createLogBrewReactNativeClient);
    const trace = makeTrace(createReactNativeTraceContext);
    const requests = [];
    const globalObject = {
      async fetch(input, init = {}) {
        requests.push({ input, init });
        return { status: 202 };
      }
    };
    const originalFetch = globalObject.fetch;
    const instrumentation = createLogBrewReactNativeInstrumentation(client, {
      globalObject,
      instrumentGlobalFetch: true,
      metadata: { flow: "checkout", nested: { dropped: true } },
      now: () => "2026-06-23T10:00:00Z",
      nowMs: (() => {
        const values = [1000, 1042];
        return () => values.shift();
      })(),
      screen: "Checkout",
      sessionId: "session_mobile_001",
      trace,
      tracePropagationTargets: ["https://api.example.test/"]
    });

    assert.notEqual(globalObject.fetch, originalFetch);
    assert.equal(typeof instrumentation.globalFetch?.remove, "function");

    const response = await globalObject.fetch("https://api.example.test/api/checkout?email=hidden#pay", {
      method: "POST",
      headers: { accept: "application/json" }
    });

    assert.equal(response.status, 202);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.headers.accept, "application/json");
    assert.equal(
      requests[0].init.headers.traceparent,
      `00-${trace.traceId}-${trace.spanId}-01`
    );

    const events = JSON.parse(client.previewJson()).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].attributes.name, "POST /api/checkout");
    assert.equal(events[0].attributes.durationMs, 42);
    assert.equal(events[0].attributes.metadata.routeTemplate, "/api/checkout");
    assert.equal(events[0].attributes.metadata.traceId, trace.traceId);
    assert.equal(events[0].attributes.metadata.nested, undefined);

    instrumentation.remove();
    assert.equal(globalObject.fetch, originalFetch);
    instrumentation.stop();
    assert.equal(globalObject.fetch, originalFetch);
  });
});

test("React Native global fetch teardown does not clobber later wrappers", () => {
  return withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createLogBrewReactNativeInstrumentation
  }) => {
    const client = makeClient(createLogBrewReactNativeClient);
    const globalObject = {
      async fetch() {
        return { status: 204 };
      }
    };
    const originalFetch = globalObject.fetch;
    const instrumentation = createLogBrewReactNativeInstrumentation(client, {
      globalObject,
      instrumentGlobalFetch: true
    });
    const logBrewFetch = globalObject.fetch;

    assert.notEqual(logBrewFetch, originalFetch);
    async function laterFetch() {
      return { status: 299 };
    }
    globalObject.fetch = laterFetch;

    instrumentation.remove();

    assert.equal(globalObject.fetch, laterFetch);
  });
});

test("React Native resource fetch accepts per-request primitive metadata from a factory", async () => {
  await withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createLogBrewReactNativeInstrumentation,
    createReactNativeTraceContext
  }) => {
    const client = makeClient(createLogBrewReactNativeClient);
    const trace = makeTrace(createReactNativeTraceContext);
    const factoryCalls = [];
    const instrumentation = createLogBrewReactNativeInstrumentation(client, {
      fetchImpl: async (input, init = {}) => ({ status: 200, input, init }),
      metadata: { flow: "checkout" },
      metadataFactory(context) {
        factoryCalls.push(context);
        return {
          graphqlOperationName: "CheckoutSubmit",
          graphqlOperationType: "mutation",
          nested: { dropped: true },
          requestBody: context.init?.body
        };
      },
      now: () => "2026-06-29T07:40:00Z",
      nowMs: (() => {
        const values = [1000, 1024];
        return () => values.shift();
      })(),
      routeTemplateFactory: () => "/graphql",
      trace,
      tracePropagationTargets: ["https://api.example.test/"]
    });

    await instrumentation.resourceFetch("https://api.example.test/graphql?private=hidden", {
      body: JSON.stringify({ operationName: "CheckoutSubmit", variables: { email: "hidden@example.test" } }),
      method: "POST"
    });

    assert.equal(factoryCalls.length, 1);
    assert.equal(factoryCalls[0].method, "POST");
    assert.equal(factoryCalls[0].routeTemplate, "/graphql");
    assert.equal(factoryCalls[0].statusCode, 200);
    assert.equal(factoryCalls[0].durationMs, 24);

    const events = JSON.parse(client.previewJson()).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].attributes.name, "POST /graphql");
    assert.equal(events[0].attributes.metadata.flow, "checkout");
    assert.equal(events[0].attributes.metadata.graphqlOperationName, "CheckoutSubmit");
    assert.equal(events[0].attributes.metadata.graphqlOperationType, "mutation");
    assert.equal(events[0].attributes.metadata.requestBody, undefined);
    assert.equal(events[0].attributes.metadata.nested, undefined);
    assert.equal(JSON.stringify(events).includes("hidden@example.test"), false);
  });
});

test("React Native GraphQL metadata factory extracts bounded operation data without retaining bodies", async () => {
  await withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createLogBrewReactNativeInstrumentation,
    createReactNativeGraphQLMetadataFactory,
    createReactNativeTraceContext
  }) => {
    const client = makeClient(createLogBrewReactNativeClient);
    const trace = makeTrace(createReactNativeTraceContext);
    const instrumentation = createLogBrewReactNativeInstrumentation(client, {
      fetchImpl: async (input, init = {}) => ({ status: 200, input, init }),
      metadata: { flow: "checkout" },
      metadataFactory: createReactNativeGraphQLMetadataFactory(),
      now: () => "2026-06-30T04:30:00Z",
      nowMs: (() => {
        const values = [1000, 1037];
        return () => values.shift();
      })(),
      routeTemplateFactory: () => "/graphql",
      trace,
      tracePropagationTargets: ["https://api.example.test/"]
    });

    await instrumentation.resourceFetch("https://api.example.test/graphql?private=hidden", {
      body: JSON.stringify({
        query: "mutation CheckoutSubmit($email: String!) { checkout(email: $email) { id } }",
        variables: { email: "hidden@example.test" }
      }),
      method: "POST"
    });

    const events = JSON.parse(client.previewJson()).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].attributes.name, "POST /graphql");
    assert.equal(events[0].attributes.durationMs, 37);
    assert.equal(events[0].attributes.metadata.flow, "checkout");
    assert.equal(events[0].attributes.metadata.graphqlOperationName, "CheckoutSubmit");
    assert.equal(events[0].attributes.metadata.graphqlOperationType, "mutation");
    assert.equal(events[0].attributes.metadata.query, undefined);
    assert.equal(events[0].attributes.metadata.variables, undefined);
    assert.equal(events[0].attributes.metadata.body, undefined);
    assert.equal(JSON.stringify(events).includes("hidden@example.test"), false);
    assert.equal(JSON.stringify(events).includes("checkout(email"), false);
  });
});

test("React Native global fetch setup failure tears down earlier instrumentation", () => {
  return withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createLogBrewReactNativeInstrumentation
  }) => {
    const client = makeClient(createLogBrewReactNativeClient);
    const appStateListeners = new Set();
    const appState = {
      currentState: "active",
      addEventListener(_type, listener) {
        appStateListeners.add(listener);
        return {
          remove() {
            appStateListeners.delete(listener);
          }
        };
      }
    };
    const navigationListeners = new Map();
    const navigationContainer = {
      addListener(name, listener) {
        navigationListeners.set(name, listener);
        return {
          remove() {
            navigationListeners.delete(name);
          }
        };
      },
      getCurrentRoute() {
        return { name: "Checkout", path: "/checkout" };
      }
    };
    const nativeBridgeCalls = [];
    const nativeBridge = {
      setLogBrewScope(scope) {
        nativeBridgeCalls.push({ kind: "set", scope });
      },
      clearLogBrewScope() {
        nativeBridgeCalls.push({ kind: "clear" });
      }
    };

    assert.throws(
      () =>
        createLogBrewReactNativeInstrumentation(client, {
          appState,
          globalObject: {},
          instrumentGlobalFetch: true,
          nativeBridge,
          navigationContainer
        }),
      /instrumentGlobalFetch requires globalObject\.fetch/u
    );

    assert.equal(appStateListeners.size, 0);
    assert.equal(navigationListeners.size, 0);
    assert.deepEqual(nativeBridgeCalls.map((call) => call.kind), ["set", "clear"]);
  });
});

test("React Native instrumentation can opt into reversible global XHR spans", async () => {
  await withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createLogBrewReactNativeInstrumentation,
    createReactNativeTraceContext
  }) => {
    const client = makeClient(createLogBrewReactNativeClient);
    const trace = makeTrace(createReactNativeTraceContext);
    const requests = [];

    class MockXMLHttpRequest {
      static HEADERS_RECEIVED = 2;
      static DONE = 4;

      constructor() {
        this.headers = {};
        this.listeners = new Map();
        this.readyState = 0;
        this.status = 0;
      }

      addEventListener(name, listener) {
        this.listeners.set(name, listener);
      }

      open(method, url) {
        this.method = method;
        this.url = url;
      }

      send(body) {
        requests.push({
          body,
          headers: { ...this.headers },
          method: this.method,
          url: this.url
        });
        this.readyState = MockXMLHttpRequest.HEADERS_RECEIVED;
        this.onreadystatechange?.();
        this.listeners.get("readystatechange")?.();
        this.status = 201;
        this.readyState = MockXMLHttpRequest.DONE;
        this.onreadystatechange?.();
        this.listeners.get("readystatechange")?.();
      }

      getResponseHeader(name) {
        if (String(name).toLowerCase() === "content-length") {
          return "1234";
        }
        return null;
      }

      setRequestHeader(name, value) {
        this.headers[String(name).toLowerCase()] = String(value);
      }
    }

    const globalObject = { XMLHttpRequest: MockXMLHttpRequest };
    const originalOpen = MockXMLHttpRequest.prototype.open;
    const originalSend = MockXMLHttpRequest.prototype.send;
    const originalSetRequestHeader = MockXMLHttpRequest.prototype.setRequestHeader;
    const instrumentation = createLogBrewReactNativeInstrumentation(client, {
      globalObject,
      instrumentGlobalXMLHttpRequest: true,
      metadata: { flow: "checkout", nested: { dropped: true } },
      now: () => "2026-06-23T11:00:00Z",
      nowMs: (() => {
        const values = [1000, 1007, 1042];
        return () => values.shift();
      })(),
      screen: "Checkout",
      sessionId: "session_mobile_001",
      trace,
      tracePropagationTargets: ["https://api.example.test/"]
    });

    assert.notEqual(MockXMLHttpRequest.prototype.open, originalOpen);
    assert.notEqual(MockXMLHttpRequest.prototype.send, originalSend);
    assert.equal(MockXMLHttpRequest.prototype.setRequestHeader, originalSetRequestHeader);
    assert.equal(typeof instrumentation.globalXMLHttpRequest?.remove, "function");

    const xhr = new globalObject.XMLHttpRequest();
    xhr.open("POST", "https://api.example.test/api/xhr?email=hidden#pay");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.send("ignored-body");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.accept, "application/json");
    assert.equal(
      requests[0].headers.traceparent,
      `00-${trace.traceId}-${trace.spanId}-01`
    );

    const events = JSON.parse(client.previewJson()).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].attributes.name, "POST /api/xhr");
    assert.equal(events[0].attributes.durationMs, 42);
    assert.equal(events[0].attributes.metadata.routeTemplate, "/api/xhr");
    assert.equal(events[0].attributes.metadata.responseStartDurationMs, 7);
    assert.equal(events[0].attributes.metadata.responseSizeBytes, 1234);
    assert.equal(events[0].attributes.metadata.statusCode, 201);
    assert.equal(events[0].attributes.metadata.traceId, trace.traceId);
    assert.equal(events[0].attributes.metadata.nested, undefined);
    assert.equal(events[0].attributes.metadata.body, undefined);
    assert.equal(JSON.stringify(events).includes("ignored-body"), false);

    instrumentation.remove();
    assert.equal(MockXMLHttpRequest.prototype.open, originalOpen);
    assert.equal(MockXMLHttpRequest.prototype.send, originalSend);
    assert.equal(MockXMLHttpRequest.prototype.setRequestHeader, originalSetRequestHeader);
  });
});

test("React Native XHR GraphQL metadata factory extracts operation data without retaining bodies", async () => {
  await withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createLogBrewReactNativeInstrumentation,
    createReactNativeGraphQLMetadataFactory,
    createReactNativeTraceContext
  }) => {
    const client = makeClient(createLogBrewReactNativeClient);
    const trace = makeTrace(createReactNativeTraceContext);
    const factoryCalls = [];

    class MockXMLHttpRequest {
      static HEADERS_RECEIVED = 2;
      static DONE = 4;

      constructor() {
        this.headers = {};
        this.listeners = new Map();
        this.readyState = 0;
        this.status = 0;
      }

      addEventListener(name, listener) {
        this.listeners.set(name, listener);
      }

      open(method, url) {
        this.method = method;
        this.url = url;
      }

      send() {
        this.readyState = MockXMLHttpRequest.HEADERS_RECEIVED;
        this.listeners.get("readystatechange")?.();
        this.status = 200;
        this.readyState = MockXMLHttpRequest.DONE;
        this.listeners.get("readystatechange")?.();
      }

      getResponseHeader() {
        return null;
      }

      setRequestHeader(name, value) {
        this.headers[String(name).toLowerCase()] = String(value);
      }
    }

    const globalObject = { XMLHttpRequest: MockXMLHttpRequest };
    const instrumentation = createLogBrewReactNativeInstrumentation(client, {
      globalObject,
      instrumentGlobalXMLHttpRequest: true,
      metadata: { flow: "checkout" },
      metadataFactory: createReactNativeGraphQLMetadataFactory({
        metadataFactory(context) {
          factoryCalls.push(context);
          return {
            graphqlResolver: "checkout",
            nested: { dropped: true },
            requestBody: context.init?.body,
            responseHeaders: { dropped: true }
          };
        }
      }),
      now: () => "2026-06-30T05:50:00Z",
      nowMs: (() => {
        const values = [1000, 1012, 1033];
        return () => values.shift();
      })(),
      routeTemplateFactory: () => "/graphql",
      trace,
      tracePropagationTargets: ["https://api.example.test/"]
    });

    const xhr = new globalObject.XMLHttpRequest();
    xhr.open("POST", "https://api.example.test/graphql?email=hidden");
    xhr.send(JSON.stringify({
      query: "mutation CheckoutSubmit($email: String!) { checkout(email: $email) { id } }",
      variables: { email: "hidden@example.test" }
    }));

    const events = JSON.parse(client.previewJson()).events;
    assert.equal(events.length, 1);
    assert.equal(factoryCalls.length, 1);
    assert.equal(factoryCalls[0].method, "POST");
    assert.equal(factoryCalls[0].routeTemplate, "/graphql");
    assert.equal(factoryCalls[0].statusCode, 200);
    assert.equal(events[0].attributes.name, "POST /graphql");
    assert.equal(events[0].attributes.metadata.flow, "checkout");
    assert.equal(events[0].attributes.metadata.graphqlResolver, "checkout");
    assert.equal(events[0].attributes.metadata.graphqlOperationName, "CheckoutSubmit");
    assert.equal(events[0].attributes.metadata.graphqlOperationType, "mutation");
    assert.equal(events[0].attributes.metadata.requestBody, undefined);
    assert.equal(events[0].attributes.metadata.responseHeaders, undefined);
    assert.equal(events[0].attributes.metadata.nested, undefined);
    assert.equal(events[0].attributes.metadata.query, undefined);
    assert.equal(events[0].attributes.metadata.variables, undefined);
    assert.equal(events[0].attributes.metadata.body, undefined);
    assert.equal(JSON.stringify(events).includes("hidden@example.test"), false);
    assert.equal(JSON.stringify(events).includes("checkout(email"), false);

    instrumentation.remove();
  });
});

test("React Native XHR response body size measurement is explicit and does not retain bodies", async () => {
  await withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createLogBrewReactNativeInstrumentation,
    createReactNativeTraceContext
  }) => {
    const client = makeClient(createLogBrewReactNativeClient);
    const trace = makeTrace(createReactNativeTraceContext);

    class MockXMLHttpRequest {
      static HEADERS_RECEIVED = 2;
      static DONE = 4;

      constructor() {
        this.headers = {};
        this.listeners = new Map();
        this.readyState = 0;
        this.responseText = "";
        this.status = 0;
      }

      addEventListener(name, listener) {
        this.listeners.set(name, listener);
      }

      open(method, url) {
        this.method = method;
        this.url = url;
      }

      send() {
        this.readyState = MockXMLHttpRequest.HEADERS_RECEIVED;
        this.listeners.get("readystatechange")?.();
        this.responseText = "ok \u2713";
        this.status = 200;
        this.readyState = MockXMLHttpRequest.DONE;
        this.listeners.get("readystatechange")?.();
      }

      getResponseHeader() {
        return null;
      }

      setRequestHeader(name, value) {
        this.headers[String(name).toLowerCase()] = String(value);
      }
    }

    const globalObject = { XMLHttpRequest: MockXMLHttpRequest };
    const instrumentation = createLogBrewReactNativeInstrumentation(client, {
      globalObject,
      instrumentGlobalXMLHttpRequest: true,
      measureXhrResponseBodySize: true,
      now: () => "2026-06-30T06:40:00Z",
      nowMs: (() => {
        const values = [2000, 2009, 2036];
        return () => values.shift();
      })(),
      trace,
      tracePropagationTargets: ["https://api.example.test/"]
    });

    const xhr = new globalObject.XMLHttpRequest();
    xhr.open("GET", "https://api.example.test/api/measured?private=hidden");
    xhr.send();

    const events = JSON.parse(client.previewJson()).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].attributes.name, "GET /api/measured");
    assert.equal(events[0].attributes.durationMs, 36);
    assert.equal(events[0].attributes.metadata.responseStartDurationMs, 9);
    assert.equal(events[0].attributes.metadata.responseSizeBytes, 6);
    assert.equal(JSON.stringify(events).includes("ok \u2713"), false);

    instrumentation.remove();
  });
});

test("React Native XHR response body size measurement handles binary response objects", async () => {
  await withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createLogBrewReactNativeInstrumentation
  }) => {
    const client = makeClient(createLogBrewReactNativeClient);

    class MockXMLHttpRequest {
      static HEADERS_RECEIVED = 2;
      static DONE = 4;

      constructor() {
        this.listeners = new Map();
        this.readyState = 0;
        this.response = undefined;
        this.responseText = "";
        this.responseType = "arraybuffer";
        this.status = 0;
      }

      addEventListener(name, listener) {
        this.listeners.set(name, listener);
      }

      open(method, url) {
        this.method = method;
        this.url = url;
      }

      send() {
        this.readyState = MockXMLHttpRequest.HEADERS_RECEIVED;
        this.listeners.get("readystatechange")?.();
        this.response = new Uint8Array([1, 2, 3, 4]).buffer;
        this.status = 200;
        this.readyState = MockXMLHttpRequest.DONE;
        this.listeners.get("readystatechange")?.();
      }

      getResponseHeader() {
        return null;
      }

      setRequestHeader() {}
    }

    const globalObject = { XMLHttpRequest: MockXMLHttpRequest };
    const instrumentation = createLogBrewReactNativeInstrumentation(client, {
      globalObject,
      instrumentGlobalXMLHttpRequest: true,
      measureXhrResponseBodySize: true,
      now: () => "2026-06-30T06:42:00Z",
      nowMs: (() => {
        const values = [3000, 3004, 3010];
        return () => values.shift();
      })()
    });

    const xhr = new globalObject.XMLHttpRequest();
    xhr.open("GET", "https://api.example.test/assets/binary");
    xhr.send();

    const events = JSON.parse(client.previewJson()).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].attributes.metadata.responseSizeBytes, 4);

    instrumentation.remove();
  });
});
