import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The react-native condition resolves the app entry Metro bundles. This stands in for the linked native module.
const packageEntry = fileURLToPath(import.meta.resolve("@logbrew/react-native"));
const reactNative = path.resolve(path.dirname(packageEntry), "../../react-native");
fs.mkdirSync(reactNative, { recursive: true });
fs.writeFileSync(`${reactNative}/package.json`, JSON.stringify({ name: "react-native", type: "module", main: "index.js" }));
fs.writeFileSync(`${reactNative}/index.js`, [
  "const store = { processStartTime: () => performance.timeOrigin };",
  "export const AppState = { currentState: 'active' };",
  "export const DeviceEventEmitter = { addListener: () => ({ remove() {} }) };",
  "export const Platform = { OS: 'android', Version: 35 };",
  "export const NativeModules = { LogBrewFatalStore: store };",
  "export const TurboModuleRegistry = { get: (name) => (name === 'LogBrewFatalStore' ? store : undefined) };"
].join("\n"));
const { installLogBrewConsoleCapture } = await import("@logbrew/sdk");
const {
  captureReactNativeError,
  createLogBrewReactNativeClient,
  createReactNativeFetchTransport,
  createReactNativeTraceContext,
  withLogBrewTrace
} = await import("@logbrew/react-native");
const { installLogBrewReactNativeGlobalErrorHandler } = await import("@logbrew/react-native/global-errors");
const { createLogBrewReactNativeInstrumentation } = await import("@logbrew/react-native/instrumentation");

const api = http.createServer((request, response) => {
  response.statusCode = request.url.startsWith("/api/fail") ? 500 : 200;
  response.end("{}");
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${api.address().port}`;

const platform = { OS: "android", Version: 35, isPad: false, constants: { isTesting: true } };
const appStateListeners = new Set();
const appState = {
  currentState: "active",
  addEventListener(_type, listener) {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  }
};
let route = { name: "Checkout", path: "/checkout" };
const navigationListeners = new Map();
const navigationContainer = {
  getCurrentRoute: () => route,
  addListener(name, listener) {
    navigationListeners.set(name, listener);
    return () => navigationListeners.delete(name);
  }
};
let globalHandler = () => undefined;
const errorUtils = { getGlobalHandler: () => globalHandler, setGlobalHandler: (handler) => { globalHandler = handler; } };
const globalObject = { fetch: globalThis.fetch.bind(globalThis) };

const endpoint = process.env.LOGBREW_CAPTURE_ENDPOINT;
const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  context: {
    schemaVersion: 1,
    resource: {
      service: { name: "checkout-mobile" },
      deployment: { environment: "production", release: "mobile@1.2.3" }
    },
    subject: { kind: "user", id: "user_123" }
  },
  transport: createReactNativeFetchTransport({
    endpoint: "https://intake.example.test/v1/events",
    fetchImpl: (_url, init) => fetch(endpoint, init)
  })
});
const consoleCapture = installLogBrewConsoleCapture({ client, console, levels: ["info", "warn"], logger: "console" });
const errorHandler = installLogBrewReactNativeGlobalErrorHandler({ client, errorUtils });
const trace = createReactNativeTraceContext({ traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" });
const instrumentation = createLogBrewReactNativeInstrumentation(client, {
  trace,
  platform,
  appState,
  navigationContainer,
  globalObject,
  instrumentGlobalFetch: true,
  screen: "Checkout",
  tracePropagationTargets: [`${origin}/api/`],
  captureInitialLifecycleState: true,
  captureInitialNavigationRoute: true
});

await withLogBrewTrace(trace, async () => {
  console.info("checkout started");
  await (await globalObject.fetch(`${origin}/api/cart`)).text();
  route = { name: "Payment", path: "/payment" };
  navigationListeners.get("state")?.();
  await (await instrumentation.resourceFetch(`${origin}/api/fail`, { method: "POST" })).text();
  console.warn("payment step failing");
  try {
    throw new Error("payment declined");
  } catch (error) {
    captureReactNativeError(client, error, { platform, appState, screen: "Payment", trace });
  }
});
errorUtils.getGlobalHandler()(new Error("receipt render failed"), false);
for (const listener of appStateListeners) {
  listener("background");
}

instrumentation.remove();
errorHandler.remove();
consoleCapture.uninstall();
await client.shutdown();
api.close();
fs.rmSync(reactNative, { recursive: true, force: true });
