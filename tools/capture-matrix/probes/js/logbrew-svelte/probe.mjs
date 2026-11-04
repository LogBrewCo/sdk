import { readFile, writeFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { compile } from "svelte/compiler";

const browserWindow = new Window({ url: "https://shop.example.test/checkout/cart-1" });
for (const name of ["window", "document", "navigator", "Element", "HTMLElement", "Node", "Text", "Comment", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browserWindow : browserWindow[name] });
}
const compiled = compile(await readFile("App.svelte", "utf8"), { filename: "App.svelte", generate: "client" });
await writeFile("App.js", compiled.js.code);

const { flushSync, mount, unmount } = await import("svelte");
const { installLogBrewConsoleCapture } = await import("@logbrew/sdk");
const { installLogBrewBrowser } = await import("@logbrew/browser");
const { createLogBrewSvelteContext, createLogBrewSvelteKitHooks } = await import("@logbrew/svelte");
const { default: App } = await import("./App.js");

const endpoint = process.env.LOGBREW_CAPTURE_ENDPOINT;
const deployment = { environment: "production", release: "web@1.2.3" };
const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  endpoint,
  context: {
    schemaVersion: 1,
    resource: { service: { name: "storefront-browser" }, deployment },
    subject: { kind: "user", id: "user_123" }
  }
});
const consoleCapture = installLogBrewConsoleCapture({
  client: logbrew.client,
  console,
  transport: logbrew.transport,
  levels: ["info", "warn"],
  logger: "console"
});
const component = mount(App, { target: document.body, props: { logbrew } });
document.querySelector("#pay").click();
flushSync();
await new Promise((resolve) => setTimeout(resolve, 200));
unmount(component);
consoleCapture.uninstall();
await logbrew.shutdown();
logbrew.uninstall();

const server = createLogBrewSvelteContext({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  endpoint,
  context: {
    schemaVersion: 1,
    resource: { service: { name: "storefront-web" }, deployment },
    subject: { kind: "user", id: "user_123" }
  }
});
const hooks = createLogBrewSvelteKitHooks(server);
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const requestEvent = (path, routeId) => {
  const url = new URL(path, "https://shop.example.test");
  return { request: new Request(url, { headers: { traceparent } }), route: { id: routeId }, url, params: {}, locals: {} };
};
await hooks.handle({
  event: requestEvent("/checkout/cart-1", "/checkout/[cartId]"),
  resolve: async () => new Response("ok", { status: 200 })
});
await hooks.handle({
  event: requestEvent("/payment/cart-2", "/payment/[cartId]"),
  async resolve(event) {
    try {
      throw new Error("payment declined");
    } catch (error) {
      await hooks.handleError({ error, event, status: 500, message: "Internal Error" });
      return new Response("error", { status: 500 });
    }
  }
});
await server.shutdown();
await browserWindow.happyDOM.close();
