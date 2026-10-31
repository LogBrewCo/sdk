import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";
import { captureVueError, createLogBrewVuePlugin } from "@logbrew/vue";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import commonjsAdapter from "./commonjs.cjs";
import { createApp } from "vue";
import test from "node:test";

/**
 * @import { App, ComponentPublicInstance } from "vue"
 * @import { LogBrewVueContext, LogBrewVueOptions } from "@logbrew/vue"
 * @typedef {{
 *   readonly captureVueError: typeof captureVueError,
 *   readonly createLogBrewVuePlugin: typeof createLogBrewVuePlugin,
 *   readonly format: string
 * }} Adapter
 * @typedef {(error: unknown, instance: ComponentPublicInstance | null, info: string) => unknown} Handler
 * @typedef {{ delegated: number, flushed: number }} Counts
 * @typedef {{
 *   readonly app: App,
 *   readonly client: LogBrewClient,
 *   readonly context: LogBrewVueContext,
 *   readonly transport: RecordingTransport
 * }} TestApp
 */

const timestamp = "2026-10-04T10:00:00.000Z";
const WAIT_MS = 1000;
const NO_DELAY = 0;
const NONE = 0;
const ONE = 1;
const TWO = 2;

/** @type {readonly Adapter[]} */
const adapters = [
  { captureVueError, createLogBrewVuePlugin, format: "esm" },
  {
    captureVueError: commonjsAdapter.captureVueError,
    createLogBrewVuePlugin: commonjsAdapter.createLogBrewVuePlugin,
    format: "cjs"
  }
];

/**
 * @param {unknown} value
 * @param {readonly string[]} path
 * @returns {unknown}
 */
function readPath(value, path) {
  /** @type {unknown} */
  let current = value;
  for (const key of path) {
    current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  }
  return current;
}

/**
 * @param {string} body
 * @returns {unknown[]}
 */
function eventsInBody(body) {
  /** @type {unknown} */
  const parsed = JSON.parse(body);
  const events = readPath(parsed, ["events"]);
  return Array.isArray(events) ? events : [];
}

/**
 * @param {RecordingTransport} transport
 * @returns {unknown[]}
 */
function sentEvents(transport) {
  return transport.sentBodies.flatMap((body) => eventsInBody(body));
}

/**
 * @returns {undefined}
 */
function replacementHandler() {
  return undefined;
}

/**
 * @returns {undefined}
 */
function previousHandler() {
  return undefined;
}

/**
 * @param {App} app
 * @returns {Handler}
 */
function installedHandler(app) {
  /** @type {Handler | undefined} */
  const handler = app.config.errorHandler;
  if (handler === undefined) {
    throw new Error("expected an installed Vue error handler");
  }
  return handler;
}

/**
 * @param {Adapter} adapter
 * @param {Handler | undefined} handler
 * @param {LogBrewVueOptions} [options]
 * @returns {TestApp}
 */
function makeApp(adapter, handler, options = {}) {
  const app = createApp({});
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_CLIENT_KEY",
    automaticDelivery: false,
    context: { schemaVersion: 1, session: { id: "sess_vue_001" } },
    sdkName: "vue-error-test",
    sdkVersion: "1.0.0"
  });
  const transport = RecordingTransport.alwaysAccept();
  const counter = { sequence: 0 };
  Reflect.set(app.config, "errorHandler", handler);
  app.use(adapter.createLogBrewVuePlugin({
    client,
    errorEvent: () => {
      counter.sequence += ONE;
      return {
        attributes: { level: "error", message: "component failed", title: "Vue component failed" },
        id: `evt_vue_error_${String(counter.sequence)}`,
        timestamp
      };
    },
    transport,
    ...options
  }));
  return { app, client, context: app.config.globalProperties.$logbrew, transport };
}

/**
 * @param {() => boolean} predicate
 * @param {number} [deadline]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, deadline = Date.now() + WAIT_MS) {
  if (predicate()) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error("capture completion was not observed");
  }
  await sleep(NO_DELAY);
  await waitFor(predicate, deadline);
}

/**
 * @param {() => Promise<void>} run
 * @returns {Promise<void>}
 */
async function noDetachedRejections(run) {
  /** @type {unknown[]} */
  const detached = [];
  /**
   * @param {unknown} error
   * @returns {void}
   */
  function observe(error) {
    detached.push(error);
  }
  process.on("unhandledRejection", observe);
  try {
    await run();
    await nextTurn();
    await nextTurn();
    assert.deepEqual(detached, []);
  } finally {
    process.off("unhandledRejection", observe);
  }
}

/**
 * @param {Adapter} adapter
 * @returns {{ readonly counts: Counts, readonly state: TestApp }}
 */
function makeCountingApp(adapter) {
  const counts = { delegated: NONE, flushed: NONE };
  const state = makeApp(adapter, undefined, {
    onFlush: () => {
      counts.flushed += ONE;
    }
  });
  return { counts, state };
}

/**
 * @param {Adapter} adapter
 * @returns {{ readonly counts: Counts, readonly handler: Handler, readonly state: TestApp }}
 */
function makeReentrantApp(adapter) {
  const counts = { delegated: NONE, flushed: NONE };
  /** @type {{ handler: Handler | undefined }} */
  const reentry = { handler: undefined };
  const state = makeApp(adapter, (_error, _instance, info) => {
    counts.delegated += ONE;
    if (info === "outer" && reentry.handler !== undefined) {
      reentry.handler(new Error("nested component failed"), null, "nested");
    }
  }, {
    onFlush: () => {
      counts.flushed += ONE;
    }
  });
  const handler = installedHandler(state.app);
  reentry.handler = handler;
  return { counts, handler, state };
}

/**
 * @param {Handler} handler
 * @param {string} name
 * @param {() => boolean} done
 * @returns {Promise<void>}
 */
async function failAndWait(handler, name, done) {
  handler(new Error(`${name} component failed`), null, name);
  await waitFor(done);
}

/**
 * @param {TestApp} state
 * @param {string} id
 * @returns {void}
 */
function assertClientStillLogs(state, id) {
  assert.doesNotThrow(() => {
    state.client.log(id, timestamp, {
      level: "info",
      message: "application continued"
    });
  });
}

/**
 * @param {RecordingTransport} transport
 * @returns {void}
 */
function assertTwoDistinctIssues(transport) {
  const events = sentEvents(transport);
  assert.equal(events.filter((event) => readPath(event, ["type"]) === "issue").length, TWO);
  assert.equal(new Set(events.map((event) => readPath(event, ["id"]))).size, TWO);
}

/**
 * @param {RecordingTransport} transport
 * @returns {void}
 */
function assertSessionEvents(transport) {
  const events = sentEvents(transport);
  assert.equal(events.length, TWO);
  assert.ok(events.every((event) => readPath(event, ["attributes", "context", "session", "id"]) === "sess_vue_001"));
}

for (const adapter of adapters) {
  const { format } = adapter;

  void test(`installed Vue handler preserves delegate result when capture callback fails in ${format}`, async () => {
    await noDetachedRejections(async () => {
      const result = { handled: true };
      const callbackError = new Error("callback unavailable");
      const counts = { failed: 0 };
      const state = makeApp(adapter, () => result, {
        onCaptureError: async (error) => {
          assert.equal(error, callbackError);
          counts.failed += ONE;
          throw new Error("failure callback unavailable");
        },
        onFlush: async () => {
          throw callbackError;
        }
      });
      try {
        assert.equal(installedHandler(state.app)(new Error("component failed"), null, "render"), result);
        await waitFor(() => counts.failed === ONE);
        assert.equal(state.context.client, state.client);
        assert.equal(state.app.config.globalProperties.$logbrew, state.context);
      } finally {
        await state.client.shutdown(state.transport);
      }
    });
  });

  void test(`previous Vue application error survives a secondary callback failure in ${format}`, async () => {
    await noDetachedRejections(async () => {
      const appError = new Error("application handler failed");
      const counts = { flushed: 0 };
      const state = makeApp(adapter, () => {
        throw appError;
      }, {
        onFlush: async () => {
          counts.flushed += ONE;
          throw new Error("capture callback unavailable");
        }
      });
      try {
        assert.throws(
          () => installedHandler(state.app)(new Error("component failed"), null, "render"),
          (error) => error === appError
        );
        await waitFor(() => counts.flushed === ONE);
      } finally {
        await state.client.shutdown(state.transport);
      }
    });
  });

  void test(`manual Vue capture keeps its rejecting contract and app-owned client in ${format}`, async () => {
    const callbackError = new Error("capture callback unavailable");
    const state = makeApp(adapter, undefined, { captureErrors: false });
    try {
      await assert.rejects(
        adapter.captureVueError(new Error("component failed"), null, "manual", state.context, {
          idFactory: () => "evt_vue_manual_001",
          now: () => timestamp,
          onFlush: async () => {
            throw callbackError;
          }
        }),
        (error) => error === callbackError
      );
      assertClientStillLogs(state, "evt_vue_log_001");
      assert.equal(state.context.client, state.client);
      await state.context.flush();
    } finally {
      await state.client.shutdown(state.transport);
    }
  });

  void test(`reentrant Vue errors capture twice without taking ownership of the client in ${format}`, async () => {
    await noDetachedRejections(async () => {
      const { counts, handler, state } = makeReentrantApp(adapter);
      try {
        handler(new Error("outer component failed"), null, "outer");
        await waitFor(() => counts.flushed === TWO);
        assert.equal(counts.delegated, TWO);
        assertTwoDistinctIssues(state.transport);
        assertClientStillLogs(state, "evt_vue_reentrant_log");
        await state.context.flush();
      } finally {
        await state.client.shutdown(state.transport);
      }
    });
  });

  void test(`late Vue errors preserve a replacement handler and reusable context in ${format}`, async () => {
    await noDetachedRejections(async () => {
      const { counts, state } = makeCountingApp(adapter);
      try {
        const installed = installedHandler(state.app);
        await failAndWait(installed, "first", () => counts.flushed === ONE);
        state.app.config.errorHandler = replacementHandler;
        await failAndWait(installed, "late", () => counts.flushed === TWO);
        assert.equal(state.app.config.errorHandler, replacementHandler);
        assert.equal(state.app.config.globalProperties.$logbrew, state.context);
        assertSessionEvents(state.transport);
      } finally {
        await state.client.shutdown(state.transport);
      }
    });
  });

  void test(`Vue capture opt-out preserves the existing handler in ${format}`, async () => {
    const state = makeApp(adapter, previousHandler, { captureErrors: false });
    try {
      assert.equal(state.app.config.errorHandler, previousHandler);
      assert.equal(state.context.client, state.client);
      assert.equal(state.client.pendingEvents(), NONE);
    } finally {
      await state.client.shutdown(state.transport);
    }
  });
}
