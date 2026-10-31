import test from "node:test";
import assert from "node:assert/strict";

import {
  LogBrewClient,
  RecordingTransport,
  SdkError,
} from "../index.js";

const SUPPORTED_EVENT_TYPES = ["release", "environment", "issue", "log", "span", "action"];
const LOGGER_TRACE = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "b7ad6b7169203331",
  parentSpanId: "00f067aa0ba902b7",
  sampled: true
};

function assertEventTypes(payload) {
  assert.deepEqual(payload.events.map((event) => event.type), SUPPORTED_EVENT_TYPES);
}

function sampleClient(overrides = {}) {
  return LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-js",
    sdkVersion: "0.1.0",
    maxRetries: 2,
    ...overrides
  });
}

test("shared telemetry context survives every event boundary and isolates caller mutation", () => {
  const clientContext = {
    schemaVersion: 1,
    resource: {
      service: { name: "checkout-api", version: "2.4.0" },
      deployment: { environment: "production", release: "checkout@2.4.0" },
      runtime: { name: "node", version: "22" },
      framework: { name: "fastify", version: "5" }
    },
    subject: { id: "subject_01", kind: "user" },
    tags: { plan: "team", region: "eu" }
  };
  const eventContext = {
    schemaVersion: 1,
    trace: {
      traceId: LOGGER_TRACE.traceId,
      spanId: LOGGER_TRACE.spanId,
      sampled: true
    },
    session: { id: "session_01", previousId: "session_00" },
    tags: { route: "checkout.submit" }
  };
  const client = sampleClient({
    context: clientContext,
    eventFilter(event) {
      event.attributes.context.resource.service.name = "filter-mutated";
      event.attributes.context.tags.plan = "filter-mutated";
      return true;
    }
  });

  client.log("evt_context_log", "2026-08-01T10:00:00Z", {
    message: "checkout started",
    level: "info",
    context: eventContext
  });
  client.action("evt_context_action", "2026-08-01T10:00:01Z", {
    name: "checkout.submit",
    status: "success",
    context: eventContext
  });

  clientContext.resource.service.name = "caller-mutated";
  clientContext.tags.plan = "caller-mutated";
  eventContext.session.id = "caller-mutated";
  eventContext.tags.route = "caller-mutated";

  const [log, action] = JSON.parse(client.previewJson()).events;
  for (const event of [log, action]) {
    assert.deepEqual(event.attributes.context, {
      schemaVersion: 1,
      resource: {
        service: { name: "checkout-api", version: "2.4.0" },
        deployment: { environment: "production", release: "checkout@2.4.0" },
        runtime: { name: "node", version: "22" },
        framework: { name: "fastify", version: "5" }
      },
      trace: {
        traceId: LOGGER_TRACE.traceId,
        spanId: LOGGER_TRACE.spanId,
        sampled: true
      },
      session: { id: "session_01", previousId: "session_00" },
      subject: { id: "subject_01", kind: "user" },
      tags: { plan: "team", region: "eu", route: "checkout.submit" }
    });
  }
});

test("shared telemetry context rejects ambiguous, unsafe, and unbounded shapes", () => {
  const invalidContexts = [
    { schemaVersion: 2, tags: { plan: "team" } },
    { schemaVersion: 1, email: "person@example.test" },
    { schemaVersion: 1, resource: { device: {} } },
    {
      schemaVersion: 1,
      trace: { traceId: "00000000000000000000000000000000" }
    },
    {
      schemaVersion: 1,
      session: { id: "same", previousId: "same" }
    },
    {
      schemaVersion: 1,
      subject: { id: "person@example.test", kind: "identified" }
    },
    {
      schemaVersion: 1,
      tags: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`tag_${index}`, "value"]))
    },
    { schemaVersion: 1, tags: { "unsafe key": "value" } },
    { schemaVersion: 1, tags: { plan: "safe\u0085unsafe" } }
  ];

  for (const context of invalidContexts) {
    assert.throws(
      () => sampleClient({ context }),
      (error) => error instanceof SdkError && error.code === "validation_error"
    );
  }
});

function enqueueAll(client) {
  client.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456"
  });
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  client.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
  client.action("evt_action_001", "2026-06-02T10:00:05Z", {
    name: "deploy",
    status: "success"
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function replaceMethod(t, owner, name, replacement) {
  const original = owner[name];
  t.after(() => { owner[name] = original; });
  owner[name] = replacement;
}

function fakeDeliveryTimers(t) {
  const timers = [];
  replaceMethod(t, globalThis, "setTimeout", (callback, delay) => {
    const timer = {
      callback,
      cleared: false,
      delay,
      unrefCalls: 0,
      unref() {
        this.unrefCalls += 1;
        return this;
      }
    };
    timers.push(timer);
    return timer;
  });
  replaceMethod(t, globalThis, "clearTimeout", (timer) => {
    if (timer) {
      timer.cleared = true;
    }
  });
  return timers;
}

async function waitForCondition(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(message);
}

function storedEvent(type, id, attributes = { message: "persisted", level: "info" }) {
  const event = { type, id, timestamp: "2026-06-02T10:00:00Z", attributes };
  const serializedEvent = JSON.stringify(event);
  return {
    event,
    eventBytes: Buffer.byteLength(serializedEvent, "utf8"),
    serializedEvent
  };
}

function recordingEventStore(initialRecords = []) {
  const store = mutableRecordingStore(initialRecords.map((record) => structuredClone(record)));
  return {
    ...store,
    load() {
      store.calls.push(["load"]);
      return store.records.map((record) => structuredClone(record));
    },
    purge() {
      store.calls.push(["purge"]);
      store.records.splice(0, store.records.length);
    }
  };
}

function recordingEventQueue(initialRecords = []) {
  const records = initialRecords.map(({ event, eventBytes, serializedEvent }) => ({
    event: structuredClone(event),
    byteCount: eventBytes,
    serialized: serializedEvent
  }));
  const store = mutableRecordingStore(records);
  return {
    ...store,
    length() {
      return store.records.length;
    },
    byteCount() {
      return store.records.reduce((total, record) => total + record.byteCount, 0);
    },
    events() {
      return store.records.map((record) => structuredClone(record.event));
    },
    serializedAt(index) {
      return store.records[index].serialized;
    },
    eventBytesAt(index) {
      return store.records[index].byteCount;
    }
  };
}

function mutableRecordingStore(records) {
  return {
    calls: [],
    records,
    append(record) {
      this.calls.push(["append", structuredClone(record)]);
      this.records.push(structuredClone(record));
    },
    acknowledge(count) {
      this.calls.push(["acknowledge", count]);
      this.records.splice(0, count);
    },
    close() {
      this.calls.push(["close"]);
    }
  };
}

test("previewJson contains all supported event types", () => {
  const client = sampleClient();
  enqueueAll(client);
  const payload = JSON.parse(client.previewJson());
  assertEventTypes(payload);
});

test("flush success clears the queue", async () => {
  const client = sampleClient();
  enqueueAll(client);
  const transport = RecordingTransport.alwaysAccept();

  const response = await client.flush(transport);

  assert.equal(response.statusCode, 202);
  assert.equal(response.attempts, 1);
  assert.equal(client.pendingEvents(), 0);
  assert.match(transport.lastBody(), /"events"/);
});

test("automatic delivery validates its owner and supports explicit manual opt-out", async (t) => {
  const timers = fakeDeliveryTimers(t);
  assert.throws(
    () => sampleClient({ automaticDelivery: true }),
    /automaticDelivery requires transport/
  );
  assert.throws(
    () => sampleClient({ deliveryIntervalMs: 60001 }),
    /deliveryIntervalMs must be at most 60000/
  );
  assert.throws(
    () => sampleClient({
      deliveryQueueThreshold: 2,
      maxQueueSize: 1
    }),
    /deliveryQueueThreshold must not exceed maxQueueSize/
  );

  const transport = RecordingTransport.alwaysAccept();
  const client = sampleClient({
    automaticDelivery: false,
    transport
  });
  client.log("evt_manual_001", "2026-06-02T10:00:00Z", {
    level: "info",
    message: "manual mode"
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  assert.equal(timers.length, 0);
  assert.equal(transport.sentBodies.length, 0);
  assert.equal(client.deliveryHealth().automaticDelivery, false);
  await client.flush();
  assert.equal(transport.sentBodies.length, 1);
});

test("automatic delivery arms one unref timer and flushes on its interval", async (t) => {
  const timers = fakeDeliveryTimers(t);
  const transport = RecordingTransport.alwaysAccept();
  const client = sampleClient({
    deliveryIntervalMs: 2500,
    deliveryQueueThreshold: 10,
    transport
  });
  client.log("evt_interval_001", "2026-06-02T10:00:00Z", {
    level: "info",
    message: "interval delivery"
  });

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 2500);
  assert.equal(timers[0].unrefCalls, 1);
  assert.deepEqual(client.deliveryHealth(), {
    schemaVersion: 1,
    automaticDelivery: true,
    lifecycle: "active",
    deliveryState: "scheduled",
    storage: "memory",
    queueEvents: 1,
    queueBytes: client.pendingBytes(),
    hydratedEvents: 0,
    hydratedBytes: 0,
    droppedEvents: 0,
    droppedByReason: {
      event_too_large: 0,
      evicted_for_fatal: 0,
      queue_bytes_overflow: 0,
      queue_overflow: 0
    },
    lastDropReason: "none",
    scheduled: true,
    inFlight: false,
    coalesced: false,
    pendingOperations: 0,
    lastOutcome: "idle",
    lastStatusClass: "none",
    pausedReason: "none",
    consecutiveFailures: 0,
    retryDelayMs: 0,
    flushes: 0,
    failures: 0,
    attempts: 0,
    batches: 0,
    acceptedEvents: 0,
    lastAttemptAtUnixMs: 0,
    lastAcceptedAtUnixMs: 0,
    lastDroppedAtUnixMs: 0
  });

  timers[0].callback();
  await waitForCondition(() => transport.sentBodies.length === 1, "interval delivery did not send");
  await waitForCondition(() => client.pendingEvents() === 0, "interval delivery did not acknowledge");
  const acceptedHealth = client.deliveryHealth();
  assert.deepEqual(acceptedHealth, {
    schemaVersion: 1,
    automaticDelivery: true,
    lifecycle: "active",
    deliveryState: "accepted",
    storage: "memory",
    queueEvents: 0,
    queueBytes: 0,
    hydratedEvents: 0,
    hydratedBytes: 0,
    droppedEvents: 0,
    droppedByReason: {
      event_too_large: 0,
      evicted_for_fatal: 0,
      queue_bytes_overflow: 0,
      queue_overflow: 0
    },
    lastDropReason: "none",
    scheduled: false,
    inFlight: false,
    coalesced: false,
    pendingOperations: 0,
    lastOutcome: "accepted",
    lastStatusClass: "success",
    pausedReason: "none",
    consecutiveFailures: 0,
    retryDelayMs: 0,
    flushes: 1,
    failures: 0,
    attempts: 1,
    batches: 1,
    acceptedEvents: 1,
    lastAttemptAtUnixMs: acceptedHealth.lastAttemptAtUnixMs,
    lastAcceptedAtUnixMs: acceptedHealth.lastAcceptedAtUnixMs,
    lastDroppedAtUnixMs: 0
  });
  assert.equal(acceptedHealth.lastAttemptAtUnixMs > 0, true);
  assert.equal(acceptedHealth.lastAcceptedAtUnixMs >= acceptedHealth.lastAttemptAtUnixMs, true);
});

test("delivery health snapshot reports exact retry acceptance with stable private JSON", async () => {
  const bodies = [];
  const client = sampleClient({
    apiKey: "private-key-value",
    automaticDelivery: false,
    maxRetries: 1,
    sdkName: "private-sdk-name",
    transport: {
      async send(_apiKey, body) {
        bodies.push(body);
        return { statusCode: bodies.length === 1 ? 503 : 202 };
      }
    }
  });
  client.log("private-event-id", "2026-06-02T10:00:00Z", {
    level: "error",
    message: "private payload text"
  });

  await client.flush();

  const health = client.deliveryHealth();
  assert.equal(health.schemaVersion, 1);
  assert.equal(health.deliveryState, "accepted");
  assert.equal(health.storage, "memory");
  assert.equal(health.acceptedEvents, 1);
  assert.equal(health.lastStatusClass, "success");
  assert.equal(health.attempts, 2);
  assert.equal(health.batches, 1);
  assert.equal(health.lastAttemptAtUnixMs > 0, true);
  assert.equal(health.lastAcceptedAtUnixMs >= health.lastAttemptAtUnixMs, true);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(Object.isFrozen(health), true);
  assert.equal(Object.isFrozen(health.droppedByReason), true);
  assert.deepEqual(JSON.parse(JSON.stringify(health)), health);
  const serialized = JSON.stringify(health);
  for (const forbidden of ["private-key-value", "private-sdk-name", "private-event-id", "private payload text"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(Object.hasOwn(health, "statusCode"), false);
});

test("delivery health snapshot reports bounded queue drops by stable reason", () => {
  const client = sampleClient({ maxQueueSize: 1 });
  client.log("evt_kept_001", "2026-06-02T10:00:00Z", { level: "info", message: "kept" });
  client.log("evt_dropped_001", "2026-06-02T10:00:01Z", { level: "info", message: "dropped" });

  const health = client.deliveryHealth();
  assert.equal(health.droppedEvents, 1);
  assert.equal(health.lastDropReason, "queue_overflow");
  assert.deepEqual(health.droppedByReason, {
    event_too_large: 0,
    evicted_for_fatal: 0,
    queue_bytes_overflow: 0,
    queue_overflow: 1
  });
  assert.equal(health.lastDroppedAtUnixMs > 0, true);
});

test("delivery health timestamps do not move backward when the wall clock regresses", async (t) => {
  let now = 2000;
  replaceMethod(t, Date, "now", () => now);
  const client = sampleClient({
    automaticDelivery: false,
    maxQueueSize: 1,
    transport: RecordingTransport.alwaysAccept()
  });
  client.log("evt_kept_clock", "2026-06-02T10:00:00Z", { level: "info", message: "kept" });
  client.log("evt_drop_clock_1", "2026-06-02T10:00:01Z", { level: "info", message: "drop" });
  assert.equal(client.deliveryHealth().lastDroppedAtUnixMs, 2000);

  now = 1000;
  client.log("evt_drop_clock_2", "2026-06-02T10:00:02Z", { level: "info", message: "drop again" });
  assert.equal(client.deliveryHealth().lastDroppedAtUnixMs, 2000);

  now = 3000;
  await client.flush();
  const accepted = client.deliveryHealth();
  assert.equal(accepted.lastAttemptAtUnixMs, 3000);
  assert.equal(accepted.lastAcceptedAtUnixMs, 3000);
});

test("delivery health snapshot reports persisted restart hydration without content", () => {
  const store = recordingEventStore([storedEvent("log", "private-recovered-event")]);
  const client = sampleClient({
    apiKey: "private-key-value",
    eventStore: store,
    sdkName: "private-sdk-name"
  });

  const health = client.deliveryHealth();
  assert.equal(health.storage, "persistent");
  assert.equal(health.hydratedEvents, 1);
  assert.equal(health.hydratedBytes, store.records[0].eventBytes);
  assert.equal(health.queueEvents, 1);
  assert.equal(health.deliveryState, "queued");
  const serialized = JSON.stringify(health);
  for (const forbidden of ["private-key-value", "private-sdk-name", "private-recovered-event"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("delivery health snapshot stays coherent across overlapping flush and shutdown", async () => {
  const sendStarted = deferred();
  const sendResponse = deferred();
  const client = sampleClient({
    automaticDelivery: false,
    transport: {
      async send() {
        sendStarted.resolve();
        return sendResponse.promise;
      }
    }
  });
  client.log("evt_overlap_001", "2026-06-02T10:00:00Z", { level: "info", message: "overlap" });

  const flush = client.flush();
  await sendStarted.promise;
  const shutdown = client.shutdown();
  const overlapping = client.deliveryHealth();
  assert.equal(overlapping.lifecycle, "shutting_down");
  assert.equal(overlapping.deliveryState, "in_flight");
  assert.equal(overlapping.inFlight, true);
  assert.equal(overlapping.pendingOperations, 2);

  sendResponse.resolve({ statusCode: 202 });
  await flush;
  await shutdown;
  const closed = client.deliveryHealth();
  assert.equal(closed.lifecycle, "closed");
  assert.equal(closed.pendingOperations, 0);
  assert.equal(closed.inFlight, false);
  assert.equal(closed.acceptedEvents, 1);
});

test("delivery health snapshot classifies malformed transport responses without leaking them", async () => {
  const client = sampleClient({
    automaticDelivery: false,
    maxRetries: 0,
    transport: {
      async send() {
        return { statusCode: "private-malformed-status", responseBody: "private-response-body" };
      }
    }
  });
  client.log("evt_malformed_001", "2026-06-02T10:00:00Z", { level: "error", message: "private event body" });

  await assert.rejects(client.flush(), /invalid transport response/);

  const health = client.deliveryHealth();
  assert.equal(health.lastOutcome, "failed");
  assert.equal(health.lastStatusClass, "invalid_response");
  assert.equal(health.deliveryState, "queued");
  const serialized = JSON.stringify(health);
  for (const forbidden of ["private-malformed-status", "private-response-body", "private event body", "evt_malformed_001"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("automatic threshold coalesces capture during I/O into one trailing cohort", async (t) => {
  fakeDeliveryTimers(t);
  const firstSendStarted = deferred();
  const releaseFirstSend = deferred();
  const bodies = [];
  const transport = {
    async send(_apiKey, body) {
      bodies.push(body);
      if (bodies.length === 1) {
        firstSendStarted.resolve();
        await releaseFirstSend.promise;
      }
      return { statusCode: 202, attempts: 1 };
    }
  };
  const client = sampleClient({
    deliveryQueueThreshold: 1,
    transport
  });

  client.log("evt_cohort_001", "2026-06-02T10:00:00Z", { level: "info", message: "first" });
  await firstSendStarted.promise;
  client.log("evt_cohort_002", "2026-06-02T10:00:01Z", { level: "info", message: "second" });
  client.log("evt_cohort_003", "2026-06-02T10:00:02Z", { level: "info", message: "third" });
  assert.equal(client.deliveryHealth().inFlight, true);
  assert.equal(client.deliveryHealth().coalesced, true);
  assert.equal(bodies.length, 1);

  releaseFirstSend.resolve();
  await waitForCondition(() => bodies.length === 2, "coalesced cohort did not send");
  await waitForCondition(() => client.pendingEvents() === 0, "coalesced cohort did not drain");
  assert.deepEqual(JSON.parse(bodies[0]).events.map((event) => event.id), ["evt_cohort_001"]);
  assert.deepEqual(JSON.parse(bodies[1]).events.map((event) => event.id), ["evt_cohort_002", "evt_cohort_003"]);
  assert.equal(client.deliveryHealth().flushes, 2);
});

test("automatic transient failures back off without changing failed bytes or admitting a bypass", async (t) => {
  const timers = fakeDeliveryTimers(t);
  replaceMethod(t, Math, "random", () => 0);
  const bodies = [];
  const transport = {
    async send(_apiKey, body) {
      bodies.push(body);
      return { statusCode: bodies.length <= 2 ? 503 : 202, attempts: 1 };
    }
  };
  const client = sampleClient({
    apiKey: "private-key-value",
    deliveryIntervalMs: 2500,
    deliveryQueueThreshold: 1,
    maxRetries: 0,
    sdkName: "private-host-name",
    transport
  });
  client.log("private-event-id", "2026-06-02T10:00:00Z", {
    level: "error",
    message: "private payload text"
  });

  await waitForCondition(() => client.deliveryHealth().failures === 1, "automatic failure was not recorded");
  assert.equal(client.pendingEvents(), 1);
  assert.equal(client.deliveryHealth().lastOutcome, "failed");
  assert.equal(client.deliveryHealth().deliveryState, "retrying");
  assert.equal(client.deliveryHealth().lastStatusClass, "server_error");
  assert.equal(client.deliveryHealth().pausedReason, "none");
  assert.equal(client.deliveryHealth().consecutiveFailures, 1);
  assert.equal(client.deliveryHealth().retryDelayMs, 1250);
  const failureHealth = client.deliveryHealth();
  const serializedHealth = JSON.stringify(failureHealth);
  for (const forbidden of ["private-key-value", "private-host-name", "private-event-id", "private payload text"]) {
    assert.equal(serializedHealth.includes(forbidden), false);
  }
  assert.equal(Object.hasOwn(failureHealth, "statusCode"), false);

  const retryTimer = timers.findLast((timer) => !timer.cleared);
  assert.ok(retryTimer);
  assert.equal(retryTimer.delay, 1250);
  client.log("evt_later_work", "2026-06-02T10:00:01Z", {
    level: "info",
    message: "captured during backoff"
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(bodies.length, 1);
  assert.equal(timers.findLast((timer) => !timer.cleared), retryTimer);

  retryTimer.callback();
  await waitForCondition(() => client.deliveryHealth().failures === 2, "second automatic failure was not recorded");
  assert.equal(bodies[0], bodies[1]);
  assert.equal(client.deliveryHealth().consecutiveFailures, 2);
  assert.equal(client.deliveryHealth().retryDelayMs, 2500);
  const secondRetryTimer = timers.findLast((timer) => !timer.cleared);
  assert.equal(secondRetryTimer.delay, 2500);

  secondRetryTimer.callback();
  await waitForCondition(() => bodies.length === 4, "automatic retry and retained later work did not send");
  await waitForCondition(() => client.pendingEvents() === 0, "automatic retry did not acknowledge");
  assert.equal(bodies[0], bodies[2]);
  assert.deepEqual(JSON.parse(bodies[3]).events.map((event) => event.id), ["evt_later_work"]);
  assert.equal(client.deliveryHealth().lastOutcome, "accepted");
  assert.equal(client.deliveryHealth().pausedReason, "none");
  assert.equal(client.deliveryHealth().consecutiveFailures, 0);
  assert.equal(client.deliveryHealth().retryDelayMs, 0);
  assert.equal(client.deliveryHealth().failures, 2);
  assert.equal(client.deliveryHealth().flushes, 1);
});

test("automatic authentication failure pauses retained work without a retry loop", async (t) => {
  const timers = fakeDeliveryTimers(t);
  const transport = new RecordingTransport([{ statusCode: 401 }]);
  const client = sampleClient({
    apiKey: "private-key-value",
    deliveryQueueThreshold: 1,
    sdkName: "private-host-name",
    transport
  });

  client.log("private-event-id", "2026-06-02T10:00:00Z", {
    level: "error",
    message: "private payload text"
  });
  await waitForCondition(() => client.deliveryHealth().failures === 1, "authentication failure was not recorded");

  assert.equal(transport.sentBodies.length, 1);
  assert.equal(client.pendingEvents(), 1);
  assert.equal(client.deliveryHealth().pausedReason, "authentication");
  assert.equal(client.deliveryHealth().deliveryState, "paused");
  assert.equal(client.deliveryHealth().lastStatusClass, "client_error");
  assert.equal(client.deliveryHealth().consecutiveFailures, 1);
  assert.equal(client.deliveryHealth().retryDelayMs, 0);
  assert.equal(client.deliveryHealth().scheduled, false);
  client.log("private-later-id", "2026-06-02T10:00:01Z", {
    level: "info",
    message: "private later text"
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(transport.sentBodies.length, 1);
  assert.equal(timers.some((timer) => !timer.cleared), false);
  const authenticationHealth = client.deliveryHealth();
  const healthJson = JSON.stringify(authenticationHealth);
  for (const forbidden of ["private-key-value", "private-host-name", "private-event-id", "private payload text"]) {
    assert.equal(healthJson.includes(forbidden), false);
  }
  assert.equal(Object.hasOwn(authenticationHealth, "statusCode"), false);
});

test("automatic usage_limit_exceeded pauses until an explicit successful flush, even with Retry-After", async (t) => {
  const timers = fakeDeliveryTimers(t);
  const transport = new RecordingTransport([
    { statusCode: 429, retryAfterMs: 120_000, errorCode: "usage_limit_exceeded" },
    { statusCode: 202 }
  ]);
  const client = sampleClient({
    deliveryQueueThreshold: 1,
    transport
  });

  client.log("evt_rate_limit_auto", "2026-06-02T10:00:00Z", {
    level: "warning",
    message: "bounded"
  });
  await waitForCondition(() => client.deliveryHealth().failures === 1, "rate limit was not recorded");

  assert.equal(client.deliveryHealth().pausedReason, "rate_limit");
  assert.equal(client.deliveryHealth().retryDelayMs, 0);
  assert.equal(client.deliveryHealth().scheduled, false);
  assert.equal(transport.sentBodies.length, 1);
  assert.equal(timers.some((timer) => !timer.cleared), false);

  const response = await client.flush();
  assert.equal(response.statusCode, 202);
  assert.equal(transport.sentBodies[0], transport.sentBodies[1]);
  assert.equal(client.pendingEvents(), 0);
  assert.equal(client.deliveryHealth().pausedReason, "none");
  assert.equal(client.deliveryHealth().consecutiveFailures, 0);
  assert.equal(client.deliveryHealth().retryDelayMs, 0);
});

test("automatic 429 without Retry-After or a code pauses like before", async (t) => {
  fakeDeliveryTimers(t);
  const transport = new RecordingTransport([{ statusCode: 429 }]);
  const client = sampleClient({ deliveryQueueThreshold: 1, transport });

  client.log("evt_plain_429", "2026-06-02T10:00:00Z", { level: "info", message: "bounded" });
  await waitForCondition(() => client.deliveryHealth().failures === 1, "rate limit was not recorded");

  assert.equal(client.deliveryHealth().pausedReason, "rate_limit");
  assert.equal(client.deliveryHealth().scheduled, false);
});

for (const [scripted, random, expectedDelay] of [
  [{ statusCode: 429, retryAfterMs: 30_000 }, 0, 30_000],
  [{ statusCode: 429, retryAfterMs: 30_000 }, 0.999999, 33_000],
  [{ statusCode: 429, retryAfterMs: 0 }, 0, 1000],
  [{ statusCode: 429, retryAfterMs: 86_400_000 }, 0.999999, 3_600_000],
  [{ statusCode: 429, errorCode: "rate_limited" }, 0, 1000]
]) {
  test(`automatic 429 ${JSON.stringify(scripted)} waits ${expectedDelay} ms, then resends the same batch`, async (st) => {
    const timers = fakeDeliveryTimers(st);
    replaceMethod(st, Math, "random", () => random);
    const transport = new RecordingTransport([scripted, { statusCode: 202 }]);
    const client = sampleClient({ deliveryQueueThreshold: 1, transport });

    client.log("evt_rate_limited", "2026-06-02T10:00:00Z", { level: "info", message: "bounded" });
    await waitForCondition(() => client.deliveryHealth().failures === 1, "rate limit was not recorded");

    assert.equal(client.deliveryHealth().pausedReason, "none");
    assert.equal(client.deliveryHealth().deliveryState, "retrying");
    assert.equal(client.deliveryHealth().retryDelayMs, expectedDelay);
    const retryTimer = timers.findLast((timer) => !timer.cleared);
    assert.equal(retryTimer.delay, expectedDelay);
    client.log("evt_during_wait", "2026-06-02T10:00:01Z", { level: "info", message: "queued" });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(transport.sentBodies.length, 1);

    retryTimer.callback();
    await waitForCondition(() => client.pendingEvents() === 0, "rate-limited batch did not resend");
    assert.equal(transport.sentBodies[0], transport.sentBodies[1]);
    assert.equal(client.deliveryHealth().consecutiveFailures, 0);
  });
}

test("manual flush clears backoff armed while it waited behind automatic delivery", async (t) => {
  const timers = fakeDeliveryTimers(t);
  const automaticSendStarted = deferred();
  const releaseAutomaticSend = deferred();
  const bodies = [];
  const transport = {
    async send(_apiKey, body) {
      bodies.push(body);
      if (bodies.length === 1) {
        automaticSendStarted.resolve();
        await releaseAutomaticSend.promise;
        return { statusCode: 503, attempts: 1 };
      }
      return { statusCode: 202, attempts: 1 };
    }
  };
  const client = sampleClient({
    deliveryQueueThreshold: 1,
    maxRetries: 0,
    transport
  });

  client.log("evt_manual_after_auto", "2026-06-02T10:00:00Z", {
    level: "info",
    message: "queued"
  });
  await automaticSendStarted.promise;
  const manualFlush = client.flush();
  releaseAutomaticSend.resolve();
  await manualFlush;

  assert.equal(bodies[0], bodies[1]);
  assert.equal(client.pendingEvents(), 0);
  assert.equal(client.deliveryHealth().scheduled, false);
  assert.equal(timers.some((timer) => !timer.cleared), false);
});

test("custom manual flush failure restores the owned automatic scheduler", async (t) => {
  const timers = fakeDeliveryTimers(t);
  const ownedTransport = RecordingTransport.alwaysAccept();
  const client = sampleClient({
    deliveryIntervalMs: 2500,
    deliveryQueueThreshold: 10,
    maxRetries: 0,
    transport: ownedTransport
  });
  client.log("evt_custom_flush_failure", "2026-06-02T10:00:00Z", {
    level: "info",
    message: "queued"
  });
  const initialTimer = timers.findLast((timer) => !timer.cleared);

  await assert.rejects(
    client.flush(new RecordingTransport([{ statusCode: 400 }])),
    /unexpected transport status 400/
  );

  assert.equal(initialTimer.cleared, true);
  assert.equal(client.pendingEvents(), 1);
  assert.equal(client.deliveryHealth().pausedReason, "none");
  assert.equal(client.deliveryHealth().scheduled, true);
  assert.equal(timers.findLast((timer) => !timer.cleared).delay, 2500);
  assert.equal(ownedTransport.sentBodies.length, 0);
});

test("automatic delivery schedules recovered work and shutdown cancels stale callbacks", async (t) => {
  const timers = fakeDeliveryTimers(t);
  const store = recordingEventStore([storedEvent("log", "evt_recovered_auto_001")]);
  const transport = RecordingTransport.alwaysAccept();
  const client = sampleClient({
    deliveryIntervalMs: 2500,
    eventStore: store,
    transport
  });
  assert.equal(timers.length, 1);
  const staleCallback = timers[0].callback;

  const response = await client.shutdown();
  assert.equal(response.statusCode, 202);
  assert.equal(timers[0].cleared, true);
  assert.equal(client.deliveryHealth().lifecycle, "closed");
  assert.equal(transport.sentBodies.length, 1);
  assert.throws(
    () => client.log("evt_after_shutdown", "2026-06-02T10:00:01Z", { level: "info", message: "ignored" }),
    /already shut down/
  );

  staleCallback();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(transport.sentBodies.length, 1);
  assert.equal(client.deliveryHealth().lifecycle, "closed");
});

test("shutdown serializes behind active automatic delivery and permits no later mutation", async (t) => {
  fakeDeliveryTimers(t);
  const sendStarted = deferred();
  const sendResponse = deferred();
  const bodies = [];
  const transport = {
    async send(_apiKey, body) {
      bodies.push(body);
      sendStarted.resolve();
      await sendResponse.promise;
      return { statusCode: 202, attempts: 1 };
    }
  };
  const client = sampleClient({
    deliveryQueueThreshold: 1,
    transport
  });
  client.log("evt_shutdown_race_001", "2026-06-02T10:00:00Z", {
    level: "info",
    message: "before shutdown"
  });
  await sendStarted.promise;

  const shutdown = client.shutdown();
  assert.equal(client.deliveryHealth().lifecycle, "shutting_down");
  assert.throws(
    () => client.log("evt_shutdown_race_002", "2026-06-02T10:00:01Z", { level: "info", message: "late" }),
    /client is shutting down/
  );
  sendResponse.resolve();
  const response = await shutdown;

  assert.equal(response.statusCode, 204);
  assert.equal(bodies.length, 1);
  assert.equal(client.pendingEvents(), 0);
  assert.equal(client.deliveryHealth().lifecycle, "closed");
  assert.equal(client.deliveryHealth().scheduled, false);
  assert.equal(client.deliveryHealth().coalesced, false);
});

test("immediate shutdown supersedes an automatic threshold task before it starts", async (t) => {
  fakeDeliveryTimers(t);
  const transport = RecordingTransport.alwaysAccept();
  const client = sampleClient({
    deliveryQueueThreshold: 1,
    transport
  });
  client.log("evt_shutdown_before_auto_001", "2026-06-02T10:00:00Z", {
    level: "info",
    message: "shutdown wins"
  });

  await client.shutdown();
  const healthAtShutdown = client.deliveryHealth();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  assert.equal(transport.sentBodies.length, 1);
  assert.equal(healthAtShutdown.flushes, 1);
  assert.deepEqual(client.deliveryHealth(), healthAtShutdown);
});

test("purge rejects an automatic threshold cohort before its microtask starts", async (t) => {
  fakeDeliveryTimers(t);
  const transport = RecordingTransport.alwaysAccept();
  const client = sampleClient({
    deliveryQueueThreshold: 1,
    transport
  });
  client.log("evt_purge_race_001", "2026-06-02T10:00:00Z", {
    level: "info",
    message: "automatic cohort"
  });

  assert.throws(() => client.purgePendingEvents(), /delivery operation is active/);
  await waitForCondition(() => client.pendingEvents() === 0, "automatic cohort did not finish");
  assert.equal(transport.sentBodies.length, 1);
});

test("event store recovers native and legacy-context records", async () => {
  const nativeFrame = { imageUuid: "01234567-89ab-cdef-0123-456789abcdef", architecture: "arm64", instructionOffset: "0000000000001234" };
  const store = recordingEventStore([
    storedEvent("issue", "evt_native_001", { title: "Native crash", level: "critical", nativeStackFrames: [nativeFrame] }),
    storedEvent("issue", "evt_legacy_001", {
      title: "Legacy crash", level: "fatal",
      context: { resource: { service: { name: "mobile-app" } } }, nativeStackFrames: [nativeFrame]
    })
  ]);
  const transport = RecordingTransport.alwaysAccept();
  const client = sampleClient({ automaticDelivery: false, eventStore: store, transport });
  const recovered = JSON.parse(client.previewJson()).events;

  assert.deepEqual(recovered[0].attributes.nativeStackFrames, [nativeFrame]);
  assert.deepEqual([recovered[1].attributes.level, recovered[1].attributes.context.schemaVersion], ["critical", 1]);
  await client.flush();
  assert.equal(JSON.parse(transport.lastBody()).events[1].attributes.context.schemaVersion, 1);
});

test("event queue factory composes restart recovery, health, flush, purge, and shutdown", async () => {
  const queue = recordingEventQueue([storedEvent("log", "evt_factory_recovered_001")]);
  let factoryConfig;
  const client = sampleClient({
    automaticDelivery: false,
    transport: RecordingTransport.alwaysAccept(),
    [Symbol.for("@logbrew/sdk.eventQueueFactory")](config) {
      factoryConfig = config;
      return queue;
    }
  });

  assert.equal(typeof factoryConfig.restoreEvent, "function");
  assert.equal(client.pendingEvents(), 1);
  assert.equal(client.deliveryHealth().storage, "persistent");
  assert.equal(client.deliveryHealth().hydratedEvents, 1);
  assert.equal(client.deliveryHealth().hydratedBytes, queue.records[0].byteCount);

  await client.flush();
  client.log("evt_factory_purge_001", "2026-06-02T10:00:00Z", { level: "info", message: "purge" });
  assert.equal(client.purgePendingEvents(), 1);
  client.log("evt_factory_shutdown_001", "2026-06-02T10:00:00Z", { level: "info", message: "shutdown" });
  await client.shutdown();

  assert.deepEqual(queue.calls.map(([operation]) => operation), [
    "acknowledge",
    "append",
    "acknowledge",
    "append",
    "acknowledge",
    "close"
  ]);
  assert.equal(client.deliveryHealth().lifecycle, "closed");
});

test("eventStore and event queue factory fail closed when both are supplied", () => {
  assert.throws(
    () => sampleClient({
      eventStore: recordingEventStore(),
      [Symbol.for("@logbrew/sdk.eventQueueFactory")]() {
        return recordingEventQueue();
      }
    }),
    /eventStore and event queue factory are mutually exclusive/
  );
});

test("event store persists a validated event before volatile admission", () => {
  const store = recordingEventStore();
  const client = sampleClient({ eventStore: store });

  client.log("evt_persisted_001", "2026-06-02T10:00:00Z", { message: "persist first", level: "info" });

  assert.equal(client.pendingEvents(), 1);
  assert.equal(store.records.length, 1);
  assert.deepEqual(store.calls.map(([name]) => name), ["load", "append"]);
  assert.equal(store.calls[1][1].serializedEvent, JSON.stringify(store.calls[1][1].event));
});

test("event store append failure leaves the volatile queue empty", () => {
  const store = recordingEventStore();
  store.append = () => {
    throw new SdkError("persistence_error", "persistent event admission failed");
  };
  const client = sampleClient({ eventStore: store });

  assert.throws(
    () => client.log("evt_persisted_001", "2026-06-02T10:00:00Z", { message: "persist first", level: "info" }),
    new SdkError("persistence_error", "persistent event admission failed")
  );
  assert.equal(client.pendingEvents(), 0);
});

test("event store acknowledges an accepted prefix before volatile removal", async () => {
  const store = recordingEventStore();
  const client = sampleClient({ eventStore: store, maxBatchEvents: 1 });
  store.records.push(storedEvent("issue", "evt_native_hang_001", {
    title: "Native application hang", level: "error"
  }));
  client.log("evt_after_hang_001", "2026-06-02T10:00:01Z", {
    level: "info", message: "main thread recovered"
  });
  const transport = RecordingTransport.alwaysAccept();

  await client.flush(transport);

  assert.deepEqual(transport.sentBodies.map((body) => JSON.parse(body).events[0].id), [
    "evt_native_hang_001", "evt_after_hang_001"
  ]);
  assert.deepEqual(store.calls.map(([name]) => name), ["load", "append", "load", "acknowledge", "acknowledge"]);
  assert.equal(store.records.length, 0);
  assert.equal(client.pendingEvents(), 0);
});

test("event store acknowledgement failure retains the accepted prefix for replay", async () => {
  const store = recordingEventStore([storedEvent("log", "evt_ack_failure_001")]);
  store.acknowledge = () => {
    throw new SdkError("persistence_error", "persistent acknowledgement failed");
  };
  const client = sampleClient({ eventStore: store });

  await assert.rejects(
    client.flush(RecordingTransport.alwaysAccept()),
    new SdkError("persistence_error", "persistent acknowledgement failed")
  );
  assert.equal(client.pendingEvents(), 1);
  assert.equal(store.records.length, 1);
});

test("explicit purge clears memory and persistence but rejects an active flush", async () => {
  const store = recordingEventStore();
  const client = sampleClient({ eventStore: store });
  client.log("evt_purge_001", "2026-06-02T10:00:00Z", { message: "purge", level: "info" });
  const sendStarted = deferred();
  const sendResponse = deferred();
  const flushPromise = client.flush({
    async send() {
      sendStarted.resolve();
      return sendResponse.promise;
    }
  });
  await sendStarted.promise;

  assert.throws(() => client.purgePendingEvents(), /cannot purge while a delivery operation is active/);
  sendResponse.resolve({ statusCode: 500 });
  await assert.rejects(flushPromise, /unexpected transport status 500/);

  assert.equal(client.purgePendingEvents(), 1);
  assert.equal(client.pendingEvents(), 0);
  assert.equal(client.pendingBytes(), 0);
  assert.deepEqual(store.calls.map(([name]) => name), ["load", "append", "load", "purge"]);
});

test("successful shutdown closes the event store while failure leaves it retryable", async () => {
  const store = recordingEventStore();
  const client = sampleClient({
    eventStore: store,
    maxRetries: 0
  });
  client.log("evt_shutdown_store_001", "2026-06-02T10:00:00Z", { message: "retry", level: "info" });

  await assert.rejects(client.shutdown(new RecordingTransport([{ statusCode: 503 }])), /unexpected transport status 503/);
  assert.equal(store.calls.some(([name]) => name === "close"), false);
  await client.shutdown(RecordingTransport.alwaysAccept());
  assert.deepEqual(store.calls.map(([name]) => name), ["load", "append", "load", "load", "acknowledge", "close"]);
});

test("event store close failure leaves the client terminal instead of reopening without ownership", async () => {
  const store = recordingEventStore();
  store.close = () => {
    throw new SdkError("persistence_commit_error", "persistent owner release could not be confirmed");
  };
  const client = sampleClient({ eventStore: store });

  await assert.rejects(
    client.shutdown(RecordingTransport.alwaysAccept()),
    /persistent owner release could not be confirmed/
  );
  assert.throws(
    () => client.log("evt_after_close_failure", "2026-06-02T10:00:00Z", { message: "closed", level: "info" }),
    /client is already shut down/
  );
});

test("event store recovery fails closed for malformed or over-limit records", () => {
  const malformedStore = recordingEventStore([storedEvent("log", "evt_malformed_001", {
    message: "persisted", level: "info", context: { resource: {} }, unsupported: "drop-me"
  })]);
  assert.throws(
    () => sampleClient({ eventStore: malformedStore }),
    /event store returned an invalid record/
  );

  const overLimitStore = recordingEventStore([storedEvent("log", "evt_limit_001"), storedEvent("log", "evt_limit_002")]);
  assert.throws(
    () => sampleClient({
      eventStore: overLimitStore,
      maxQueueSize: 1
    }),
    /recovered event count exceeds maxQueueSize/
  );
});
