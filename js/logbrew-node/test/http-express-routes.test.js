import assert from "node:assert/strict";
import test from "node:test";
import { createHttpErrorEvent, createHttpRequestEvent } from "@logbrew/node";

const OK = 200;

test("request spans name an unmounted Express route by its template", () => {
  const event = createHttpRequestEvent(
    { method: "GET", originalUrl: "/orders/8412?expand=1", route: { path: "/orders/:orderId" }, url: "/orders/8412?expand=1" },
    { statusCode: OK }
  );

  assert.equal(event.attributes.name, "GET /orders/:orderId");
  assert.equal(event.attributes.metadata["http.route"], "/orders/:orderId");
  assert.equal(event.attributes.metadata["url.path"], "/orders/:id");
});

test("request spans inside a mounted router keep the full normalized path", () => {
  const event = createHttpRequestEvent(
    { baseUrl: "/orders", method: "GET", originalUrl: "/orders/8412?expand=1", route: { path: "/:orderId" }, url: "/8412?expand=1" },
    { statusCode: OK }
  );

  assert.equal(event.attributes.name, "GET /orders/:id");
  assert.equal(event.attributes.metadata["http.route"], undefined);
  assert.equal(event.attributes.metadata["url.path"], "/orders/:id");
});

test("request spans never copy a mount value from the URL into the route template", () => {
  const event = createHttpRequestEvent(
    { baseUrl: "", method: "GET", originalUrl: "/acme-store/orders/8412", route: { path: "/orders/:orderId" }, url: "/acme-store/orders/8412" },
    { statusCode: OK }
  );

  assert.equal(event.attributes.name, "GET /acme-store/orders/:id");
  assert.equal(event.attributes.metadata["http.route"], undefined);
});

test("request spans fall back to the normalized path when the route does not fit the URL", () => {
  const event = createHttpRequestEvent(
    { method: "GET", originalUrl: "/orders/8412", route: { path: "/invoices/:invoiceId" }, url: "/8412" },
    { statusCode: OK }
  );

  assert.equal(event.attributes.name, "GET /orders/:id");
});

test("error issues inside a mounted router name the full normalized path", () => {
  const event = createHttpErrorEvent(
    new Error("lookup failed"),
    { baseUrl: "/orders", method: "GET", originalUrl: "/orders/8412", route: { path: "/:orderId" }, url: "/8412" }
  );

  assert.equal(event.attributes.title, "GET /orders/:id failed");
});
