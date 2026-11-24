import http from "node:http";
import { Window } from "happy-dom";

const api = http.createServer((request, response) => {
  response.writeHead(request.method === "OPTIONS" ? 204 : 200, {
    "access-control-allow-headers": "traceparent",
    "access-control-allow-origin": "*",
    "content-type": "application/json"
  });
  response.end("{}");
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${api.address().port}`;
const browserWindow = new Window({ url: `${origin}/checkout` });
for (const name of ["window", "document", "navigator", "Element", "SVGElement", "HTMLElement", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browserWindow : browserWindow[name] });
}

const { createApp, h, onMounted } = await import("vue");
const { installLogBrewConsoleCapture } = await import("@logbrew/sdk");
const { createLogBrewVuePlugin } = await import("@logbrew/vue");

const Checkout = {
  name: "Checkout",
  setup() {
    onMounted(async () => {
      console.info("checkout started");
      await (await window.fetch(`${origin}/api/cart`)).text();
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
  endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT,
  context: {
    schemaVersion: 1,
    resource: {
      service: { name: "checkout-web" },
      deployment: { environment: "production", release: "web@1.2.3" }
    },
    subject: { kind: "user", id: "user_123" }
  },
  tracePropagationTargets: [`${origin}/api/`]
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
await new Promise((resolve) => setTimeout(resolve, 200));
document.querySelector("#pay").click();
await new Promise((resolve) => setTimeout(resolve, 300));
consoleCapture.uninstall();
await logbrew.shutdown();
app.unmount();
api.close();
await browserWindow.happyDOM.close();
