import { LOGGER_TRACE, callUnchecked, eventById, eventValues, items, lastPayload, member, metadataValue, parseJson, pick, sampleClient } from "./tracing-helpers.js";
import {
  RecordingTransport,
  createIssueAttributesFromError,
  createLogBrewWinstonTransport,
  logAttributesFromWinstonInfo
} from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { LogBrewClient, WinstonTransportHandle } from "@logbrew/sdk"
 */

/**
 * @typedef {{ readonly client: LogBrewClient, readonly errors: readonly unknown[], readonly transport: RecordingTransport, readonly winstonTransport: Readonly<WinstonTransportHandle> }} WinstonScenario
 */

const NO_EVENTS = 0;
const ONE_ERROR = 1;
const ONE_BODY = 1;
const TWO_EVENTS = 2;
const ORDER_ID = 42;
const SHORT_MESSAGE_LIMIT = 40;
const LONG_MESSAGE_LENGTH = 600;
const MAX_BREADCRUMB_MESSAGE_LENGTH = 512;
const ISSUE_TIMESTAMP = "2026-06-02T10:00:08.000Z";

/**
 * @returns {WinstonScenario}
 */
function winstonScenario() {
  const client = sampleClient();
  const transport = RecordingTransport.alwaysAccept();
  /** @type {unknown[]} */
  const errors = [];
  const winstonTransport = createLogBrewWinstonTransport({
    client,
    eventIdPrefix: "test_winston",
    logger: "winston",
    metadata: { service: "checkout" },
    onError(reason) {
      errors.push(reason);
    },
    transport
  });
  return { client, errors, transport, winstonTransport };
}

/**
 * @param {Readonly<WinstonTransportHandle>} winstonTransport
 * @returns {void}
 */
function writeWinstonInfos(winstonTransport) {
  winstonTransport.write({
    level: "info",
    message: "cart ready",
    orderId: 42,
    timestamp: new Date("2026-06-02T10:00:06.000Z")
  });
  winstonTransport.write({
    level: "error",
    message: "checkout failed",
    stack: "TypeError: payment failed\n    at checkout.js:1:1",
    timestamp: "2026-06-02T10:00:07.000Z"
  });
  callUnchecked(winstonTransport.write.bind(winstonTransport), ["not an info object"]);
}

/**
 * @param {RecordingTransport} transport
 * @returns {void}
 */
function assertWinstonBody(transport) {
  const body = lastPayload(transport);
  assert.deepEqual(eventValues(body, "id"), ["test_winston_1", "test_winston_2"]);
  assert.deepEqual(eventValues(body, "attributes.level"), ["info", "error"]);
  assert.equal(pick(body, "events.0.timestamp"), "2026-06-02T10:00:06.000Z");
  assert.equal(metadataValue(pick(body, "events.0"), "context.orderId"), ORDER_ID);
  const errorEvent = pick(body, "events.1");
  assert.equal(metadataValue(errorEvent, "errorName"), "TypeError");
  assert.equal(metadataValue(errorEvent, "errorMessage"), "payment failed");
  assert.equal(metadataValue(errorEvent, "errorStack"), undefined);
}

/**
 * @param {LogBrewClient} client
 * @param {string} id
 * @returns {unknown}
 */
function issueAttributesAfter(client, id) {
  const attributes = createIssueAttributesFromError(new Error("checkout failed"));
  client.issue(id, ISSUE_TIMESTAMP, attributes);
  const preview = parseJson(client.previewJson());
  return pick(eventById(preview, id), "attributes");
}

/**
 * @param {LogBrewClient} client
 * @returns {void}
 */
function writeBreadcrumbInfos(client) {
  const winstonTransport = createLogBrewWinstonTransport({ client, metadata: { service: "checkout" } });
  winstonTransport.write({ level: "info", message: "cart ready", orderId: 42 });
  winstonTransport.write({ level: "warn", message: "stock low" });
  winstonTransport.write({ level: "silly", message: "x".repeat(LONG_MESSAGE_LENGTH) });
}

/**
 * @param {unknown} issue
 * @returns {readonly (readonly unknown[])[]}
 */
function breadcrumbSummaries(issue) {
  return items(pick(issue, "breadcrumbs")).map((breadcrumb) => {
    const message = pick(breadcrumb, "message");
    const shown = typeof message === "string" && message.length > SHORT_MESSAGE_LIMIT ? message.length : message;
    return [pick(breadcrumb, "category"), pick(breadcrumb, "level"), shown];
  });
}

await test("Winston info helper maps safe log attributes", () => {
  const attributes = callUnchecked(logAttributesFromWinstonInfo, [
    {
      err: {
        message: "database unavailable",
        name: "TypeError",
        stack: "hidden stack"
      },
      ignoredObject: { nested: true },
      level: "warn",
      message: "checkout slow",
      orderId: 42,
      service: "checkout",
      timestamp: "2026-06-02T10:00:06.000Z"
    },
    {
      logger: "winston",
      metadata: {
        ignoredObject: { nested: true },
        region: "global"
      }
    }
  ]);

  assert.equal(pick(attributes, "level"), "warning");
  assert.equal(pick(attributes, "logger"), "winston");
  assert.equal(pick(attributes, "message"), "checkout slow");
  assert.deepEqual(pick(attributes, "metadata"), {
    "context.orderId": 42,
    "context.service": "checkout",
    errorMessage: "database unavailable",
    errorName: "TypeError",
    region: "global",
    winstonLevel: "warn"
  });

  const plainErrorAttributes = logAttributesFromWinstonInfo({
    level: "error",
    message: "payment failed",
    stack: "Error: payment failed\n    at checkout.js:1:1"
  });
  assert.equal(member(plainErrorAttributes.metadata, "errorName"), "Error");
  assert.equal(member(plainErrorAttributes.metadata, "errorMessage"), "payment failed");
  assert.equal(member(plainErrorAttributes.metadata, "errorStack"), undefined);
});

await test("Winston info helper adds explicit trace correlation metadata", () => {
  const attributes = logAttributesFromWinstonInfo({
    level: "info",
    message: "checkout trace",
    orderId: 42
  }, {
    logger: "winston",
    metadata: {
      service: "checkout",
      traceId: "caller-supplied"
    },
    trace: LOGGER_TRACE
  });

  assert.equal(attributes.level, "info");
  assert.equal(attributes.logger, "winston");
  assert.equal(member(attributes.metadata, "service"), "checkout");
  assert.equal(member(attributes.metadata, "traceId"), LOGGER_TRACE.traceId);
  assert.equal(member(attributes.metadata, "spanId"), LOGGER_TRACE.spanId);
  assert.equal(member(attributes.metadata, "parentSpanId"), LOGGER_TRACE.parentSpanId);
  assert.equal(member(attributes.metadata, "sampled"), true);
  assert.equal(member(attributes.metadata, "context.orderId"), ORDER_ID);
});

await test("Winston transport queues info objects and flushes safely", async () => {
  const { client, errors, transport, winstonTransport } = winstonScenario();
  writeWinstonInfos(winstonTransport);

  assert.equal(errors.length, ONE_ERROR);
  assert.equal(client.pendingEvents(), TWO_EVENTS);
  await winstonTransport.flush();
  assert.equal(client.pendingEvents(), NO_EVENTS);
  assert.equal(transport.sentBodies.length, ONE_BODY);
  assertWinstonBody(transport);
});

await test("Winston records become issue breadcrumbs unless breadcrumbs is false", () => {
  const client = sampleClient();
  writeBreadcrumbInfos(client);
  const issue = issueAttributesAfter(client, "evt_winston_issue");
  assert.deepEqual(breadcrumbSummaries(issue), [
    ["log.winston", "info", "cart ready"],
    ["log.winston", "warning", "stock low"],
    ["log.winston", "debug", MAX_BREADCRUMB_MESSAGE_LENGTH]
  ]);
  assert.equal(JSON.stringify(pick(issue, "breadcrumbs")).includes("orderId"), false);

  const quiet = sampleClient();
  createLogBrewWinstonTransport({ breadcrumbs: false, client: quiet }).write({ level: "info", message: "cart ready" });
  assert.equal(pick(issueAttributesAfter(quiet, "evt_winston_quiet"), "breadcrumbs"), undefined);
});
