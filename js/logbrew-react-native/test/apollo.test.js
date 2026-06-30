import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = path.resolve(packageRoot, "../logbrew-js");

async function withInstalledPackage(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-rn-apollo-"));
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
    const apollo = await import(pathToFileURL(path.join(packageDir, "apollo.js")));
    return await callback({ ...native, ...apollo });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeClient(createLogBrewReactNativeClient) {
  return createLogBrewReactNativeClient({
    clientKey: "LOGBREW_CLIENT_KEY",
    sdkName: "react-native-apollo-test",
    sdkVersion: "0.1.0"
  });
}

function makeTrace(createReactNativeTraceContext) {
  return createReactNativeTraceContext({
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    spanId: "c3ad6b7169205553"
  });
}

class ApolloLink {
  constructor(request) {
    this.request = request;
  }
}

function makeOperation() {
  let context = {
    headers: {
      accept: "application/json",
      authorization: "RedactedAuthHeader"
    }
  };
  return {
    operationName: "CheckoutSubmit",
    query: {
      definitions: [
        { kind: "OperationDefinition", operation: "mutation" }
      ]
    },
    getContext() {
      return context;
    },
    setContext(nextContext) {
      const resolved = typeof nextContext === "function" ? nextContext(context) : nextContext;
      context = {
        ...context,
        ...resolved,
        headers: {
          ...(context.headers ?? {}),
          ...(resolved?.headers ?? {})
        }
      };
    }
  };
}

function observableFrom(handler) {
  return {
    subscribe(observer) {
      handler(observer);
      return { unsubscribe() {} };
    }
  };
}

test("React Native Apollo link records one sanitized GraphQL span and propagates traceparent", async () => {
  await withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createReactNativeApolloLink,
    createReactNativeTraceContext
  }) => {
    const client = makeClient(createLogBrewReactNativeClient);
    const trace = makeTrace(createReactNativeTraceContext);
    const operation = makeOperation();
    const link = createReactNativeApolloLink(client, {
      ApolloLink,
      metadata: { flow: "checkout" },
      metadataFactory(context) {
        return {
          feature: context.operationName,
          requestBody: "{ redacted }",
          variables: { email: "hidden@example.test" }
        };
      },
      now: () => "2026-06-30T08:10:00Z",
      nowMs: (() => {
        const values = [1000, 1041];
        return () => values.shift();
      })(),
      screen: "Checkout",
      trace
    });

    const seen = [];
    link.request(operation, () => observableFrom((observer) => {
      observer.next({ data: { checkout: "ok" } });
      observer.complete();
    })).subscribe({
      complete() {
        seen.push("complete");
      },
      next(value) {
        seen.push(value);
      }
    });

    assert.equal(operation.getContext().headers.accept, "application/json");
    assert.equal(operation.getContext().headers.authorization, "RedactedAuthHeader");
    assert.equal(
      operation.getContext().headers.traceparent,
      `00-${trace.traceId}-${trace.spanId}-01`
    );
    assert.deepEqual(seen, [{ data: { checkout: "ok" } }, "complete"]);

    const events = JSON.parse(client.previewJson()).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].attributes.name, "graphql.mutation CheckoutSubmit");
    assert.equal(events[0].attributes.status, "ok");
    assert.equal(events[0].attributes.durationMs, 41);
    assert.equal(events[0].attributes.metadata.source, "react-native.apollo");
    assert.equal(events[0].attributes.metadata.graphqlOperationName, "CheckoutSubmit");
    assert.equal(events[0].attributes.metadata.graphqlOperationType, "mutation");
    assert.equal(events[0].attributes.metadata.framework, "apollo-client");
    assert.equal(events[0].attributes.metadata.flow, "checkout");
    assert.equal(events[0].attributes.metadata.feature, "CheckoutSubmit");
    assert.equal(events[0].attributes.metadata.requestBody, undefined);
    assert.equal(events[0].attributes.metadata.variables, undefined);
    assert.equal(JSON.stringify(events).includes("hidden@example.test"), false);
    assert.equal(JSON.stringify(events).includes("RedactedAuthHeader"), false);
  });
});

test("React Native Apollo link records exception type only on GraphQL transport failures", async () => {
  await withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createReactNativeApolloLink,
    createReactNativeTraceContext
  }) => {
    const client = makeClient(createLogBrewReactNativeClient);
    const trace = makeTrace(createReactNativeTraceContext);
    const operation = makeOperation();
    const link = createReactNativeApolloLink(client, {
      ApolloLink,
      now: () => "2026-06-30T08:12:00Z",
      nowMs: (() => {
        const values = [2000, 2028];
        return () => values.shift();
      })(),
      trace
    });
    const error = new TypeError("contains private URL https://api.example.test/graphql?debug=redacted");
    let observedError;

    link.request(operation, () => observableFrom((observer) => {
      observer.error(error);
    })).subscribe({
      error(value) {
        observedError = value;
      }
    });

    assert.equal(observedError, error);
    const events = JSON.parse(client.previewJson()).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].attributes.status, "error");
    assert.equal(events[0].attributes.metadata.errorName, "TypeError");
    assert.equal(events[0].attributes.metadata.errorValueType, "object");
    assert.equal(JSON.stringify(events).includes("private URL"), false);
    assert.equal(JSON.stringify(events).includes("debug=redacted"), false);
  });
});

test("React Native Apollo link requires an app-provided ApolloLink constructor", async () => {
  await withInstalledPackage(async ({
    createLogBrewReactNativeClient,
    createReactNativeApolloLink
  }) => {
    const client = makeClient(createLogBrewReactNativeClient);
    assert.throws(
      () => createReactNativeApolloLink(client),
      /ApolloLink/
    );
  });
});
