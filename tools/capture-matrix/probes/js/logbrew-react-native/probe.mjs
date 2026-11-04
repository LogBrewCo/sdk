import http from "node:http";
import { installLogBrewConsoleCapture } from "@logbrew/sdk";
import {
  captureReactNativeError,
  createLogBrewReactNativeClient,
  createReactNativeFetchTransport,
  createReactNativeTraceContext,
  withLogBrewTrace
} from "@logbrew/react-native";
import { installLogBrewReactNativeGlobalErrorHandler } from "@logbrew/react-native/global-errors";
import { createLogBrewReactNativeInstrumentation } from "@logbrew/react-native/instrumentation";

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
