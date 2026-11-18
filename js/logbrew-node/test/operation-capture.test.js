import assert from "node:assert/strict";
import test from "node:test";

import { RecordingTransport } from "@logbrew/sdk";
import {
  addLogBrewBreadcrumb,
  captureLogBrewLog,
  createLogBrewNodeClient,
  createLogBrewTraceContext,
  databaseOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan,
  runWithLogBrewTrace,
  setLogBrewUser
} from "../index.js";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function newClient() {
  return createLogBrewNodeClient({ apiKey: "TEST_API_KEY", transport: RecordingTransport.alwaysAccept(), automaticDelivery: false, captureRuntimeContext: false });
}

function sent(client) {
  const events = JSON.parse(client.previewJson()).events;
  return Object.fromEntries(["issue", "log", "metric", "span"].map((type) => [type, events.filter((event) => event.type === type)]));
}

test("a failed queue job sends an issue on the job span's trace, with the job's user and breadcrumbs", async () => {
  const client = newClient();
  const job = queueOperationWithLogBrewSpan("process", {
    client,
    operationKind: "process",
    queueName: "orders",
    system: "bullmq",
    taskName: "charge",
    traceparent: TRACEPARENT,
    async operation() {
      setLogBrewUser("user-9");
      addLogBrewBreadcrumb({ category: "app", level: "info", message: "charging card" });
      await Promise.resolve();
      throw new TypeError("payment declined");
    }
  });
  await assert.rejects(job, /payment declined/u);

  const { issue: [issue], metric: [metric], span: [span] } = sent(client);
  assert.equal(span.attributes.status, "error");
  assert.equal(issue.attributes.title, "bullmq process orders failed");
  assert.equal(issue.attributes.exception.type, "TypeError");
  assert.equal(issue.attributes.message, "TypeError in bullmq process orders", "the error message stays out of the issue");
  assert.ok(!client.previewJson().includes("payment declined"), "the error message is not sent");
  assert.deepEqual(issue.attributes.exception.mechanism, { handled: false, type: "bullmq.process" });
  assert.ok(issue.attributes.stackFrames.length > 0, "the issue has stack frames");
  assert.deepEqual(issue.attributes.breadcrumbs.map((breadcrumb) => breadcrumb.message), ["charging card"]);
  for (const event of [issue, span]) {
    assert.equal(event.attributes.context.trace.traceId, span.attributes.traceId);
    assert.equal(event.attributes.context.trace.spanId, span.attributes.spanId);
    assert.deepEqual(event.attributes.context.subject, { id: "user-9", kind: "user" });
  }
  assert.equal(metric.attributes.name, "messaging.process.duration");
  assert.equal(metric.attributes.kind, "histogram");
  assert.equal(metric.attributes.unit, "ms");
  assert.deepEqual(metric.attributes.metadata, {
    framework: "node:queue",
    "messaging.destination.name": "orders",
    "messaging.operation.name": "process",
    "messaging.operation.type": "process",
    "messaging.system": "bullmq",
    operation: "process",
    status: "error",
    errorType: "TypeError"
  });
});

test("a database query keeps the request's user and breadcrumbs, and a later issue sees the query", async () => {
  const client = newClient();
  await runWithLogBrewTrace(createLogBrewTraceContext(TRACEPARENT), async () => {
    setLogBrewUser("user-1");
    addLogBrewBreadcrumb({ category: "app", level: "info", message: "checkout started" });
    await databaseOperationWithLogBrewSpan("Order", { client, operationKind: "create", system: "prisma", operation: async () => ({ id: 1 }) });
    await assert.rejects(
      databaseOperationWithLogBrewSpan("Order", {
        client,
        operationKind: "create",
        system: "prisma",
        async operation() {
          throw new Error("Unique constraint failed");
        }
      })
    );
  });

  const { issue: [issue], metric: metrics, span: spans } = sent(client);
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map((span) => span.attributes.context.subject.id), ["user-1", "user-1"]);
  assert.deepEqual(issue.attributes.context.subject, { id: "user-1", kind: "user" });
  assert.equal(issue.attributes.context.trace.spanId, spans[1].attributes.spanId);
  assert.equal(issue.attributes.exception.mechanism.handled, true, "the app can still catch a failed query");
  assert.deepEqual(issue.attributes.breadcrumbs.map((breadcrumb) => breadcrumb.message), ["checkout started", "prisma create Order"]);
  assert.deepEqual(metrics.map((metric) => [metric.attributes.name, metric.attributes.metadata.status]), [
    ["db.client.operation.duration", "ok"],
    ["db.client.operation.duration", "error"]
  ]);
});

test("a framework log line becomes a log on the active trace and a breadcrumb for the next issue", async () => {
  const client = newClient();
  await runWithLogBrewTrace(createLogBrewTraceContext(TRACEPARENT), async () => {
    captureLogBrewLog(client, { level: "warn", logger: "kafkajs", message: "rebalancing", metadata: { namespace: "Consumer" } });
    await assert.rejects(
      queueOperationWithLogBrewSpan("orders", { client, operationKind: "send", system: "kafka", operation: () => Promise.reject(new Error("broker down")) })
    );
  });

  const { issue: [issue], log: [log], metric: [metric] } = sent(client);
  assert.equal(log.attributes.message, "rebalancing");
  assert.equal(log.attributes.level, "warning");
  assert.equal(log.attributes.logger, "kafkajs");
  assert.equal(log.attributes.metadata.namespace, "Consumer");
  assert.equal(log.attributes.context.trace.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.deepEqual(issue.attributes.breadcrumbs.map((breadcrumb) => [breadcrumb.category, breadcrumb.level, breadcrumb.message]), [
    ["log.kafkajs", "warning", "rebalancing"]
  ]);
  assert.equal(metric.attributes.name, "messaging.client.operation.duration");
});

test("capture failures never reach the app", () => {
  assert.doesNotThrow(() => captureLogBrewLog(undefined, { message: "lost" }));
  assert.doesNotThrow(() => captureLogBrewLog(newClient(), { message: "" }));
});
