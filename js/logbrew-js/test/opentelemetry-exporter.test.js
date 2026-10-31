import { RecordingTransport, createLogBrewOpenTelemetrySpanExporter } from "@logbrew/sdk";
import {
  TRACE_FLAGS_SAMPLED,
  TRACE_FLAGS_UNSAMPLED,
  assertExcludes,
  captureRejection,
  deferred,
  eventValues,
  gatedTransport,
  lastPayload,
  member,
  parseJson,
  pick,
  sampleClient,
  sampleOpenTelemetryReadableSpan,
  sampleSpanWithContext
} from "./tracing-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { LogBrewClient, OpenTelemetryExportResult, OpenTelemetrySpanExporterHandle } from "@logbrew/sdk"
 * @import { Deferred, GatedTransport, SampleReadableSpan } from "./tracing-helpers.js"
 */

/**
 * @typedef {Readonly<OpenTelemetrySpanExporterHandle>} Exporter
 * @typedef {{ readonly client: LogBrewClient, readonly exporter: Exporter, readonly gate: GatedTransport }} GatedExport
 * @typedef {{ readonly client: LogBrewClient, readonly errors: readonly unknown[], readonly exporter: Exporter, readonly transport: RecordingTransport }} ExportScenario
 */

const NO_EVENTS = 0;
const TWO_EVENTS = 2;
const ONE_SEND = 1;
const TWO_SENDS = 2;
const EXPORT_FAILED = 1;
const ACCEPTED = 202;
const SERVER_ERROR = 500;

/**
 * @param {Exporter} exporter
 * @param {readonly unknown[]} spans
 * @returns {Promise<OpenTelemetryExportResult>}
 */
async function exportSpans(exporter, spans) {
  /** @type {Deferred<OpenTelemetryExportResult>} */
  const result = deferred();
  exporter.export(spans, result.resolve);
  return result.promise;
}

/**
 * @returns {SampleReadableSpan}
 */
function laterSpan() {
  return sampleSpanWithContext("cccccccccccccccccccccccccccccccc", "dddddddddddddddd", TRACE_FLAGS_SAMPLED);
}

/**
 * @param {RecordingTransport} transport
 * @returns {void}
 */
function assertExportedPayload(transport) {
  const payload = lastPayload(transport);
  assert.equal(pick(payload, "events.length"), TWO_EVENTS);
  assert.deepEqual(eventValues(payload, "id"), ["otel_export_1", "otel_export_trace_1"]);
  assert.equal(pick(payload, "events.0.attributes.metadata.source"), "opentelemetry.readable_span");
  assert.equal(pick(payload, "events.1.attributes.metadata.source"), "opentelemetry.trace_summary");
  assert.equal(member(pick(payload, "events.0.attributes.links.0.metadata"), "messaging.operation.name"), "process");
  assertExcludes(JSON.stringify(payload), ["api_key=redacted", "db.statement"]);
}

/**
 * @returns {ExportScenario}
 */
function exportScenario() {
  /** @type {unknown[]} */
  const errors = [];
  const client = sampleClient();
  const transport = RecordingTransport.alwaysAccept();
  const exporter = createLogBrewOpenTelemetrySpanExporter({
    client,
    eventIdPrefix: "otel_export",
    includeTraceSummary: true,
    linkAttributeKeys: ["messaging.operation.name"],
    onError: (reason) => {
      errors.push(reason);
    },
    transport
  });
  return { client, errors, exporter, transport };
}

/**
 * @returns {GatedExport}
 */
function drainExport() {
  const client = sampleClient();
  const gate = gatedTransport(ACCEPTED);
  const exporter = createLogBrewOpenTelemetrySpanExporter({
    client,
    eventIdPrefix: "otel_export_drain",
    transport: gate.transport
  });
  return { client, exporter, gate };
}

/**
 * @returns {GatedExport}
 */
function failingExport() {
  const client = sampleClient({ maxRetries: 0 });
  const gate = gatedTransport(SERVER_ERROR);
  const exporter = createLogBrewOpenTelemetrySpanExporter({
    client,
    transport: gate.transport
  });
  return { client, exporter, gate };
}

/**
 * @param {GatedExport} scenario
 * @param {readonly unknown[]} results
 * @param {Readonly<Promise<unknown>>} shutdownError
 * @returns {Promise<void>}
 */
async function assertCoalescedExport({ client, gate }, results, shutdownError) {
  assert.deepEqual(results.map((result) => pick(result, "code")), [EXPORT_FAILED, EXPORT_FAILED]);
  assert.ok(await shutdownError instanceof Error);
  assert.equal(gate.sends.length, ONE_SEND);
  assert.equal(client.pendingEvents(), TWO_EVENTS);
}

await test("OpenTelemetry span exporter exports batches through standard exporter callbacks", async () => {
  const { client, errors, exporter, transport } = exportScenario();

  const result = await exportSpans(exporter, [
    sampleOpenTelemetryReadableSpan(),
    sampleSpanWithContext("cccccccccccccccccccccccccccccccc", "dddddddddddddddd", TRACE_FLAGS_UNSAMPLED)
  ]);

  assert.deepEqual(result, { code: 0 });
  assert.deepEqual(errors, []);
  assert.equal(client.pendingEvents(), NO_EVENTS);
  assertExportedPayload(transport);

  await exporter.shutdown();
  const closedResult = await exportSpans(exporter, [sampleOpenTelemetryReadableSpan()]);
  assert.equal(closedResult.code, EXPORT_FAILED);
});

await test("OpenTelemetry span exporter drains spans submitted during an in-flight export", async () => {
  const { client, exporter, gate } = drainExport();

  const firstResult = exportSpans(exporter, [sampleOpenTelemetryReadableSpan()]);
  await gate.firstSendStarted.promise;

  const laterResult = exportSpans(exporter, [laterSpan()]);
  gate.releaseFirstSend.resolve({ attempts: 1, statusCode: ACCEPTED });

  assert.deepEqual(await Promise.all([firstResult, laterResult]), [{ code: 0 }, { code: 0 }]);
  assert.equal(gate.sends.length, TWO_SENDS);
  assert.deepEqual(
    gate.sends.map((body) => eventValues(parseJson(body), "id")),
    [["otel_export_drain_1"], ["otel_export_drain_2"]]
  );
  assert.equal(client.pendingEvents(), NO_EVENTS);
});

await test("OpenTelemetry span exporter coalesces export and shutdown failure without retry amplification", async () => {
  const { client, exporter, gate } = failingExport();

  const firstResult = exportSpans(exporter, [sampleOpenTelemetryReadableSpan()]);
  await gate.firstSendStarted.promise;
  const secondResult = exportSpans(exporter, [laterSpan()]);
  const shutdownError = captureRejection(async () => exporter.shutdown());
  gate.releaseFirstSend.resolve({ attempts: 1, statusCode: SERVER_ERROR });

  const results = await Promise.all([firstResult, secondResult]);
  await assertCoalescedExport({ client, exporter, gate }, results, shutdownError);
});
