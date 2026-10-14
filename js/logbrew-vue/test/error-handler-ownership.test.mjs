import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createApp } from "vue";
import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";

const require = createRequire(import.meta.url);
const timestamp = "2026-10-04T10:00:00.000Z";

function makeApp(adapter, handler, options = {}) {
  const app = createApp({});
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_CLIENT_KEY",
    sdkName: "vue-error-test",
    sdkVersion: "1.0.0",
    automaticDelivery: false,
    context: { schemaVersion: 1, session: { id: "sess_vue_001" } }
  });
  const transport = RecordingTransport.alwaysAccept();
  let sequence = 0;
  app.config.errorHandler = handler;
  app.use(adapter.createLogBrewVuePlugin({
    client,
    transport,
    errorEvent() {
      sequence += 1;
      return {
        id: `evt_vue_error_${sequence}`,
        timestamp,
        attributes: { title: "Vue component failed", message: "component failed", level: "error" }
      };
    },
    ...options
  }));
  return { app, client, context: app.config.globalProperties.$logbrew, transport };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("capture completion was not observed");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function noDetachedRejections(run) {
  const detached = [];
  const observe = (error) => detached.push(error);
  process.on("unhandledRejection", observe);
  try {
    await run();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(detached, []);
  } finally {
    process.off("unhandledRejection", observe);
  }
}

for (const format of ["esm", "cjs"]) {
  const adapter = format === "esm" ? await import("@logbrew/vue") : require("@logbrew/vue");

  test(`installed Vue handler preserves delegate result when capture callback fails in ${format}`, async () => {
    await noDetachedRejections(async () => {
      const result = { handled: true };
      const callbackError = new Error("callback unavailable");
      let failed = 0;
      const state = makeApp(adapter, () => result, {
        onFlush: () => Promise.reject(callbackError),
        onCaptureError(error) {
          assert.equal(error, callbackError);
          failed += 1;
          return Promise.reject(new Error("failure callback unavailable"));
        }
      });
      try {
        assert.equal(state.app.config.errorHandler(new Error("component failed"), null, "render"), result);
        await waitFor(() => failed === 1);
        assert.equal(state.context.client, state.client);
        assert.equal(state.app.config.globalProperties.$logbrew, state.context);
      } finally {
        await state.client.shutdown(state.transport);
      }
    });
  });

  test(`previous Vue application error survives a secondary callback failure in ${format}`, async () => {
    await noDetachedRejections(async () => {
      const appError = new Error("application handler failed");
      let flushed = 0;
      const state = makeApp(adapter, () => { throw appError; }, {
        onFlush() {
          flushed += 1;
          return Promise.reject(new Error("capture callback unavailable"));
        }
      });
      try {
        assert.throws(
          () => state.app.config.errorHandler(new Error("component failed"), null, "render"),
          (error) => error === appError
        );
        await waitFor(() => flushed === 1);
      } finally {
        await state.client.shutdown(state.transport);
      }
    });
  });

  test(`manual Vue capture keeps its rejecting contract and app-owned client in ${format}`, async () => {
    const callbackError = new Error("capture callback unavailable");
    const state = makeApp(adapter, undefined, { captureErrors: false });
    try {
      await assert.rejects(
        adapter.captureVueError(new Error("component failed"), null, "manual", state.context, {
          idFactory: () => "evt_vue_manual_001",
          now: () => timestamp,
          onFlush: () => Promise.reject(callbackError)
        }),
        (error) => error === callbackError
      );
      assert.doesNotThrow(() => state.client.log("evt_vue_log_001", timestamp, {
        message: "application continued",
        level: "info"
      }));
      assert.equal(state.context.client, state.client);
      await state.context.flush();
    } finally {
      await state.client.shutdown(state.transport);
    }
  });

  test(`reentrant Vue errors capture twice without taking ownership of the client in ${format}`, async () => {
    await noDetachedRejections(async () => {
      let delegated = 0;
      let flushed = 0;
      let state;
      state = makeApp(adapter, (error, instance, info) => {
        delegated += 1;
        if (info === "outer") {
          state.app.config.errorHandler(new Error("nested component failed"), null, "nested");
        }
      }, { onFlush: () => { flushed += 1; } });
      try {
        state.app.config.errorHandler(new Error("outer component failed"), null, "outer");
        await waitFor(() => flushed === 2);
        assert.equal(delegated, 2);
        const events = state.transport.sentBodies.flatMap((body) => JSON.parse(body).events);
        assert.equal(events.filter((event) => event.type === "issue").length, 2);
        assert.equal(new Set(events.map((event) => event.id)).size, 2);
        assert.doesNotThrow(() => state.client.log("evt_vue_reentrant_log", timestamp, {
          message: "application continued",
          level: "info"
        }));
        await state.context.flush();
      } finally {
        await state.client.shutdown(state.transport);
      }
    });
  });

  test(`late Vue errors preserve a replacement handler and reusable context in ${format}`, async () => {
    await noDetachedRejections(async () => {
      let flushed = 0;
      const state = makeApp(adapter, undefined, { onFlush: () => { flushed += 1; } });
      try {
        const installed = state.app.config.errorHandler;
        installed(new Error("first component failed"), null, "first");
        await waitFor(() => flushed === 1);
        const replacement = () => undefined;
        state.app.config.errorHandler = replacement;
        installed(new Error("late component failed"), null, "late");
        await waitFor(() => flushed === 2);
        assert.equal(state.app.config.errorHandler, replacement);
        assert.equal(state.app.config.globalProperties.$logbrew, state.context);
        const events = state.transport.sentBodies.flatMap((body) => JSON.parse(body).events);
        assert.equal(events.length, 2);
        assert.ok(events.every((event) => event.attributes.context.session.id === "sess_vue_001"));
      } finally {
        await state.client.shutdown(state.transport);
      }
    });
  });

  test(`Vue capture opt-out preserves the existing handler in ${format}`, async () => {
    const previous = () => undefined;
    const state = makeApp(adapter, previous, { captureErrors: false });
    try {
      assert.equal(state.app.config.errorHandler, previous);
      assert.equal(state.context.client, state.client);
      assert.equal(state.client.pendingEvents(), 0);
    } finally {
      await state.client.shutdown(state.transport);
    }
  });
}
