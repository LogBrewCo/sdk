import assert from "node:assert/strict";
import test from "node:test";
import { createHttpErrorEvent, createHttpRequestEvent } from "@logbrew/node";

const OK = 200;

test("request spans inside a mounted router keep the mount path and the route template", () => {
  const event = createHttpRequestEvent(
    { baseUrl: "/orders", method: "GET", originalUrl: "/orders/8412?expand=1", route: { path: "/:orderId" }, url: "/8412?expand=1" },
    { statusCode: OK }
  );

  assert.equal(event.attributes.name, "GET /orders/:orderId");
  assert.equal(event.attributes.metadata["http.route"], "/orders/:orderId");
  assert.equal(event.attributes.metadata["url.path"], "/orders/:id");
});

test("request spans keep the mount path after the router restored baseUrl", () => {
  const event = createHttpRequestEvent(
    { baseUrl: "", method: "GET", originalUrl: "/tenants/77/orders/8412", route: { path: "/orders/:orderId" }, url: "/tenants/77/orders/8412" },
    { statusCode: OK }
  );

  assert.equal(event.attributes.name, "GET /tenants/:id/orders/:orderId");
});

test("request spans fall back to the normalized path when the route does not fit the URL", () => {
  const event = createHttpRequestEvent(
    { method: "GET", originalUrl: "/orders/8412", route: { path: "/invoices/:invoiceId" }, url: "/8412" },
    { statusCode: OK }
  );

  assert.equal(event.attributes.name, "GET /orders/:id");
});

test("error issues inside a mounted router name the full route template", () => {
  const event = createHttpErrorEvent(
    new Error("lookup failed"),
    { baseUrl: "/orders", method: "GET", originalUrl: "/orders/8412", route: { path: "/:orderId" }, url: "/8412" }
  );

  assert.equal(event.attributes.title, "GET /orders/:orderId failed");
});
