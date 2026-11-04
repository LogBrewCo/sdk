import http from "node:http";
import { Window } from "happy-dom";

const api = http.createServer((_request, response) => response.end("{}"));
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${api.address().port}`;
const browserWindow = new Window({ url: "https://shop.example.test/checkout" });
for (const name of ["window", "document", "navigator", "Element", "SVGElement", "HTMLElement", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browserWindow : browserWindow[name] });
}

const { createApp, h, onMounted } = await import("vue");
const { installLogBrewConsoleCapture } = await import("@logbrew/sdk");
const { createFetchTransport } = await import("@logbrew/browser");
const { createLogBrewVuePlugin, createTraceparentFetch, createVueTraceparent } = await import("@logbrew/vue");

const tracedFetch = createTraceparentFetch({
  traceparentFactory: () => createVueTraceparent(),
  tracePropagationTargets: [`${origin}/api/`]
});
const Checkout = {
  name: "Checkout",
  setup() {
    onMounted(async () => {
      console.info("checkout started");
      await (await tracedFetch(`${origin}/api/cart`)).text();
    });
    const pay = () => {
      console.warn("payment step failing");
      throw new Error("payment declined");
    };
    return () => h("button", { id: "pay", onClick: pay }, "Pay");
  }
};

const app = createApp(Checkout);
app.use(createLogBrewVuePlugin({
  clientKey: "LOGBREW_CLIENT_KEY",
  context: {
    schemaVersion: 1,
    resource: {
      service: { name: "checkout-web" },
      deployment: { environment: "production", release: "web@1.2.3" }
    },
    subject: { kind: "user", id: "user_123" }
  },
  transport: createFetchTransport({ endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT })
}));
const logbrew = app.config.globalProperties.$logbrew;
const consoleCapture = installLogBrewConsoleCapture({
  client: logbrew.client,
  console,
  transport: logbrew.transport,
  levels: ["info", "warn"],
  logger: "console"
});
const container = document.createElement("div");
document.body.append(container);
app.mount(container);
await new Promise((resolve) => setTimeout(resolve, 100));
document.querySelector("#pay").click();
await new Promise((resolve) => setTimeout(resolve, 300));
app.unmount();
consoleCapture.uninstall();
await logbrew.shutdown();
api.close();
await browserWindow.happyDOM.close();
