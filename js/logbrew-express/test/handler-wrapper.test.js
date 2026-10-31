import {
  ANY_PORT,
  HOST,
  assertExcludes,
  assertSameMembers,
  eventType,
  eventsOfBodies,
  eventsOfType,
  expectedTraceIds,
  readPath,
  serve,
  traceField,
  transportResponse,
  waitFor
} from "./support.js";
import { SPAN_ID, createTailApp, createTailView, sendTailRequest } from "./tail-app.js";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { TestContext } from "node:test"
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import { Scenario, TailView } from "./tail-app.js"
 */

const PRIVATE_MARKERS = Object.freeze(["private-id", "private-query", "private-authorization"]);
const NONE = 0;
const ONE = 1;
const TWO = 2;
const TAIL_EVENTS = 3;
const SLOW_PENDING_EVENTS = 3;
const LAST = -1;

/**
 * @param {readonly LogBrewClient[]} clients
 * @param {string} lifecycle
 * @returns {void}
 */
function assertLifecycles(clients, lifecycle) {
  for (const client of clients) {
    assert.equal(client.deliveryHealth().lifecycle, lifecycle);
  }
}

/**
 * @param {TailView} view
 * @returns {Promise<void>}
 */
async function assertBeforeRelease(view) {
  const { count, counters, delivery, records, scenario } = view;
  const manual = scenario.manual === true;
  /**
   * @returns {boolean}
   */
  function initialDone() {
    return scenario.slowInitial === true ? delivery.bodies.length === count : counters.flushes.value() === count;
  }
  await waitFor(() => records.clients.length === count && (manual || initialDone()), "handler delivery did not settle");
  assertLifecycles(records.clients, "active");
  assert.equal(counters.tails.value(), NONE);
  assert.equal(delivery.bodies.length, manual ? NONE : count);
}

/**
 * @param {TailView} view
 * @param {number} pending
 * @returns {Promise<void>}
 */
async function waitForTails(view, pending) {
  const { count, counters, records } = view;
  await waitFor(
    () => counters.tails.value() === count && records.clients.every((client) => client.pendingEvents() === pending),
    "handler tails did not finish"
  );
}

/**
 * @param {TailView} view
 * @param {LogBrewClient} client
 * @returns {boolean}
 */
function tailSettled(view, client) {
  if (view.scenario.failTail !== true) {
    return client.deliveryHealth().lifecycle === "closed";
  }
  return client.deliveryHealth().lifecycle === "active" && client.pendingEvents() === ONE && view.records.failures.length > NONE;
}

/**
 * @param {TailView} view
 * @returns {Promise<void>}
 */
async function settleSlowInitial(view) {
  await waitForTails(view, SLOW_PENDING_EVENTS);
  assert.equal(view.delivery.bodies.length, view.count);
  assertLifecycles(view.records.clients, "active");
  view.delivery.releaseInitial();
}

/**
 * @param {TailView} view
 * @returns {Promise<void>}
 */
async function settleManual(view) {
  await waitForTails(view, ONE);
  assert.equal(view.delivery.bodies.length, NONE);
  await Promise.all(view.records.shutdowns.map(async (shutdown) => shutdown()));
}

/**
 * @param {TailView} view
 * @returns {Promise<void>}
 */
async function releaseAndSettle(view) {
  const { records, scenario } = view;
  view.tail.open();
  if (scenario.slowInitial === true) {
    await settleSlowInitial(view);
  }
  await (scenario.manual === true && scenario.reject === false
    ? settleManual(view)
    : waitFor(() => records.clients.every((client) => tailSettled(view, client)), "handler delivery did not settle"));
}

/**
 * @param {TailView} view
 * @returns {void}
 */
function assertTailOutcome(view) {
  const { count, counters, records, scenario } = view;
  assert.equal(counters.factoryCalls.value(), scenario.customClient === true ? count : NONE);
  assert.equal(counters.tails.value(), count);
  assert.equal(records.errors.length, scenario.reject === false ? NONE : count);
  for (const error of records.errors) {
    assert.equal(error, view.original);
  }
  assert.equal(records.failures.length, scenario.failTail === true ? count : NONE);
}

/**
 * @param {readonly unknown[]} events
 * @param {TailView} view
 * @returns {void}
 */
function assertTailCounts(events, view) {
  const { count, scenario } = view;
  const manual = scenario.manual === true;
  assert.equal(events.length, (manual ? ONE : TAIL_EVENTS) * count);
  assert.equal(eventsOfType(events, "span").length, manual ? NONE : count);
  assert.equal(eventsOfType(events, "metric").length, manual ? NONE : count);
  assert.equal(eventsOfType(events, scenario.reject === false ? "log" : "issue").length, count);
}

/**
 * @param {unknown} event
 * @param {boolean} customClient
 * @returns {void}
 */
function assertTailContext(event, customClient) {
  assert.equal(traceField(event, "spanId"), SPAN_ID);
  assert.equal(traceField(event, "sampled"), false);
  if (customClient) {
    assert.equal(readPath(event, ["attributes", "context", "resource", "service", "name"]), "custom-request");
  }
}

/**
 * @param {readonly unknown[]} spans
 * @param {TailView} view
 * @returns {void}
 */
function assertTailSpans(spans, view) {
  assertSameMembers(spans.map((span) => readPath(span, ["attributes", "traceId"])), expectedTraceIds(view.count));
  for (const span of spans) {
    assert.equal(readPath(span, ["attributes", "name"]), "GET /tail/:id");
    assert.equal(readPath(span, ["attributes", "status"]), view.scenario.aborted === true ? "error" : "ok");
  }
}

/**
 * @param {TailView} view
 * @returns {void}
 */
function assertTailEvents(view) {
  const { delivery, scenario } = view;
  const events = eventsOfBodies(delivery.bodies);
  assertTailCounts(events, view);
  for (const event of events.filter((candidate) => eventType(candidate) !== "span")) {
    assertTailContext(event, scenario.customClient === true);
  }
  if (scenario.manual !== true) {
    assertTailSpans(eventsOfType(events, "span"), view);
  }
  for (const body of delivery.bodies) {
    assertExcludes(body, PRIVATE_MARKERS);
  }
}

/**
 * @param {TailView} view
 * @returns {Promise<void>}
 */
async function assertTailRecovery(view) {
  const [client] = view.records.clients;
  assert.ok(client !== undefined);
  if (view.scenario.failTail === true) {
    /** @type {string[]} */
    const replays = [];
    await client.shutdown({
      send: async (_key, body) => {
        replays.push(body);
        return transportResponse();
      }
    });
    assert.equal(replays.at(LAST), view.delivery.bodies.at(LAST));
  }
  assert.equal(view.api.getActiveLogBrewTrace(), undefined);
  assertLifecycles(view.records.clients, "closed");
}

/**
 * @param {TestContext} testContext
 * @param {Scenario} [scenario]
 * @returns {Promise<void>}
 */
async function checkTail(testContext, scenario = {}) {
  const view = createTailView(scenario);
  const app = createTailApp(view);
  testContext.after(() => {
    view.tail.open();
    view.delivery.releaseInitial();
  });
  const server = await serve(testContext, () => app.listen(ANY_PORT, HOST));
  await Promise.all(Array.from({ length: view.count }, async (_value, index) => sendTailRequest(server, index, scenario.aborted === true)));
  await assertBeforeRelease(view);
  await releaseAndSettle(view);
  assertTailOutcome(view);
  assertTailEvents(view);
  await assertTailRecovery(view);
}

/** @type {ReadonlyArray<readonly [string, Scenario]>} */
const SCENARIOS = [
  ["wrapped late rejection preserves the issue after response completion", {}],
  ["wrapped late log reaches delivery after response completion", { reject: false }],
  ["wrapped rejection after client abort preserves the issue", { aborted: true }],
  ["wrapped late log after client abort reaches delivery", { aborted: true, reject: false }],
  ["concurrent wrapped requests retain their custom clients and traces", { concurrency: TWO, customClient: true }],
  ["failed wrapped tail delivery retains the exact batch for recovery", { failTail: true }],
  ["disabled automatic capture preserves app-owned manual delivery", { manual: true, reject: false }],
  ["error capture still delivers when wrapped manual requests already completed", { manual: true }],
  ["CommonJS exposes the explicit handler wrapper", { commonjs: true }],
  ["a wrapped rejection during initial delivery preserves both batches", { slowInitial: true }]
];

for (const [name, scenario] of SCENARIOS) {
  void test(name, async (testContext) => {
    await checkTail(testContext, scenario);
  });
}
