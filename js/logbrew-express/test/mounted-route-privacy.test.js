import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { connect } from "node:net";
import test from "node:test";
import express from "express";
import * as adapter from "@logbrew/express";

const expressVersion = createRequire(import.meta.url)("express/package.json").version;
const major = Number(expressVersion.split(".")[0]);
const TIMESTAMP = "2026-08-29T12:00:00Z";
const PATTERN = major >= 5 ? "/orders{/:orderId}" : "/orders/:orderId?";

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) { return; }
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  assert.fail("mounted request telemetry did not settle");
}

async function checkMounted(t, { failure = false, aborted = false, overlap = false, overrides = false, commonjs = false, pattern = PATTERN } = {}) {
  const api = commonjs ? createRequire(import.meta.url)("@logbrew/express") : adapter;
  const count = overlap ? 2 : 1;
  const clients = [];
  const probes = [];
  const bodies = [];
  const errors = [];
  const captureFailures = [];
  const originalError = new TypeError("mounted handler failure");
  const transport = { async send(_key, body) { bodies.push(body); return { statusCode: 202 }; } };
  let releaseHandlers;
  const handlersReady = new Promise((resolve) => { releaseHandlers = resolve; });
  const expectedTemplate = overrides ? "/approved/:itemId" : pattern;
  const app = express();
  app.use(api.logbrewMiddleware({
    transport,
    captureRequestMetrics: true,
    now: () => TIMESTAMP,
    client() {
      const client = api.createLogBrewExpressClient({
        serverApiKey: "LOGBREW_SERVER_API_KEY",
        context: { schemaVersion: 1, resource: { service: { name: "mounted-service" } } }
      });
      clients.push(client);
      return client;
    },
    ...(overrides ? {
      requestEvent(req, res, context) {
        const event = api.createRequestEvent(req, res, context);
        event.attributes.name = `GET ${expectedTemplate}`;
        event.attributes.metadata.routeTemplate = expectedTemplate;
        return event;
      },
      requestMetricEvent(req, res, context) {
        const event = api.createRequestMetricEvent(req, res, context);
        event.attributes.metadata.routeTemplate = expectedTemplate;
        return event;
      }
    } : {}),
    onCaptureError(error) { captureFailures.push(error); }
  }));
  const tenantRouter = express.Router({ mergeParams: true });
  const regionRouter = express.Router({ mergeParams: true });
  regionRouter.get(pattern, api.withLogBrewExpressHandler(async (req, res) => {
    const probe = {
      baseUrl: req.baseUrl,
      originalUrl: req.originalUrl,
      mountParameters: req.inspectedMount,
      routePath: req.route.path,
      params: { ...req.params },
      trace: api.getActiveLogBrewTrace(),
      client: req.logbrew.client
    };
    probes.push(probe);
    assert.equal(req.logbrew.client, req.logbrew.logbrew);
    assert.equal(req.logbrew.transport, transport);
    if (probes.length === count) { releaseHandlers(); }
    await handlersReady;
    assert.deepEqual(api.getActiveLogBrewTrace(), probe.trace);
    if (aborted) { res.write("first chunk"); res.flushHeaders(); }
    if (failure) { throw originalError; }
    if (!aborted) { res.end("ok"); }
  }));
  tenantRouter.use("/regions/:regionId", (req, _res, next) => {
    req.inspectedMount.regionId = req.params.regionId;
    next();
  });
  tenantRouter.use("/regions/:regionId", regionRouter);
  app.use("/tenants/:tenantId", (req, _res, next) => {
    req.inspectedMount = { tenantId: req.params.tenantId };
    next();
  });
  app.use("/tenants/:tenantId", tenantRouter);
  app.use(api.logbrewErrorHandler({
    ...(overrides ? {
      errorEvent(error, context) {
        const event = api.createErrorEvent(error, context.req, { trace: context.trace });
        event.attributes.title = `GET ${expectedTemplate} failed`;
        event.attributes.metadata.routeTemplate = expectedTemplate;
        return event;
      }
    } : {}),
    onCaptureError(error) { captureFailures.push(error); }
  }));
  app.use((error, _req, res, _next) => {
    errors.push(error);
    if (res.headersSent) { res.destroy(); } else { res.statusCode = 500; res.end("failed"); }
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { releaseHandlers(); server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  await Promise.all(Array.from({ length: count }, (_value, index) => new Promise((resolve, reject) => {
    const route = pattern.startsWith("/members/") ? "members" : "orders";
    const path = `/tenants/private-tenant-${index}%2Fpart/regions/private-region-${index}%40part/${route}/private-item-${index}%23part%3Fpart?search=private-query-${index}#private-fragment-${index}`;
    let response = "";
    const outgoing = connect(server.address().port, "127.0.0.1", () => {
      const target = `http://private-user:private-pass@localhost:${server.address().port}${path}`;
      outgoing.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAuthorization: private-authorization\r\nCookie: private-cookie\r\ntraceparent: 00-${String(index + 1).repeat(32)}-4444444444444444-00\r\n\r\n`);
    });
    outgoing.on("data", (chunk) => {
      response += chunk.toString();
      if (aborted || (response.includes("\r\n\r\n") && response.includes(failure ? "failed" : "ok"))) {
        outgoing.destroy();
      }
    });
    outgoing.on("end", () => { outgoing.destroy(); });
    outgoing.on("close", () => {
      if (aborted || response.startsWith(`HTTP/1.1 ${failure ? 500 : 200} `)) { resolve(); }
      else { reject(new Error("mounted route returned an unexpected status")); }
    });
    outgoing.on("error", (error) => { if (aborted) { resolve(); } else { reject(error); } });
  })));
  await waitFor(() => clients.length === count && clients.every((client) => client.deliveryHealth().lifecycle === "closed"));
  assert.equal(captureFailures.length, 0);
  assert.equal(probes.length, count);
  assert.equal(errors.length, failure ? count : 0);
  assert.ok(errors.every((error) => error === originalError));
  for (const probe of probes) {
    assert.equal(probe.routePath, pattern);
    if (expressVersion === "4.0.0") {
      assert.equal(probe.baseUrl, undefined);
    } else {
      assert.ok(probe.baseUrl.includes("private-tenant-") && probe.baseUrl.includes("private-region-"));
      assert.ok(probe.params.tenantId.includes("/part"));
      assert.ok(probe.params.regionId.includes("@part"));
    }
    assert.ok(probe.originalUrl.includes("private-user:private-pass") && probe.originalUrl.includes("private-query") && probe.originalUrl.includes("private-fragment"));
    assert.ok(probe.mountParameters.tenantId.includes("/part"));
    assert.ok(probe.mountParameters.regionId.includes("@part"));
    assert.ok(Object.values(probe.params).some((value) => value.includes("#part?part")));
    assert.ok(clients.includes(probe.client));
  }
  const events = bodies.flatMap((body) => JSON.parse(body).events);
  assert.equal(events.length, (failure ? 3 : 2) * count);
  assert.deepEqual(events.filter(({ type }) => type === "span").map(({ attributes }) => attributes.traceId).sort(),
    Array.from({ length: count }, (_value, index) => String(index + 1).repeat(32)));
  for (const event of events) {
    assert.equal(event.attributes.metadata.routeTemplate, expectedTemplate);
    assert.equal(event.attributes.context.resource.service.name, "mounted-service");
    const trace = event.attributes.context.trace;
    assert.equal(trace.sampled, false);
    assert.ok(probes.some((probe) => probe.trace.traceId === trace.traceId && probe.trace.spanId === trace.spanId));
    if (event.type === "span") {
      assert.equal(event.attributes.name, `GET ${expectedTemplate}`);
      assert.equal(event.attributes.parentSpanId, "4444444444444444");
      assert.equal(event.attributes.status, failure || aborted ? "error" : "ok");
      assert.equal(event.attributes.metadata.responseCompleted, aborted ? false : undefined);
    }
    if (event.type === "issue") {
      assert.equal(event.attributes.title, `GET ${expectedTemplate} failed`);
      const breadcrumb = event.attributes.breadcrumbs.find(({ category }) => category === "express.request");
      assert.equal(breadcrumb.data.routeTemplate, pattern);
      assert.equal(breadcrumb.message, `GET ${pattern}`);
    }
  }
  for (const body of bodies) {
    for (const marker of ["private-tenant", "private-region", "private-item", "private-query", "private-fragment", "private-user", "private-pass", "private-authorization", "private-cookie", "localhost:"]) {
      assert.equal(body.includes(marker), false, `default telemetry included ${marker}`);
    }
  }
  assert.equal(api.getActiveLogBrewTrace(), undefined);
}

test("mounted request telemetry preserves the declared route pattern", async (t) => { await checkMounted(t); });
test("declared leaf routes exclude mounted URLs and request fields", async (t) => { await checkMounted(t, { pattern: "/orders/:orderId", overlap: true, failure: true }); });
test("overlapping mounted requests preserve independent clients and traces", async (t) => { await checkMounted(t, { overlap: true }); });
test("mounted failures retain route patterns without concrete mount parameters", async (t) => { await checkMounted(t, { failure: true }); });
test("mounted client aborts retain route patterns without concrete mount parameters", async (t) => { await checkMounted(t, { aborted: true }); });
test("mounted failures after headers flush retain private route correlation", async (t) => { await checkMounted(t, { failure: true, aborted: true }); });
test("CommonJS preserves mounted route patterns and privacy", async (t) => { await checkMounted(t, { commonjs: true }); });
test("app-owned event templates keep their explicit selection", async (t) => { await checkMounted(t, { failure: true, overrides: true }); });
test("quoted or constrained parameter names retain the registered pattern", async (t) => {
  await checkMounted(t, { pattern: major >= 5 ? '/members/:"item id"' : "/members/:itemId([^/]+)" });
});

test("unmatched helper events do not fall back to concrete request URLs", () => {
  const req = {
    method: "GET",
    baseUrl: "/tenants/private-tenant",
    originalUrl: "http://private-user:private-pass@example.test/private-item?search=private-query#private-fragment",
    url: "/private-item?search=private-query#private-fragment",
    params: { id: "private-item" },
    headers: { authorization: "private-authorization", cookie: "private-cookie" }
  };
  const span = adapter.createRequestEvent(req, { statusCode: 404 });
  const metric = adapter.createRequestMetricEvent(req, { statusCode: 404 });
  const issue = adapter.createErrorEvent(new TypeError("unmatched request"), req);
  assert.equal(span.attributes.name, "GET <unmatched>");
  assert.equal(metric.attributes.metadata.routeTemplate, "<unmatched>");
  assert.equal(issue.attributes.title, "GET <unmatched> failed");
  assert.equal(JSON.stringify([span, metric, issue]).includes("private-"), false);
  for (const path of [["/orders/:id", "/items/:id"], /^\/orders\/(.+)$/]) {
    assert.equal(adapter.createRequestEvent({ ...req, route: { path } }, { statusCode: 200 }).attributes.name, "GET <unmatched>");
  }
});
