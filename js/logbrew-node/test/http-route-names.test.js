import assert from "node:assert/strict";
import test from "node:test";
import { createHttpRequestEvent } from "@logbrew/node";

const OK = 200;
const UUID = "0b0d8c3e-1f5a-4c7e-9a3b-2d4e6f8a0b1c";

test("request spans name the route with record IDs replaced by :id", () => {
  const event = createHttpRequestEvent(
    { method: "GET", url: `/orders/8412/items/${UUID}/files/a1b2c3d4e5f60718?view=full` },
    { statusCode: OK }
  );

  assert.equal(event.attributes.name, "GET /orders/:id/items/:id/files/:id");
  assert.equal(event.attributes.metadata["http.route"], undefined);
  assert.equal(event.attributes.metadata["url.path"], "/orders/:id/items/:id/files/:id");
  assert.equal(JSON.stringify(event).includes("8412"), false);
});

test("request spans keep words, short hex, and versions in the route", () => {
  const event = createHttpRequestEvent({ method: "GET", url: "/v2/accounts/me/cafe" }, { statusCode: OK });

  assert.equal(event.attributes.name, "GET /v2/accounts/me/cafe");
});

test("apps name requests themselves with routeTemplateFactory", () => {
  const event = createHttpRequestEvent({ method: "POST", url: "/checkout/8412" }, { statusCode: OK }, {
    routeTemplateFactory: (req) => `/checkout/:cartId${req.method === "POST" ? "" : "/view"}`
  });

  assert.equal(event.attributes.name, "POST /checkout/:cartId");
  assert.equal(event.attributes.metadata["http.route"], "/checkout/:cartId");
});
