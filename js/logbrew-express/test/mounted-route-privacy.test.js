import {
  ANY_PORT,
  HOST,
  assertExcludes,
  assertSameMembers,
  eventType,
  eventsOfBodies,
  eventsOfType,
  expectedTraceIds,
  isList,
  readField,
  readPath,
  serve,
  traceField,
  waitFor
} from "./support.js";
import { EXPRESS_VERSION, MODERN_EXPRESS, createMountedApp, createMountedView, sendMountedRequest } from "./mounted-app.js";
import { createErrorEvent, createRequestEvent, createRequestMetricEvent } from "@logbrew/express";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { TestContext } from "node:test"
 * @import { MountedView, Probe, Scenario } from "./mounted-app.js"
 */

const PARENT_SPAN_ID = "4444444444444444";
const ROUTE_TEMPLATE_PATH = Object.freeze(["attributes", "metadata", "routeTemplate"]);
const PRIVATE_MARKERS = Object.freeze([
  "private-tenant",
  "private-region",
  "private-item",
  "private-query",
  "private-fragment",
  "private-user",
  "private-pass",
  "private-authorization",
  "private-cookie",
  "localhost:"
]);
const NOT_FOUND = 404;
const OK = 200;
const NONE = 0;
const COMPLETED_EVENTS = 2;
const FAILED_EVENTS = 3;

/**
 * @param {unknown} value
 * @param {string} part
 * @returns {boolean}
 */
function includesText(value, part) {
  return typeof value === "string" && value.includes(part);
}

/**
 * @param {Probe} probe
 * @returns {void}
 */
function assertMountParameters(probe) {
  if (EXPRESS_VERSION === "4.0.0") {
    assert.equal(probe.baseUrl, undefined);
    return;
  }
  assert.ok(includesText(probe.baseUrl, "private-tenant-") && includesText(probe.baseUrl, "private-region-"));
  assert.ok(includesText(readField(probe.params, "tenantId"), "/part"));
  assert.ok(includesText(readField(probe.params, "regionId"), "@part"));
}

/**
 * @param {Probe} probe
 * @param {MountedView} view
 * @returns {void}
 */
function assertProbe(probe, view) {
  const { originalUrl } = probe;
  assert.equal(probe.routePath, view.pattern);
  assertMountParameters(probe);
  assert.ok(originalUrl.includes("private-user:private-pass") && originalUrl.includes("private-query") && originalUrl.includes("private-fragment"));
  assert.ok(includesText(readField(probe.mountParameters, "tenantId"), "/part"));
  assert.ok(includesText(readField(probe.mountParameters, "regionId"), "@part"));
  assert.ok(Object.values(probe.params).some((value) => includesText(value, "#part?part")));
  assert.ok(view.records.clients.includes(probe.client));
}

/**
 * @param {unknown} span
 * @param {MountedView} view
 * @returns {void}
 */
function assertMountedSpan(span, view) {
  const { aborted, failure } = view.scenario;
  assert.equal(readPath(span, ["attributes", "name"]), `GET ${view.template}`);
  assert.equal(readPath(span, ["attributes", "parentSpanId"]), PARENT_SPAN_ID);
  assert.equal(readPath(span, ["attributes", "status"]), failure === true || aborted === true ? "error" : "ok");
  assert.equal(readPath(span, ["attributes", "metadata", "responseCompleted"]), aborted === true ? false : undefined);
}

/**
 * @param {unknown} issue
 * @param {MountedView} view
 * @returns {void}
 */
function assertMountedIssue(issue, view) {
  const breadcrumbs = readPath(issue, ["attributes", "breadcrumbs"]);
  const breadcrumb = isList(breadcrumbs) ? breadcrumbs.find((candidate) => readField(candidate, "category") === "express.request") : undefined;
  assert.equal(readPath(issue, ["attributes", "title"]), `GET ${view.template} failed`);
  assert.equal(readPath(breadcrumb, ["data", "routeTemplate"]), view.pattern);
  assert.equal(readField(breadcrumb, "message"), `GET ${view.pattern}`);
}

/**
 * @param {unknown} event
 * @param {MountedView} view
 * @returns {void}
 */
function assertMountedEvent(event, view) {
  const traceId = traceField(event, "traceId");
  const spanId = traceField(event, "spanId");
  assert.equal(readPath(event, ROUTE_TEMPLATE_PATH), view.template);
  assert.equal(readPath(event, ["attributes", "context", "resource", "service", "name"]), "mounted-service");
  assert.equal(traceField(event, "sampled"), false);
  assert.ok(view.records.probes.some((probe) => probe.trace?.traceId === traceId && probe.trace?.spanId === spanId));
  if (eventType(event) === "span") {
    assertMountedSpan(event, view);
  }
  if (eventType(event) === "issue") {
    assertMountedIssue(event, view);
  }
}

/**
 * @param {MountedView} view
 * @returns {void}
 */
function assertMountedEvents(view) {
  const events = eventsOfBodies(view.recorder.bodies);
  const spans = eventsOfType(events, "span");
  assert.equal(events.length, (view.scenario.failure === true ? FAILED_EVENTS : COMPLETED_EVENTS) * view.count);
  assertSameMembers(spans.map((span) => readPath(span, ["attributes", "traceId"])), expectedTraceIds(view.count));
  for (const event of events) {
    assertMountedEvent(event, view);
  }
  for (const body of view.recorder.bodies) {
    assertExcludes(body, PRIVATE_MARKERS);
  }
}

/**
 * @param {MountedView} view
 * @returns {void}
 */
function assertMountedRun(view) {
  const { count, records } = view;
  assert.equal(records.captureFailures.length, NONE);
  assert.equal(records.probes.length, count);
  assert.equal(records.errors.length, view.scenario.failure === true ? count : NONE);
  assert.ok(records.errors.every((error) => error === view.original));
  for (const probe of records.probes) {
    assertProbe(probe, view);
  }
  assertMountedEvents(view);
  assert.equal(view.api.getActiveLogBrewTrace(), undefined);
}

/**
 * @param {TestContext} testContext
 * @param {Scenario} [scenario]
 * @returns {Promise<void>}
 */
async function checkMounted(testContext, scenario = {}) {
  const view = createMountedView(scenario);
  const app = createMountedApp(view);
  testContext.after(view.handlersReady.open);
  const server = await serve(testContext, () => app.listen(ANY_PORT, HOST));
  await Promise.all(Array.from({ length: view.count }, async (_value, index) => sendMountedRequest(server.port, index, view)));
  await waitFor(
    () => view.records.clients.length === view.count && view.records.clients.every((client) => client.deliveryHealth().lifecycle === "closed"),
    "mounted request telemetry did not settle"
  );
  assertMountedRun(view);
}

/** @type {ReadonlyArray<readonly [string, Scenario]>} */
const SCENARIOS = [
  ["mounted request telemetry preserves the declared route pattern", {}],
  ["declared leaf routes exclude mounted URLs and request fields", { failure: true, overlap: true, pattern: "/orders/:orderId" }],
  ["overlapping mounted requests preserve independent clients and traces", { overlap: true }],
  ["mounted failures retain route patterns without concrete mount parameters", { failure: true }],
  ["mounted client aborts retain route patterns without concrete mount parameters", { aborted: true }],
  ["mounted failures after headers flush retain private route correlation", { aborted: true, failure: true }],
  ["CommonJS preserves mounted route patterns and privacy", { commonjs: true }],
  ["app-owned event templates keep their explicit selection", { failure: true, overrides: true }],
  ["quoted or constrained parameter names retain the registered pattern", { pattern: MODERN_EXPRESS ? '/members/:"item id"' : "/members/:itemId([^/]+)" }]
];

for (const [name, scenario] of SCENARIOS) {
  void test(name, async (testContext) => {
    await checkMounted(testContext, scenario);
  });
}

void test("unmatched helper events do not fall back to concrete request URLs", () => {
  const req = {
    baseUrl: "/tenants/private-tenant",
    headers: { authorization: "private-authorization", cookie: "private-cookie" },
    method: "GET",
    originalUrl: "http://private-user:private-pass@example.test/private-item?search=private-query#private-fragment",
    params: { id: "private-item" },
    url: "/private-item?search=private-query#private-fragment"
  };
  const span = createRequestEvent(req, { statusCode: NOT_FOUND });
  const metric = createRequestMetricEvent(req, { statusCode: NOT_FOUND });
  const issue = createErrorEvent(new TypeError("unmatched request"), req);
  assert.equal(span.attributes.name, "GET <unmatched>");
  assert.equal(readPath(metric, ROUTE_TEMPLATE_PATH), "<unmatched>");
  assert.equal(issue.attributes.title, "GET <unmatched> failed");
  assert.equal(JSON.stringify([span, metric, issue]).includes("private-"), false);
  for (const path of [["/orders/:id", "/items/:id"], /^\/orders\/(?<id>.+)$/u]) {
    assert.equal(createRequestEvent({ ...req, route: { path } }, { statusCode: OK }).attributes.name, "GET <unmatched>");
  }
});
