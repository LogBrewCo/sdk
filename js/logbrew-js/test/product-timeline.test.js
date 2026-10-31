import {
  PRODUCT_ANALYTICS_KINDS,
  PRODUCT_ANALYTICS_SCHEMA_VERSION,
  createNetworkMilestoneAttributes,
  createProductActionAttributes
} from "@logbrew/sdk";
import assert from "node:assert/strict";
import { callUnchecked } from "./batch-helpers.js";
import test from "node:test";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SERVICE_UNAVAILABLE = 503;
const NETWORK_DURATION_MS = 82.5;
const SCHEMA_VERSION = 1;
const CALLER_SCHEMA_VERSION = 99;
const NEGATIVE_DURATION_MS = -1;
const BELOW_STATUS_RANGE = 99;
const REGION_OPTIONS = { metadata: { region: "global" } };

const EXPECTED_ACTION = {
  metadata: {
    analyticsKind: "interaction",
    analyticsSchemaVersion: SCHEMA_VERSION,
    analyticsSurface: "/checkout/:step",
    funnel: "checkout",
    region: "global",
    routeTemplate: "/checkout/:step",
    screen: "Checkout",
    service: "checkout",
    sessionId: "sess_123",
    source: "product.action",
    step: "submit",
    traceId: TRACE_ID
  },
  name: "checkout.submit",
  status: "running"
};

const EXPECTED_NETWORK = {
  metadata: {
    durationMs: NETWORK_DURATION_MS,
    method: "POST",
    region: "global",
    routeTemplate: "/v1/orders/:id",
    service: "checkout",
    sessionId: "sess_123",
    source: "network.milestone",
    statusCode: SERVICE_UNAVAILABLE,
    traceId: TRACE_ID
  },
  name: "network.post /v1/orders/:id",
  status: "failure"
};

/**
 * @returns {unknown}
 */
function unsafeProductAction() {
  return callUnchecked(createProductActionAttributes, [{
    funnel: "checkout",
    metadata: { ignoredObject: { nested: true }, service: "checkout" },
    name: "checkout.submit",
    routeTemplate: "https://app.example/checkout/:step?email=user@example.com#pay",
    screen: "Checkout",
    sessionId: "sess_123",
    status: "running",
    step: "submit",
    traceId: TRACE_ID
  }, REGION_OPTIONS]);
}

/**
 * @returns {unknown}
 */
function unsafeNetworkMilestone() {
  return callUnchecked(createNetworkMilestoneAttributes, [{
    durationMs: NETWORK_DURATION_MS,
    metadata: { ignoredArray: ["ignored"], service: "checkout" },
    method: "post",
    routeTemplate: "https://api.example/v1/orders/:id?debug=true#trace",
    sessionId: "sess_123",
    statusCode: SERVICE_UNAVAILABLE,
    traceId: TRACE_ID
  }, REGION_OPTIONS]);
}

await test("timeline helpers create safe action attributes", () => {
  const action = unsafeProductAction();
  const network = unsafeNetworkMilestone();

  assert.deepEqual(action, EXPECTED_ACTION);
  assert.deepEqual(network, EXPECTED_NETWORK);
});

await test("product analytics annotations cannot be replaced by caller metadata", () => {
  const action = createProductActionAttributes({
    metadata: {
      analyticsKind: "page_view",
      analyticsSchemaVersion: CALLER_SCHEMA_VERSION,
      analyticsSurface: "private-selector"
    },
    name: "checkout.submit",
    screen: "Checkout"
  });

  const metadata = action.metadata ?? {};
  assert.equal(metadata["analyticsSchemaVersion"], SCHEMA_VERSION);
  assert.equal(metadata["analyticsKind"], "interaction");
  assert.equal(metadata["analyticsSurface"], "Checkout");

  const unsurfaced = createProductActionAttributes({
    metadata: { analyticsSurface: "private-selector" },
    name: "checkout.confirmed"
  });
  assert.equal(unsurfaced.metadata?.["analyticsSurface"], undefined);
  assert.equal(PRODUCT_ANALYTICS_SCHEMA_VERSION, SCHEMA_VERSION);
  assert.deepEqual(PRODUCT_ANALYTICS_KINDS, ["page_view", "screen_view", "interaction"]);
});

await test("timeline helpers reject unsafe milestone values", () => {
  /** @type {readonly (readonly [() => unknown, RegExp])[]} */
  const cases = [
    [() => callUnchecked(createProductActionAttributes, [{ name: "checkout.submit", status: "done" }]), /product action status must be one of: queued, running, success, failure/u],
    [() => createNetworkMilestoneAttributes({ method: "GET /bad", routeTemplate: "/orders/:id" }), /network milestone method must be a valid HTTP method/u],
    [() => createNetworkMilestoneAttributes({ durationMs: NEGATIVE_DURATION_MS, routeTemplate: "/orders/:id" }), /network milestone durationMs must be a non-negative number/u],
    [() => createNetworkMilestoneAttributes({ routeTemplate: "/orders/:id", statusCode: BELOW_STATUS_RANGE }), /network milestone statusCode must be an integer from 100 to 599/u]
  ];
  for (const [run, pattern] of cases) {
    assert.throws(run, pattern);
  }
});
