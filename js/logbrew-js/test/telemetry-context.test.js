import { LOGGER_TRACE, pick, previewEvents, sampleClient } from "./delivery-helpers.js";
import { SdkError } from "@logbrew/sdk";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { TelemetryContext } from "@logbrew/sdk"
 */

const TAG_LIMIT_EXCEEDED = 33;
const EXPECTED_CONTEXT = {
  resource: {
    deployment: { environment: "production", release: "checkout@2.4.0" },
    framework: { name: "fastify", version: "5" },
    runtime: { name: "node", version: "22" },
    service: { name: "checkout-api", version: "2.4.0" }
  },
  schemaVersion: 1,
  session: { id: "session_01", previousId: "session_00" },
  subject: { id: "subject_01", kind: "user" },
  tags: { plan: "team", region: "eu", route: "checkout.submit" },
  trace: { sampled: true, spanId: LOGGER_TRACE.spanId, traceId: LOGGER_TRACE.traceId }
};
const INVALID_CONTEXTS = [
  { schemaVersion: 2, tags: { plan: "team" } },
  { email: "person@example.test", schemaVersion: 1 },
  { resource: { device: {} }, schemaVersion: 1 },
  { schemaVersion: 1, trace: { traceId: "00000000000000000000000000000000" } },
  { schemaVersion: 1, session: { id: "same", previousId: "same" } },
  { schemaVersion: 1, subject: { id: "person@example.test", kind: "identified" } },
  { schemaVersion: 1, tags: Object.fromEntries(Array.from({ length: TAG_LIMIT_EXCEEDED }, (_slot, index) => [`tag_${index}`, "value"])) },
  { schemaVersion: 1, tags: { "unsafe key": "value" } },
  { schemaVersion: 1, tags: { plan: "safe\u0085unsafe" } }
];

/**
 * @returns {TelemetryContext}
 */
function sampleClientContext() {
  return {
    resource: {
      deployment: { environment: "production", release: "checkout@2.4.0" },
      framework: { name: "fastify", version: "5" },
      runtime: { name: "node", version: "22" },
      service: { name: "checkout-api", version: "2.4.0" }
    },
    schemaVersion: 1,
    subject: { id: "subject_01", kind: "user" },
    tags: { plan: "team", region: "eu" }
  };
}

/**
 * @returns {TelemetryContext}
 */
function sampleEventContext() {
  return {
    schemaVersion: 1,
    session: { id: "session_01", previousId: "session_00" },
    tags: { route: "checkout.submit" },
    trace: { sampled: true, spanId: LOGGER_TRACE.spanId, traceId: LOGGER_TRACE.traceId }
  };
}

/**
 * @param {unknown} target
 * @param {string} keyPath
 * @param {string} value
 * @returns {void}
 */
function setPath(target, keyPath, value) {
  const keys = keyPath.split(".");
  const name = keys.pop();
  const owner = pick(target, keys.join("."));
  assert.ok(typeof owner === "object" && owner !== null && name !== undefined);
  Reflect.set(owner, name, value);
}

/**
 * @param {unknown} event
 * @returns {boolean}
 */
function mutatingFilter(event) {
  setPath(event, "attributes.context.resource.service.name", "filter-mutated");
  setPath(event, "attributes.context.tags.plan", "filter-mutated");
  return true;
}

/**
 * @param {unknown} clientContext
 * @param {unknown} eventContext
 * @returns {void}
 */
function mutateCallerContexts(clientContext, eventContext) {
  setPath(clientContext, "resource.service.name", "caller-mutated");
  setPath(clientContext, "tags.plan", "caller-mutated");
  setPath(eventContext, "session.id", "caller-mutated");
  setPath(eventContext, "tags.route", "caller-mutated");
}

await test("shared telemetry context survives every event boundary and isolates caller mutation", () => {
  const clientContext = sampleClientContext();
  const eventContext = sampleEventContext();
  const client = sampleClient({ context: clientContext, eventFilter: mutatingFilter });

  client.log("evt_context_log", "2026-08-01T10:00:00Z", { context: eventContext, level: "info", message: "checkout started" });
  client.action("evt_context_action", "2026-08-01T10:00:01Z", { context: eventContext, name: "checkout.submit", status: "success" });

  mutateCallerContexts(clientContext, eventContext);

  const [log, action] = previewEvents(client);
  for (const event of [log, action]) {
    assert.deepEqual(pick(event, "attributes.context"), EXPECTED_CONTEXT);
  }
});

await test("shared telemetry context rejects ambiguous, unsafe, and unbounded shapes", () => {
  for (const context of INVALID_CONTEXTS) {
    assert.throws(
      () => sampleClient({ context }),
      (thrown) => thrown instanceof SdkError && thrown.code === "validation_error"
    );
  }
});
