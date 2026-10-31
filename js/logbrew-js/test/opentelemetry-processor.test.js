import { RecordingTransport, createLogBrewOpenTelemetrySpanProcessor } from "@logbrew/sdk";
import {
  TRACE_FLAGS_SAMPLED,
  TRACE_FLAGS_UNSAMPLED,
  deferred,
  eventValues,
  gatedTransport,
  lastPayload,
  parseJson,
  pick,
  sampleClient,
  sampleOpenTelemetryReadableSpan,
  sampleSpanWithContext
} from "./tracing-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { DroppedEvent, LogBrewClient, OpenTelemetrySpanProcessorHandle, TransportResponse } from "@logbrew/sdk"
 * @import { Deferred, GatedTransport } from "./tracing-helpers.js"
 */

/**
 * @typedef {Readonly<OpenTelemetrySpanProcessorHandle>} Processor
 * @typedef {{ readonly client: LogBrewClient, readonly dropped: readonly Readonly<DroppedEvent>[], readonly errors: readonly unknown[], readonly processor: Processor, readonly transport: RecordingTransport }} QueueScenario
 * @typedef {{ readonly responses: readonly Deferred<TransportResponse>[], readonly sendStarted: Deferred<void>, readonly sends: readonly string[] }} PendingSends
 * @typedef {{ readonly client: LogBrewClient, readonly errors: readonly unknown[], readonly gate: GatedTransport, readonly processor: Processor }} GatedScenario
 */

const NO_EVENTS = 0;
const ONE_EVENT = 1;
const ONE_SEND = 1;
const TWO_SENDS = 2;
const ONE_ERROR = 1;
const ACCEPTED = 202;
const SERVER_ERROR = 500;

/**
 * @returns {QueueScenario}
 */
function queueScenario() {
  /** @type {Readonly<DroppedEvent>[]} */
  const dropped = [];
  /** @type {unknown[]} */
  const errors = [];
  const client = sampleClient({
    maxQueueSize: 1,
    onEventDropped: (event) => {
      dropped.push(event);
    }
  });
  const transport = RecordingTransport.alwaysAccept();
  const processor = createLogBrewOpenTelemetrySpanProcessor({
    client,
    eventIdPrefix: "otel",
    onError: (reason) => {
      errors.push(reason);
    },
    timestamp: () => "2026-06-02T10:00:04Z",
    transport
  });
  return { client, dropped, errors, processor, transport };
}

/**
 * @param {QueueScenario} scenario
 * @returns {void}
 */
function endThreeSpans({ processor }) {
  processor.onStart({}, {});
  processor.onEnd(sampleOpenTelemetryReadableSpan());
  processor.onEnd(sampleSpanWithContext("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", TRACE_FLAGS_SAMPLED));
  processor.onEnd(sampleSpanWithContext("cccccccccccccccccccccccccccccccc", "dddddddddddddddd", TRACE_FLAGS_UNSAMPLED));
}

/**
 * @param {QueueScenario} scenario
 * @returns {void}
 */
function assertQueuedBeforeFlush({ client, dropped, errors }) {
  assert.equal(client.pendingEvents(), ONE_EVENT);
  assert.equal(client.droppedEvents(), ONE_EVENT);
  assert.equal(pick(dropped, "0.eventId"), "otel_2");
  assert.deepEqual(errors, []);
}

/**
 * @param {RecordingTransport} transport
 * @returns {void}
 */
function assertFlushedPayload(transport) {
  const payload = lastPayload(transport);
  assert.equal(pick(payload, "events.0.id"), "otel_1");
  assert.equal(pick(payload, "events.0.timestamp"), "2026-05-28T20:26:40.100Z");
  assert.equal(pick(payload, "events.0.attributes.metadata.source"), "opentelemetry.readable_span");
}

/**
 * @returns {PendingSends & { readonly processor: Processor, readonly client: LogBrewClient }}
 */
function pendingProcessor() {
  /** @type {string[]} */
  const sends = [];
  /** @type {Deferred<TransportResponse>[]} */
  const responses = [];
  /** @type {Deferred<void>} */
  const sendStarted = deferred();
  const client = sampleClient();
  const processor = createLogBrewOpenTelemetrySpanProcessor({
    client,
    transport: {
      async send(_apiKey, body) {
        sends.push(body);
        sendStarted.resolve();
        /** @type {Deferred<TransportResponse>} */
        const response = deferred();
        responses.push(response);
        return response.promise;
      }
    }
  });
  return { client, processor, responses, sendStarted, sends };
}

/**
 * @param {readonly Deferred<TransportResponse>[]} responses
 * @param {readonly Readonly<Promise<void>>[]} flushes
 * @returns {Promise<void>}
 */
async function releaseResponses(responses, flushes) {
  for (const response of responses) {
    response.resolve({ attempts: 1, statusCode: ACCEPTED });
  }
  await Promise.allSettled(flushes);
}

/**
 * @returns {GatedScenario}
 */
function drainScenario() {
  const client = sampleClient();
  const gate = gatedTransport(ACCEPTED);
  const processor = createLogBrewOpenTelemetrySpanProcessor({ client, eventIdPrefix: "otel_drain", transport: gate.transport });
  return { client, errors: [], gate, processor };
}

/**
 * @returns {GatedScenario}
 */
function failureScenario() {
  const client = sampleClient({ maxRetries: 0 });
  /** @type {unknown[]} */
  const errors = [];
  const gate = gatedTransport(SERVER_ERROR);
  const processor = createLogBrewOpenTelemetrySpanProcessor({
    client,
    onError: (reason) => {
      errors.push(reason);
    },
    transport: gate.transport
  });
  return { client, errors, gate, processor };
}

/**
 * @param {GatedScenario} scenario
 * @returns {void}
 */
function assertDrained({ client, gate }) {
  assert.equal(gate.sends.length, TWO_SENDS);
  assert.deepEqual(
    gate.sends.map((body) => eventValues(parseJson(body), "id")),
    [["otel_drain_1"], ["otel_drain_2"]]
  );
  assert.equal(client.pendingEvents(), NO_EVENTS);
}

/**
 * @param {GatedScenario} scenario
 * @returns {void}
 */
function assertCoalescedFailure({ client, errors, gate }) {
  assert.equal(gate.sends.length, ONE_SEND);
  assert.equal(errors.length, ONE_ERROR);
  assert.equal(client.pendingEvents(), ONE_EVENT);
}

await test("OpenTelemetry span processor queues bounded spans and flushes without owning OTel setup", async () => {
  const scenario = queueScenario();
  endThreeSpans(scenario);
  assertQueuedBeforeFlush(scenario);

  await scenario.processor.forceFlush();

  assert.equal(scenario.client.pendingEvents(), NO_EVENTS);
  assertFlushedPayload(scenario.transport);

  await scenario.processor.shutdown();
  scenario.processor.onEnd(sampleOpenTelemetryReadableSpan());
  assert.equal(scenario.client.pendingEvents(), NO_EVENTS);
});

await test("OpenTelemetry span processor avoids a redundant request for concurrent forceFlush calls", async () => {
  const { client, processor, responses, sendStarted, sends } = pendingProcessor();

  processor.onEnd(sampleOpenTelemetryReadableSpan());
  const flushes = [processor.forceFlush(), processor.forceFlush()];
  await sendStarted.promise;

  try {
    assert.equal(sends.length, ONE_SEND);
  } finally {
    await releaseResponses(responses, flushes);
  }
  assert.equal(client.pendingEvents(), NO_EVENTS);
  assert.equal(sends.length, ONE_SEND);
});

await test("OpenTelemetry span processor drains spans captured during an in-flight flush", async () => {
  const scenario = drainScenario();
  const { gate, processor } = scenario;

  processor.onEnd(sampleOpenTelemetryReadableSpan());
  const firstFlush = processor.forceFlush();
  await gate.firstSendStarted.promise;

  processor.onEnd(sampleSpanWithContext("cccccccccccccccccccccccccccccccc", "dddddddddddddddd", TRACE_FLAGS_SAMPLED));
  const laterFlush = processor.forceFlush();
  gate.releaseFirstSend.resolve({ attempts: 1, statusCode: ACCEPTED });

  await Promise.all([firstFlush, laterFlush]);
  assertDrained(scenario);
});

await test("OpenTelemetry span processor coalesces an in-flight failure without retry amplification", async () => {
  const scenario = failureScenario();
  const { gate, processor } = scenario;

  processor.onEnd(sampleOpenTelemetryReadableSpan());
  const firstFlush = processor.forceFlush();
  await gate.firstSendStarted.promise;
  const secondFlush = processor.forceFlush();
  const thirdFlush = processor.forceFlush();
  gate.releaseFirstSend.resolve({ attempts: 1, statusCode: SERVER_ERROR });

  await Promise.all([firstFlush, secondFlush, thirdFlush]);
  assertCoalescedFailure(scenario);
});

await test("OpenTelemetry span processor treats an undefined transport rejection as one failed flush", async () => {
  const client = sampleClient({ maxRetries: 0 });
  /** @type {unknown[]} */
  const errors = [];
  /** @type {string[]} */
  const sends = [];
  const processor = createLogBrewOpenTelemetrySpanProcessor({
    client,
    onError: (reason) => {
      errors.push(reason);
    },
    transport: {
      async send(_apiKey, body) {
        sends.push(body);
        throw undefined;
      }
    }
  });

  processor.onEnd(sampleOpenTelemetryReadableSpan());
  await Promise.all([processor.forceFlush(), processor.forceFlush()]);

  assert.equal(sends.length, ONE_SEND);
  assert.deepEqual(errors, [undefined]);
  assert.equal(client.pendingEvents(), ONE_EVENT);
});
