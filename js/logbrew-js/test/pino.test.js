import { LOGGER_TRACE, callUnchecked, eventValues, lastPayload, member, metadataValue, pick, sampleClient } from "./tracing-helpers.js";
import { RecordingTransport, createLogBrewPinoDestination, logAttributesFromPinoRecord } from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { LogBrewClient, PinoDestinationHandle } from "@logbrew/sdk"
 */

/**
 * @typedef {{ readonly client: LogBrewClient, readonly destination: Readonly<PinoDestinationHandle>, readonly errors: readonly unknown[], readonly transport: RecordingTransport }} PinoScenario
 */

const NO_EVENTS = 0;
const ONE_ERROR = 1;
const ONE_BODY = 1;
const TWO_EVENTS = 2;
const ORDER_ID = 42;

/**
 * @returns {Record<string, unknown>}
 */
function unsafePinoRecord() {
  return {
    accessKey: "hidden access key",
    authorization: "Bearer hidden",
    cookie: "session=hidden",
    err: {
      message: "database unavailable",
      stack: "hidden stack",
      type: "TypeError"
    },
    [["host", "name"].join("")]: "host.local",
    ignoredObject: { nested: true },
    level: 40,
    msg: "checkout slow",
    orderId: 42,
    pid: 123,
    privateKey: "hidden key",
    rawBody: "hidden raw payload",
    requestBody: "hidden payload",
    requestUrl: "/checkout/42?token=hidden",
    responseHeaders: "hidden headers",
    service: "checkout",
    time: "2026-06-02T10:00:06.000Z"
  };
}

/**
 * @returns {PinoScenario}
 */
function pinoScenario() {
  const client = sampleClient();
  const transport = RecordingTransport.alwaysAccept();
  /** @type {unknown[]} */
  const errors = [];
  const destination = createLogBrewPinoDestination({
    client,
    eventIdPrefix: "test_pino",
    logger: "pino",
    metadata: { service: "checkout" },
    onError(reason) {
      errors.push(reason);
    },
    transport
  });
  return { client, destination, errors, transport };
}

/**
 * @param {Readonly<PinoDestinationHandle>} destination
 * @returns {void}
 */
function writePinoRecords(destination) {
  destination.write(`${JSON.stringify({
    level: 30,
    msg: "cart ready",
    orderId: 42,
    time: 1_780_394_406_000
  })}\n`);
  destination.write(`${JSON.stringify({
    err: {
      message: "boom",
      stack: "hidden stack",
      type: "Error"
    },
    level: 60,
    msg: "checkout failed",
    time: "2026-06-02T10:00:06.000Z"
  })}\n`);
  destination.write("not json\n");
}

/**
 * @param {RecordingTransport} transport
 * @returns {void}
 */
function assertPinoBody(transport) {
  const body = lastPayload(transport);
  assert.deepEqual(eventValues(body, "id"), ["test_pino_1", "test_pino_2"]);
  assert.deepEqual(eventValues(body, "attributes.level"), ["info", "critical"]);
  assert.equal(pick(body, "events.0.timestamp"), "2026-06-02T10:00:06.000Z");
  assert.equal(metadataValue(pick(body, "events.0"), "context.orderId"), ORDER_ID);
  assert.equal(metadataValue(pick(body, "events.1"), "errorName"), "Error");
  assert.equal(metadataValue(pick(body, "events.1"), "errorStack"), undefined);
}

await test("Pino record helper maps safe log attributes", () => {
  const attributes = callUnchecked(logAttributesFromPinoRecord, [
    unsafePinoRecord(),
    {
      logger: "pino",
      metadata: {
        ignoredObject: { nested: true },
        region: "global"
      }
    }
  ]);

  assert.equal(pick(attributes, "level"), "warning");
  assert.equal(pick(attributes, "logger"), "pino");
  assert.equal(pick(attributes, "message"), "checkout slow");
  assert.deepEqual(pick(attributes, "metadata"), {
    "context.orderId": 42,
    "context.service": "checkout",
    errorMessage: "database unavailable",
    errorName: "TypeError",
    pinoLevel: "warn",
    pinoLevelNumber: 40,
    region: "global"
  });
});

await test("Pino record helper adds explicit trace correlation metadata", () => {
  const attributes = logAttributesFromPinoRecord({
    level: 30,
    msg: "checkout trace",
    orderId: 42
  }, {
    logger: "pino",
    metadata: {
      service: "checkout",
      traceId: "caller-supplied"
    },
    trace: LOGGER_TRACE
  });

  assert.equal(attributes.level, "info");
  assert.equal(attributes.logger, "pino");
  assert.equal(member(attributes.metadata, "service"), "checkout");
  assert.equal(member(attributes.metadata, "traceId"), LOGGER_TRACE.traceId);
  assert.equal(member(attributes.metadata, "spanId"), LOGGER_TRACE.spanId);
  assert.equal(member(attributes.metadata, "parentSpanId"), LOGGER_TRACE.parentSpanId);
  assert.equal(member(attributes.metadata, "sampled"), true);
  assert.equal(member(attributes.metadata, "context.orderId"), ORDER_ID);
});

await test("Pino destination queues records and flushes safely", async () => {
  const { client, destination, errors, transport } = pinoScenario();
  writePinoRecords(destination);

  assert.equal(errors.length, ONE_ERROR);
  assert.equal(client.pendingEvents(), TWO_EVENTS);
  await destination.flush();
  assert.equal(client.pendingEvents(), NO_EVENTS);
  assert.equal(transport.sentBodies.length, ONE_BODY);
  assertPinoBody(transport);
});
