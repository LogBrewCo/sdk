import http from "node:http";
import { Window } from "happy-dom";

const api = http.createServer((_request, response) => response.end("{}"));
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${api.address().port}`;
const browserWindow = new Window({ url: "https://shop.example.test/checkout" });
browserWindow.document.body.innerHTML = "<app-root></app-root>";
for (const name of ["window", "document", "navigator", "Element", "HTMLElement", "Node", "Text", "Comment", "Event", "MouseEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browserWindow : browserWindow[name] });
}

await import("@angular/compiler");
const { Component, provideZonelessChangeDetection } = await import("@angular/core");
const { bootstrapApplication } = await import("@angular/platform-browser");
const { installLogBrewConsoleCapture } = await import("@logbrew/sdk");
const { createFetchTransport } = await import("@logbrew/browser");
const { createAngularTraceparent, createTraceparentFetch, injectLogBrew, provideLogBrew } = await import("@logbrew/angular");

const tracedFetch = createTraceparentFetch({
  traceparentFactory: () => createAngularTraceparent(),
  tracePropagationTargets: [`${origin}/api/`]
});
let logbrew;
let consoleCapture;
class CheckoutComponent {
  constructor() {
    logbrew = injectLogBrew();
    consoleCapture = installLogBrewConsoleCapture({
      client: logbrew.client,
      console,
      transport: logbrew.transport,
      levels: ["info", "warn"],
      logger: "console"
    });
  }

  async ngOnInit() {
    console.info("checkout started");
    await (await tracedFetch(`${origin}/api/cart`)).text();
  }

  pay() {
    console.warn("payment step failing");
    throw new Error("payment declined");
  }
}
Component({ selector: "app-root", template: '<button id="pay" (click)="pay()">Pay</button>' })(CheckoutComponent);

const app = await bootstrapApplication(CheckoutComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideLogBrew({
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
    })
  ]
});
await new Promise((resolve) => setTimeout(resolve, 100));
document.querySelector("#pay").click();
await new Promise((resolve) => setTimeout(resolve, 300));
consoleCapture.uninstall();
if (logbrew.client.deliveryHealth().lifecycle === "active") {
  await logbrew.shutdown();
}
app.destroy();
api.close();
await browserWindow.happyDOM.close();
