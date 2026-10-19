import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsDir = path.resolve(packageDir, "..");

function runInstalledConsumer(source, { extension = "mjs", linkDependencies = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-next-request-errors-"));
  try {
    const scopeDir = path.join(root, "node_modules", "@logbrew");
    fs.mkdirSync(scopeDir, { recursive: true });
    if (linkDependencies) {
      fs.symlinkSync(path.join(jsDir, "logbrew-js"), path.join(scopeDir, "sdk"), "dir");
      fs.symlinkSync(path.join(jsDir, "logbrew-node"), path.join(scopeDir, "node"), "dir");
    }
    fs.symlinkSync(packageDir, path.join(scopeDir, "next"), "dir");

    const consumerPath = path.join(root, `consumer.${extension}`);
    fs.writeFileSync(consumerPath, source, "utf8");
    return spawnSync(process.execPath, ["--preserve-symlinks", consumerPath], {
      cwd: root,
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Route Handler telemetry failures preserve application outcomes and restore trace context", () => {
  const result = runInstalledConsumer(`
    import assert from "node:assert/strict";
    import { RecordingTransport } from "@logbrew/sdk";
    import { getActiveLogBrewTrace, withLogBrewRouteHandler } from "@logbrew/next";

    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "b7ad6b7169203331";
    const request = new Request("https://example.com/api/orders/private-value?private-query=value", {
      headers: { traceparent: "00-" + traceId + "-1111111111111111-01" }
    });
    const applicationError = new Error("route failed");
    const captureError = new Error("capture failed");
    const callbackError = new Error("callback failed");
    const options = {
      serverApiKey: "local-preview-key",
      routeTemplate: "/api/orders/[id]",
      spanIdFactory: () => spanId,
      transport: RecordingTransport.alwaysAccept()
    };
    const applicationFailure = async () => {
      await Promise.resolve();
      assert.equal(getActiveLogBrewTrace().traceId, traceId);
      throw applicationError;
    };

    for (const failureOptions of [
      { errorEvent() { throw captureError; } },
      { onFlush() { throw captureError; } },
      { transport: { async send() { throw captureError; } }, maxRetries: 0 }
    ]) {
      let reported;
      const route = withLogBrewRouteHandler(applicationFailure, {
        ...options, ...failureOptions,
        async onCaptureError(error, context) {
          reported = error;
          assert.equal(context.trace.spanId, spanId);
          assert.equal(getActiveLogBrewTrace().spanId, spanId);
          await Promise.resolve();
          throw callbackError;
        }
      });
      await assert.rejects(route(request), (error) => error === applicationError);
      if (failureOptions.transport) {
        assert.ok(reported instanceof Error);
      } else {
        assert.equal(reported, captureError);
      }
      assert.equal(getActiveLogBrewTrace(), undefined);
    }

    const response = new Response("ok", { status: 202 });
    let reports = 0;
    const success = withLogBrewRouteHandler(async () => response, {
      ...options,
      requestEvent() { throw captureError; },
      async onCaptureError(error) {
        reports += 1;
        assert.equal(error, captureError);
        throw callbackError;
      }
    });
    assert.equal(await success(request), response);
    assert.equal(reports, 1);
    assert.equal(getActiveLogBrewTrace(), undefined);

    const transport = RecordingTransport.alwaysAccept();
    const normal = withLogBrewRouteHandler(async () => response, { ...options, transport });
    assert.equal(await normal(request), response);
    const payload = JSON.parse(transport.lastBody());
    assert.equal(payload.events[0].attributes.traceId, traceId);
    assert.equal(payload.events[0].attributes.spanId, spanId);
    assert.equal(payload.events[0].attributes.metadata.routeTemplate, "/api/orders/[id]");
    assert.equal(transport.lastBody().includes("private-value"), false);
    assert.equal(transport.lastBody().includes("private-query"), false);
    assert.equal(getActiveLogBrewTrace(), undefined);
  `);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Route Handler manual events are delivered when automatic error capture is disabled", () => {
  const result = runInstalledConsumer(`
    import assert from "node:assert/strict";
    import { RecordingTransport } from "@logbrew/sdk";
    import { getActiveLogBrewTrace, withLogBrewRouteHandler } from "@logbrew/next";

    const applicationError = new Error("route failed");
    const request = new Request("https://example.com/api/orders/private-value?private-query=value", {
      method: "POST", body: "private-payload",
      headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01" }
    });
    for (const failApplication of [false, true]) {
      for (const failDelivery of [false, true]) {
        const transport = RecordingTransport.alwaysAccept();
        let attempts = 0;
        let failures = 0;
        let flushes = 0;
        const route = withLogBrewRouteHandler(async (_request, _context, { client, trace }) => {
          client.log("evt_manual", "2026-08-01T10:00:00Z", {
            message: "work started", level: "info",
            metadata: { traceId: trace.traceId, spanId: trace.spanId }
          });
          if (failApplication) { throw applicationError; }
          return new Response("ok", { status: 202 });
        }, {
          serverApiKey: "local-preview-key", maxRetries: 0,
          captureErrors: false, captureRequests: false,
          routeTemplate: "/api/orders/[id]", spanIdFactory: () => "b7ad6b7169203331",
          transport: {
            async send(key, body) {
              attempts += 1;
              await transport.send(key, body);
              if (failDelivery) { throw new Error("delivery failed"); }
              return { statusCode: 202 };
            }
          },
          errorEvent() { throw new Error("automatic error capture must stay disabled"); },
          onFlush() { flushes += 1; },
          async onCaptureError(_error, context) {
            failures += 1;
            assert.equal(context.trace.spanId, "b7ad6b7169203331");
            throw new Error("callback failed");
          }
        });
        if (failApplication) {
          await assert.rejects(route(request), error => error === applicationError);
        } else {
          assert.equal((await route(request)).status, 202);
        }
        assert.equal(attempts, 1);
        assert.equal(flushes, failDelivery ? 0 : 1);
        assert.equal(failures, failDelivery ? 1 : 0);
        assert.equal(getActiveLogBrewTrace(), undefined);
        const body = transport.lastBody();
        const payload = JSON.parse(body);
        assert.deepEqual(payload.events.map(event => event.type), ["log"]);
        assert.equal(payload.events[0].attributes.metadata.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
        for (const value of ["private-value", "private-query", "private-payload"]) {
          assert.equal(body.includes(value), false);
        }
      }
    }
  `);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Route Handlers keep fixed clients caller-owned and finalize factory clients", () => {
  const result = runInstalledConsumer(`
    import assert from "node:assert/strict";
    import { RecordingTransport } from "@logbrew/sdk";
    import { createLogBrewNextClient, getActiveLogBrewTrace, withLogBrewRouteHandler } from "@logbrew/next";

    const applicationError = new Error("route failed");
    const request = new Request("https://example.com/api/orders/private-value?private-query=value", {
      headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01" }
    });
    const shared = createLogBrewNextClient({ serverApiKey: "local-preview-key", maxRetries: 0 });
    const transport = RecordingTransport.alwaysAccept();
    const factoryClients = [];
    for (const clientOption of [shared, () => {
      const client = createLogBrewNextClient({ serverApiKey: "local-preview-key" });
      factoryClients.push(client);
      return client;
    }]) {
      let failApplication = false;
      const route = withLogBrewRouteHandler(async (_request, _context, { client, trace }) => {
        client.log("evt_manual", "2026-08-01T10:00:00Z", {
          message: "work started", level: "info", metadata: { traceId: trace.traceId, spanId: trace.spanId }
        });
        if (failApplication) { throw applicationError; }
        return new Response("ok", { status: 202 });
      }, { client: clientOption, transport, routeTemplate: "/api/orders/[id]", spanIdFactory: () => "b7ad6b7169203331" });
      for (const fails of [false, true, false]) {
        failApplication = fails;
        if (fails) { await assert.rejects(route(request), error => error === applicationError); }
        else { assert.equal((await route(request)).status, 202); }
        assert.equal(getActiveLogBrewTrace(), undefined);
        assert.equal(shared.closed, false);
        const body = transport.lastBody();
        assert.equal(body.includes("private-value"), false);
        assert.equal(body.includes("private-query"), false);
        const events = JSON.parse(body).events;
        assert.deepEqual(events.map(event => event.type), ["log", fails ? "issue" : "span"]);
      }
    }
    assert.equal(factoryClients.length, 3);
    assert.ok(factoryClients.every(client => client.closed));
    assert.equal(transport.sentBodies.length, 6);
    shared.log("evt_after", "2026-08-01T10:00:00Z", { message: "caller still owns client", level: "info" });
    await shared.shutdown(transport);
    assert.equal(shared.closed, true);
  `);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Route Handler event factory failures still finalize buffered manual events", () => {
  const result = runInstalledConsumer(`
    import assert from "node:assert/strict";
    import { RecordingTransport } from "@logbrew/sdk";
    import { createLogBrewNextClient, getActiveLogBrewTrace, withLogBrewRouteHandler } from "@logbrew/next";

    const request = new Request("https://example.com/api/orders/private-value?private-query=value", {
      method: "POST", body: "private-payload",
      headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01" }
    });
    for (const factory of ["requestEvent", "errorEvent", "requestMetricEvent"]) {
      for (const callerOwned of [false, true]) {
        for (const failDelivery of [false, true]) {
          const original = new Error("route failed");
          const factoryError = new Error("event factory failed");
          const transport = RecordingTransport.alwaysAccept();
          const failures = [];
          let client = callerOwned ? createLogBrewNextClient({ serverApiKey: "local-preview-key", maxRetries: 0 }) : undefined;
          const route = withLogBrewRouteHandler(async (_request, _context, helpers) => {
            client = helpers.client;
            client.log("evt_manual", "2026-08-01T10:00:00Z", { message: "work started", level: "info" });
            if (factory === "errorEvent") { throw original; }
            return new Response("ok", { status: 202 });
          }, {
            serverApiKey: "local-preview-key", maxRetries: 0, client,
            routeTemplate: "/api/orders/[id]", spanIdFactory: () => "b7ad6b7169203331",
            captureRequests: factory === "requestEvent", captureRequestMetrics: factory === "requestMetricEvent",
            [factory]() { throw factoryError; },
            transport: { async send(key, body) {
              await transport.send(key, body);
              if (failDelivery) { throw new Error("delivery failed"); }
              return { statusCode: 202 };
            } },
            async onCaptureError(error) { failures.push(error); throw new Error("callback failed"); }
          });
          if (factory === "errorEvent") { await assert.rejects(route(request), error => error === original); }
          else { assert.equal((await route(request)).status, 202); }
          assert.equal(transport.sentBodies.length, 1);
          assert.equal(failures[0], factoryError);
          assert.equal(failures.length, failDelivery ? 2 : 1);
          assert.equal(client.closed, !callerOwned && !failDelivery);
          assert.equal(getActiveLogBrewTrace(), undefined);
          const body = transport.lastBody();
          assert.deepEqual(JSON.parse(body).events.map(event => event.id), ["evt_manual"]);
          for (const value of ["private-value", "private-query", "private-payload"]) { assert.equal(body.includes(value), false); }
          if (failDelivery || callerOwned) {
            const recovery = RecordingTransport.alwaysAccept();
            await client.shutdown(recovery);
            assert.equal(client.closed, true);
            if (failDelivery) { assert.equal(JSON.parse(recovery.lastBody()).events[0].id, "evt_manual"); }
          }
        }
      }
    }
  `);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Next request-error issues correlate normalized incoming trace context without raw headers", () => {
  const result = runInstalledConsumer(`
    import assert from "node:assert/strict";
    import { RecordingTransport } from "@logbrew/sdk";
    import { createNextRequestErrorEvent } from "@logbrew/next";
    import { createLogBrewNextRequestErrorHandler } from "@logbrew/next/instrumentation";

    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentSpanId = "1111111111111111";
    const value = "00-" + traceId + "-" + parentSpanId + "-01";
    const context = { routerKind: "App Router", routePath: "/api/orders/[id]", routeType: "route" };
    const transport = RecordingTransport.alwaysAccept();
    const handler = createLogBrewNextRequestErrorHandler({ serverApiKey: "local-preview-key", transport });
    for (const headers of [
      { traceparent: value, authorization: "private-authorization", cookie: "private-cookie", baggage: "private-baggage" },
      { TrAcEpArEnT: value },
      { traceparent: value, get authorization() { throw new Error("authorization must not be read"); } },
      new Headers({ traceparent: value }),
      { traceparent: value.slice(0, -2) + "00" }
    ]) {
      const request = { method: "POST", path: "/api/orders/private-value?private-query=value", headers };
      const event = createNextRequestErrorEvent(new Error("route failed"), request, context);
      assert.equal(event.attributes.metadata.traceId, traceId);
      assert.equal(event.attributes.metadata.parentSpanId, parentSpanId);
      assert.equal(event.attributes.metadata.sampled, !(headers.traceparent?.endsWith("00")));
      assert.equal("spanId" in event.attributes.metadata, false);
      await handler(new Error("route failed"), request, context);
      const body = transport.lastBody();
      const issue = JSON.parse(body).events[0];
      assert.equal(issue.type, "issue");
      assert.equal(issue.attributes.metadata.traceId, traceId);
      for (const marker of ["traceparent", "private-authorization", "private-cookie", "private-baggage", "private-value", "private-query"]) {
        assert.equal(body.includes(marker), false);
      }
    }
    for (const headers of [
      {}, { traceparent: "private-malformed-value" },
      { traceparent: "00-00000000000000000000000000000000-1111111111111111-01" },
      { traceparent: "00-" + traceId + "-0000000000000000-01" },
      { traceparent: [value, value] },
      { traceparent: value, TRACEPARENT: value },
      { get traceparent() { throw new Error("header unavailable"); } }
    ]) {
      await handler(new Error("route failed"), { method: "POST", path: "/api/orders/private-value", headers }, context);
      const issue = JSON.parse(transport.lastBody()).events[0];
      assert.equal(issue.type, "issue");
      assert.equal("traceId" in issue.attributes.metadata, false);
      assert.equal("parentSpanId" in issue.attributes.metadata, false);
      assert.equal("sampled" in issue.attributes.metadata, false);
    }
    assert.equal(transport.sentBodies.length, 12);
    const peerTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await Promise.all([
      handler(new Error("first route failed"), { method: "POST", path: "/api/orders/sample", headers: { traceparent: value } }, context),
      handler(new Error("second route failed"), { method: "POST", path: "/api/orders/sample", headers: { traceparent: "00-" + peerTraceId + "-bbbbbbbbbbbbbbbb-01" } }, context)
    ]);
    const correlated = transport.sentBodies.slice(-2).map(body => JSON.parse(body).events[0].attributes.metadata);
    assert.deepEqual(correlated.map(metadata => metadata.traceId).sort(), [traceId, peerTraceId].sort());
    assert.equal(correlated.find(metadata => metadata.traceId === peerTraceId).parentSpanId, "bbbbbbbbbbbbbbbb");
  `);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Next request-error instrumentation captures stable context without request data", () => {
  const result = runInstalledConsumer(`
    import assert from "node:assert/strict";
    import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";
    import { createNextRequestErrorEvent } from "@logbrew/next";
    import { createLogBrewNextRequestErrorHandler } from "@logbrew/next/instrumentation";

    const error = Object.assign(new Error("checkout render failed"), {
      digest: "next_digest_123"
    });
    const request = {
      path: "/orders/order-42?debug=sample#receipt",
      method: "POST",
      headers: {
        authorization: "Bearer sample",
        cookie: "session=sample"
      }
    };
    const context = {
      routerKind: "App Router",
      routePath: "/app/orders/[orderId]/page",
      routeType: "render",
      renderSource: "react-server-components",
      revalidateReason: "stale",
      renderType: "dynamic"
    };

    const event = createNextRequestErrorEvent(error, request, context, {
      idFactory: () => "evt_next_request_error_001",
      now: () => "2026-08-01T10:00:00Z"
    });
    assert.equal(event.id, "evt_next_request_error_001");
    assert.equal(event.attributes.title, "POST /app/orders/[orderId]/page failed");
    assert.equal(event.attributes.message, "checkout render failed");
    const {
      errorFrameColumn,
      errorFrameFile,
      errorFrameLine,
      issueGroupingKey,
      ...stableMetadata
    } = event.attributes.metadata;
    assert.deepEqual(stableMetadata, {
      framework: "nextjs",
      method: "POST",
      routePath: "/app/orders/[orderId]/page",
      routerKind: "App Router",
      routeType: "render",
      renderSource: "react-server-components",
      revalidateReason: "stale",
      renderType: "dynamic",
      errorDigest: "next_digest_123",
      source: "nextjs.on_request_error",
      errorName: "Error",
      errorMessage: "checkout render failed",
      issueGroupingSource: "error_type_and_frame"
    });
    assert.equal(errorFrameFile, "consumer.mjs");
    assert.equal(typeof errorFrameLine, "number");
    assert.equal(typeof errorFrameColumn, "number");
    assert.equal(typeof issueGroupingKey, "string");
    assert.deepEqual(event.attributes.exception, {
      type: "Error",
      mechanism: { type: "nextjs.on_request_error", handled: false }
    });
    assert.equal(event.attributes.stackFrames[0].filename, "consumer.mjs");
    assert.equal(event.attributes.metadata.errorStack, undefined);
    const serializedEvent = JSON.stringify(event);
    for (const unsafeValue of ["order-42", "debug=", "Bearer", "session=", "#receipt"]) {
      assert.equal(serializedEvent.includes(unsafeValue), false, unsafeValue);
    }

    const defaultEventOne = createNextRequestErrorEvent(error, request, context);
    const defaultEventTwo = createNextRequestErrorEvent(error, request, context);
    assert.match(defaultEventOne.id, /^evt_next_request_error_[0-9a-f]{16}$/);
    assert.notEqual(defaultEventOne.id, defaultEventTwo.id);
    assert.equal(defaultEventOne.id.includes("order"), false);

    const transport = RecordingTransport.alwaysAccept();
    let flushes = 0;
    const onRequestError = createLogBrewNextRequestErrorHandler({
      serverApiKey: "LOGBREW_SERVER_API_KEY",
      transport,
      idFactory: () => "evt_next_request_error_002",
      now: () => "2026-08-01T10:00:01Z",
      onFlush(response, runtime) {
        flushes += 1;
        assert.equal(response.statusCode, 202);
        assert.equal(runtime.context.routeType, "render");
      }
    });
    await onRequestError(error, request, context);
    assert.equal(flushes, 1);
    const payload = JSON.parse(transport.lastBody());
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].type, "issue");
    assert.equal(payload.events[0].id, "evt_next_request_error_002");
    assert.equal(JSON.stringify(payload).includes("order-42"), false);

    const reusableClient = LogBrewClient.create({
      apiKey: "LOGBREW_SERVER_API_KEY",
      sdkName: "next-request-error-test",
      sdkVersion: "0.1.0",
      maxRetries: 0
    });
    const acceptedBodies = [];
    const reusableTransport = {
      async send(_apiKey, body) {
        acceptedBodies.push(body);
        return { statusCode: 202, attempts: 1 };
      }
    };
    const reusableHandler = createLogBrewNextRequestErrorHandler({
      client: reusableClient,
      transport: reusableTransport,
      now: () => "2026-08-01T10:00:02Z"
    });
    await reusableHandler(error, request, context);
    await reusableHandler(error, request, context);
    assert.equal(acceptedBodies.length, 2);
    assert.equal((await reusableClient.flush(reusableTransport)).batches, 0);

    let captureFailures = 0;
    const resilientHandler = createLogBrewNextRequestErrorHandler({
      serverApiKey: "LOGBREW_SERVER_API_KEY",
      maxRetries: 0,
      transport: {
        async send() {
          throw new Error("telemetry offline");
        }
      },
      async onCaptureError(captureError, runtime) {
        captureFailures += 1;
        assert.equal(captureError.message, "telemetry offline");
        assert.equal(runtime.error, error);
      }
    });
    await resilientHandler(error, request, context);
    assert.equal(captureFailures, 1);

    let edgeSends = 0;
    process.env.NEXT_RUNTIME = "edge";
    const edgeHandler = createLogBrewNextRequestErrorHandler({
      serverApiKey: "LOGBREW_SERVER_API_KEY",
      transport: {
        async send() {
          edgeSends += 1;
          return { statusCode: 202, attempts: 1 };
        }
      }
    });
    await edgeHandler(error, request, context);
    delete process.env.NEXT_RUNTIME;
    assert.equal(edgeSends, 0);
  `);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Next request-error instrumentation exposes the CommonJS package entry", () => {
  const result = runInstalledConsumer(`
    const assert = require("node:assert/strict");
    const next = require("@logbrew/next");
    const instrumentation = require("@logbrew/next/instrumentation");

    assert.equal(typeof next.createNextRequestErrorEvent, "function");
    assert.equal(typeof next.createLogBrewNextRequestErrorHandler, "function");
    assert.equal(typeof instrumentation.createLogBrewNextRequestErrorHandler, "function");
  `, { extension: "cjs" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Next request-error instrumentation leaves Edge runtime imports dependency-free", () => {
  const result = runInstalledConsumer(`
    import assert from "node:assert/strict";
    import { createLogBrewNextRequestErrorHandler } from "@logbrew/next/instrumentation";

    process.env.NEXT_RUNTIME = "edge";
    let captureFailures = 0;
    const onRequestError = createLogBrewNextRequestErrorHandler({
      async onCaptureError() {
        captureFailures += 1;
      }
    });
    await onRequestError(
      Object.assign(new Error("edge failure"), { digest: "edge_digest" }),
      { path: "/edge", method: "GET", headers: {} },
      { routerKind: "App Router", routePath: "/app/edge/page", routeType: "render" }
    );
    assert.equal(captureFailures, 0);
  `, { linkDependencies: false });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test("CommonJS request-error instrumentation skips Edge runtime without Node dependencies", () => {
  const result = runInstalledConsumer(`
    const assert = require("node:assert/strict");
    const { createLogBrewNextRequestErrorHandler } = require("@logbrew/next/instrumentation");
    process.env.NEXT_RUNTIME = "edge";
    let failures = 0;
    const handler = createLogBrewNextRequestErrorHandler({
      onCaptureError() { failures += 1; }
    });
    handler(new Error("edge failure"), { path: "/edge", method: "GET" }, {}).then(() => {
      assert.equal(failures, 0);
    });
  `, { extension: "cjs", linkDependencies: false });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test("Instrumentation runtime detection failures stay inside the telemetry boundary", () => {
  const result = runInstalledConsumer(`
    import assert from "node:assert/strict";
    import { createLogBrewNextRequestErrorHandler } from "@logbrew/next/instrumentation";
    let failures = 0;
    const handler = createLogBrewNextRequestErrorHandler({
      async onCaptureError(error) {
        assert.ok(error instanceof TypeError);
        failures += 1;
        throw new Error("callback failed");
      }
    });
    const originalProcess = globalThis.process;
    try {
      globalThis.process = undefined;
      await handler(new Error("application failed"), {}, {});
    } finally {
      globalThis.process = originalProcess;
    }
    assert.equal(failures, 1);
  `, { linkDependencies: false });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test("Request-error hooks finalize manual events after issue capture fails", () => {
  const result = runInstalledConsumer(`
    import assert from "node:assert/strict";
    import { RecordingTransport } from "@logbrew/sdk";
    import { createLogBrewNextClient, createLogBrewNextRequestErrorHandler } from "@logbrew/next";

    const applicationError = new Error("application failed");
    const captureError = new Error("event factory failed");
    const request = { method: "GET", path: "/api/orders/private-value?private-query=value", headers: {} };
    for (const callerOwned of [true, false]) {
      for (const failDelivery of [false, true]) {
        const client = createLogBrewNextClient({ serverApiKey: "local-preview-key", maxRetries: 0 });
        const recording = RecordingTransport.alwaysAccept();
        let attempts = 0;
        const accepted = [];
        const failures = [];
        const flushes = [];
        const handler = createLogBrewNextRequestErrorHandler({
          client: callerOwned ? client : () => client,
          transport: { async send(key, body) {
            attempts += 1;
            if (failDelivery) { throw new Error("delivery failed"); }
            accepted.push(JSON.parse(body));
            return recording.send(key, body);
          } },
          errorEvent(error, runtime) {
            assert.equal(error, applicationError);
            assert.equal(runtime.client, client);
            client.log("evt_manual", "2026-08-01T10:00:00Z", { message: "work started", level: "info" });
            throw captureError;
          },
          async onCaptureError(error, runtime) {
            failures.push(error);
            assert.equal(runtime.error, applicationError);
            assert.equal(runtime.request, request);
            throw new Error("callback failed");
          },
          async onFlush(response, runtime) {
            flushes.push(response);
            assert.equal(runtime.error, applicationError);
          }
        });
        assert.equal(await handler(applicationError, request, { routePath: "/api/orders/[id]", routeType: "route" }), undefined);
        assert.equal(attempts, 1);
        assert.equal(failures[0], captureError);
        assert.equal(failures.length, failDelivery ? 2 : 1);
        assert.equal(flushes.length, failDelivery ? 0 : 1);
        assert.equal(client.closed, !callerOwned && !failDelivery);
        if (failDelivery) {
          assert.equal(accepted.length, 0);
          const recovery = RecordingTransport.alwaysAccept();
          await client.shutdown(recovery);
          assert.equal(client.closed, true);
          assert.deepEqual(JSON.parse(recovery.lastBody()).events.map(event => event.id), ["evt_manual"]);
        } else {
          assert.deepEqual(accepted[0].events.map(event => event.id), ["evt_manual"]);
          for (const marker of ["private-value", "private-query", "application failed"]) {
            assert.equal(recording.lastBody().includes(marker), false);
          }
          if (callerOwned) {
            client.log("evt_later", "2026-08-01T10:00:00Z", { message: "later work", level: "info" });
            await client.shutdown(recording);
            assert.equal(client.closed, true);
          }
        }
      }
    }
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test("Automatic route metadata keeps concrete paths out when no stable template is supplied", () => {
  const result = runInstalledConsumer(`
    import assert from "node:assert/strict";
    import { RecordingTransport } from "@logbrew/sdk";
    import { createNextRequestErrorEvent, createRequestMetricEvent, createRouteErrorEvent, createRouteRequestEvent, withLogBrewRouteHandler } from "@logbrew/next";
    const request = new Request("https://example.com/api/orders/private-value?private-query=value#private-fragment", {
      method: "POST", body: "private-body",
      headers: { authorization: "private-authorization", cookie: "private-cookie", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01" }
    });
    const original = new Error("route failed");
    const malformed = "https://[invalid-authority]/api/orders/private-value?private-query=value#private-fragment";
    for (const routeTemplate of [undefined, null, () => undefined, () => null, malformed]) {
      for (const fail of [false, true]) {
        const transport = RecordingTransport.alwaysAccept();
        const route = withLogBrewRouteHandler(async () => {
          if (fail) throw original;
          return new Response("ok", { status: 202 });
        }, { serverApiKey: "local-preview-key", routeTemplate, transport, captureRequestMetrics: true });
        if (fail) await assert.rejects(route(request), error => error === original);
        else assert.equal((await route(request)).status, 202);
        const payload = JSON.parse(transport.lastBody());
        assert.ok(payload.events.length > 0);
        for (const event of payload.events) assert.equal(event.attributes.metadata.routeTemplate, "/");
        for (const marker of ["private-value", "private-query", "private-fragment", "private-body", "private-authorization", "private-cookie", "invalid-authority", "traceparent"]) assert.equal(transport.lastBody().includes(marker), false);
      }
    }
    for (const routeTemplate of [undefined, malformed]) {
      for (const event of [
        createRouteRequestEvent(request, new Response("ok"), { routeTemplate }),
        createRouteErrorEvent(original, request, { routeTemplate }),
        createRequestMetricEvent(request, new Response("ok"), { routeTemplate })
      ]) assert.equal(event.attributes.metadata.routeTemplate, "/");
    }
    const hookEvent = createNextRequestErrorEvent(original, {
      path: malformed, method: "POST", headers: {}
    }, { routePath: malformed, routerKind: "App Router", routeType: "route" });
    assert.equal(hookEvent.attributes.metadata.routePath, "/");
    assert.equal(JSON.stringify(hookEvent).includes("private-value"), false);

    const stable = "https://example.com/api/orders/[id]?private-query=value#private-fragment";
    const stableEvent = createRouteRequestEvent(request, new Response("ok"), { routeTemplate: stable });
    assert.equal(stableEvent.attributes.metadata.routeTemplate, "/api/orders/[id]");
    assert.equal(stableEvent.attributes.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(stableEvent.attributes.parentSpanId, "1111111111111111");
    assert.equal(JSON.stringify(stableEvent).includes("private-query"), false);
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
