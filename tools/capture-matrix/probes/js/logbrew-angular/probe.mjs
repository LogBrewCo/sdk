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
const browserWindow = new Window({ url: "https://shop.example.test/checkout" });
browserWindow.document.body.innerHTML = "<app-root></app-root>";
const globals = ["window", "document", "navigator", "Element", "HTMLElement", "Node", "Text", "Comment", "Event", "MouseEvent", "KeyboardEvent", "XMLHttpRequest"];
for (const name of globals) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browserWindow : browserWindow[name] });
}

await import("@angular/compiler");
const { Component, inject, provideZonelessChangeDetection } = await import("@angular/core");
const { HttpClient, provideHttpClient } = await import("@angular/common/http");
const { bootstrapApplication } = await import("@angular/platform-browser");
const { firstValueFrom } = await import("rxjs");
const { installLogBrewConsoleCapture } = await import("@logbrew/sdk");
const { injectLogBrew, provideLogBrew } = await import("@logbrew/angular");

let logbrew;
let consoleCapture;
class CheckoutComponent {
  constructor() {
    this.http = inject(HttpClient);
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
    await firstValueFrom(this.http.get(`${origin}/api/cart`));
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
    provideHttpClient(),
    provideLogBrew({
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
    })
  ]
});
await new Promise((resolve) => setTimeout(resolve, 200));
document.querySelector("#pay").click();
await new Promise((resolve) => setTimeout(resolve, 300));
document.querySelector("#pay").click();
await new Promise((resolve) => setTimeout(resolve, 300));
consoleCapture.uninstall();
await logbrew.shutdown();
app.destroy();
api.close();
await browserWindow.happyDOM.close();
