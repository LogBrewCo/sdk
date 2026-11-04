import { Window } from "happy-dom";

const browserWindow = new Window({ url: "https://shop.example.test/checkout/cart-1" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browserWindow : browserWindow[name] });
}

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, Route, Routes, matchRoutes, useLocation, useNavigate, useNavigationType } = await import("react-router");
const { installLogBrewConsoleCapture } = await import("@logbrew/sdk");
const { createFetchTransport } = await import("@logbrew/browser");
const {
  LogBrewErrorBoundary,
  LogBrewProvider,
  createLogBrewReactClient,
  createLogBrewReactRootOptions,
  createLogBrewReactRouterNavigationObserver
} = await import("@logbrew/react");

const h = React.createElement;
const client = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  context: {
    schemaVersion: 1,
    resource: {
      service: { name: "checkout-web" },
      deployment: { environment: "production", release: "web@1.2.3" }
    },
    subject: { kind: "user", id: "user_123" }
  }
});
const transport = createFetchTransport({ endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT });
const consoleCapture = installLogBrewConsoleCapture({ client, console, transport, levels: ["info", "warn"], logger: "console" });

let goTo;
function Checkout() {
  goTo = useNavigate();
  React.useEffect(() => console.info("checkout started"), []);
  return h("p", null, "Checkout");
}
function Payment() {
  console.warn("payment step failing");
  throw new Error("payment declined");
}
const routes = [
  { path: "/checkout/:cartId", element: h(Checkout) },
  { path: "/payment/:cartId", element: h(LogBrewErrorBoundary, { fallback: h("p", null, "Payment failed") }, h(Payment)) }
];
const RouteObserver = createLogBrewReactRouterNavigationObserver({
  matchRoutes,
  routes,
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  useLocation,
  useNavigationType
});
const app = h(LogBrewProvider, { client },
  h(MemoryRouter, { initialEntries: ["/checkout/cart-1"] },
    h(RouteObserver),
    h(Routes, null, routes.map((route) => h(Route, { key: route.path, ...route })))));

const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container, createLogBrewReactRootOptions(client));
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
root.render(app);
await settle();
goTo("/payment/cart-2");
await settle();
root.unmount();
consoleCapture.uninstall();
await client.shutdown(transport);
await browserWindow.happyDOM.close();
