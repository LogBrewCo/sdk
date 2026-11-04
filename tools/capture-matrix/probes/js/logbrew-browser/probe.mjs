import http from "node:http";
import { Window } from "happy-dom";
import { installLogBrewConsoleCapture } from "@logbrew/sdk";
import {
  installLogBrewBrowser,
  installLogBrewBrowserFetchInstrumentation,
  installLogBrewBrowserNavigationInstrumentation
} from "@logbrew/browser";

const api = http.createServer((request, response) => {
  response.statusCode = request.url.startsWith("/api/fail") ? 500 : 200;
  response.setHeader("content-type", "application/json");
  response.end("{}");
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${api.address().port}`;

const browserWindow = new Window({ url: `${origin}/checkout` });
browserWindow.document.body.innerHTML = '<button id="pay">Pay</button>';
const logbrew = installLogBrewBrowser({
  clientKey: "LOGBREW_BROWSER_KEY",
  browserWindow,
  endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT,
  context: {
    schemaVersion: 1,
    resource: {
      service: { name: "checkout-web" },
      deployment: { environment: "production", release: "web@1.2.3" }
    },
    subject: { kind: "user", id: "user_123" }
  }
});
const navigation = installLogBrewBrowserNavigationInstrumentation(logbrew);
const fetchInstrumentation = installLogBrewBrowserFetchInstrumentation(logbrew, { tracePropagationTargets: [/^\/api\//u] });
const consoleCapture = installLogBrewConsoleCapture({
  client: logbrew.client,
  console: browserWindow.console,
  transport: logbrew.transport,
  levels: ["info", "warn", "error"],
  logger: "console"
});

browserWindow.history.pushState({}, "", "/checkout/payment");
browserWindow.console.info("checkout started");
await (await browserWindow.fetch("/api/cart")).text();
await (await browserWindow.fetch("/api/fail")).text();
browserWindow.console.warn("payment step failing");
browserWindow.document.querySelector("#pay").addEventListener("click", () => {
  throw new Error("payment declined");
});
browserWindow.document.querySelector("#pay").click();

await new Promise((resolve) => setTimeout(resolve, 300));
await consoleCapture.flush();
consoleCapture.uninstall();
fetchInstrumentation.uninstall();
navigation.uninstall();
await logbrew.shutdown();
logbrew.uninstall();
api.close();
await browserWindow.happyDOM.close();
