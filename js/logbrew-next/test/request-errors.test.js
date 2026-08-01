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
    assert.deepEqual(event.attributes.metadata, {
      framework: "nextjs",
      method: "POST",
      routePath: "/app/orders/[orderId]/page",
      routerKind: "App Router",
      routeType: "render",
      renderSource: "react-server-components",
      revalidateReason: "stale",
      renderType: "dynamic",
      errorDigest: "next_digest_123"
    });
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
