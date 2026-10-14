import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import * as esm from "@logbrew/bullmq";
import { getActiveLogBrewTrace, runWithLogBrewTrace } from "@logbrew/node";

const require = createRequire(import.meta.url);
const cjs = require("@logbrew/bullmq");
const attemptKey = "bullmq.job.attempts.made";
const traceId = "22222222222222222222222222222222";
const parentSpanId = "1111111111111111";
const traceparent = `00-${traceId}-${parentSpanId}-01`;

function makeJob(attemptsMade) {
  return {
    attemptsMade,
    data: { template: "synthetic-private-payload" },
    name: "welcome",
    opts: { telemetry: { metadata: JSON.stringify({ logbrew: { traceparent } }) } },
    queueName: "email"
  };
}

function recordingOptions(events, extra = {}) {
  let nextSpanId = 3;
  return {
    client: {
      span(id, timestamp, attributes) {
        events.push({ id, timestamp, attributes });
      }
    },
    metadata: { component: "worker" },
    spanIdFactory: () => (nextSpanId++).toString(16).padStart(16, "0"),
    ...extra
  };
}

for (const [format, adapter] of [["ESM", esm], ["CommonJS", cjs]]) {
  describe(`${format} worker attempt evidence`, () => {
    test("failure then recovery preserves outcomes and producer correlation", async () => {
      const events = [];
      const failure = new Error("synthetic-processor-failure");
      const result = { processed: true };
      const job = makeJob(0);
      let calls = 0;
      const processor = adapter.withLogBrewBullMqProcessor((currentJob) => {
        expect(currentJob).toBe(job);
        expect(getActiveLogBrewTrace().traceId).toBe(traceId);
        calls++;
        if (calls === 1) throw failure;
        return result;
      }, recordingOptions(events));

      let observedFailure;
      try {
        await processor(job);
      } catch (error) {
        observedFailure = error;
      }
      expect(observedFailure).toBe(failure);
      expect(getActiveLogBrewTrace()).toBeUndefined();
      job.attemptsMade = 1;
      expect(await processor(job)).toBe(result);
      expect(calls).toBe(2);
      expect(getActiveLogBrewTrace()).toBeUndefined();
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.attributes.metadata[attemptKey])).toEqual([0, 1]);
      expect(events.map((event) => event.attributes.traceId)).toEqual([traceId, traceId]);
      expect(events.map((event) => event.attributes.parentSpanId)).toEqual([parentSpanId, parentSpanId]);
      expect(new Set(events.map((event) => event.attributes.spanId)).size).toBe(2);
      expect(JSON.stringify(events)).not.toContain("synthetic-private-payload");
      expect(JSON.stringify(events)).not.toContain("synthetic-processor-failure");
    });

    test("class instrumentation snapshots the counter and restores the method", async () => {
      const events = [];
      const options = recordingOptions(events, {
        metadata: { component: "worker", [attemptKey]: 99 }
      });
      const job = makeJob(2);
      const lock = "synthetic-lock";
      const signal = new AbortController().signal;
      const result = { processed: true };
      const target = {
        process(currentJob, currentLock, currentSignal, extra) {
          expect(this).toBe(target);
          expect(currentJob).toBe(job);
          expect(currentLock).toBe(lock);
          expect(currentSignal).toBe(signal);
          expect(extra).toBe("extra");
          currentJob.attemptsMade = 3;
          return result;
        }
      };
      const original = target.process;
      const instrumentation = adapter.instrumentLogBrewBullMqProcessor(target, options);
      try {
        expect(await target.process(job, lock, signal, "extra")).toBe(result);
        expect(events).toHaveLength(1);
        expect(events[0].attributes.metadata[attemptKey]).toBe(2);
        expect(events[0].attributes.metadata.component).toBe("worker");
        expect(options.metadata[attemptKey]).toBe(99);
      } finally {
        instrumentation.uninstall();
      }
      expect(target.process).toBe(original);
      expect(target.process(job, lock, signal, "extra")).toBe(result);
      expect(events).toHaveLength(1);
    });

    test("unavailable or invalid counters remain absent", async () => {
      const events = [];
      const processor = adapter.withLogBrewBullMqProcessor(() => "done", recordingOptions(events));
      const counters = [undefined, null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"];
      for (const counter of counters) {
        expect(await processor(makeJob(counter))).toBe("done");
      }
      expect(events).toHaveLength(counters.length);
      for (const event of events) {
        expect(Object.hasOwn(event.attributes.metadata, attemptKey)).toBe(false);
        expect(event.attributes.metadata.component).toBe("worker");
      }
    });

    test("concurrent jobs retain their own counter without mutating caller metadata", async () => {
      const events = [];
      const options = recordingOptions(events);
      let releaseFirst;
      const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
      const processor = adapter.withLogBrewBullMqProcessor(async (job) => {
        if (job.attemptsMade === 0) await firstReleased;
        return job.attemptsMade;
      }, options);
      const first = processor(makeJob(0));
      try {
        expect(await processor(makeJob(3))).toBe(3);
      } finally {
        releaseFirst();
      }
      expect(await first).toBe(0);
      expect(events.map((event) => event.attributes.metadata[attemptKey]).sort((a, b) => a - b)).toEqual([0, 3]);
      expect(options.metadata).toEqual({ component: "worker" });
    });

    test("counter accessor failures leave the processor's outcome and scope intact", async () => {
      const events = [];
      const job = makeJob(0);
      Object.defineProperty(job, "attemptsMade", {
        get() { throw new Error("synthetic-counter-failure"); }
      });
      const outer = { traceId: "44444444444444444444444444444444", spanId: "5555555555555555", sampled: true };
      const result = { processed: true };
      const failure = new Error("synthetic-processor-failure");
      let calls = 0;
      const options = recordingOptions(events);
      const succeed = adapter.withLogBrewBullMqProcessor(() => {
        calls++;
        expect(getActiveLogBrewTrace().traceId).toBe(traceId);
        return result;
      }, options);
      const fail = adapter.withLogBrewBullMqProcessor(() => {
        calls++;
        throw failure;
      }, options);

      await runWithLogBrewTrace(outer, async () => {
        expect(await succeed(job)).toBe(result);
        expect(getActiveLogBrewTrace()).toBe(outer);
        let observedFailure;
        try { await fail(job); } catch (error) { observedFailure = error; }
        expect(observedFailure).toBe(failure);
        expect(getActiveLogBrewTrace()).toBe(outer);
      });
      expect(getActiveLogBrewTrace()).toBeUndefined();
      expect(calls).toBe(2);
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(Object.hasOwn(event.attributes.metadata, attemptKey)).toBe(false);
        expect(event.attributes.metadata.component).toBe("worker");
        expect(event.attributes.traceId).toBe(traceId);
        expect(event.attributes.parentSpanId).toBe(parentSpanId);
      }
      expect(JSON.stringify(events)).not.toContain("synthetic-counter-failure");
    });

    test("metadata accessors cannot prevent processing or replace its result", async () => {
      const events = [];
      const metadata = {};
      Object.defineProperty(metadata, "component", {
        enumerable: true,
        get() { throw new Error("synthetic-metadata-failure"); }
      });
      const result = { processed: true };
      const failure = new Error("synthetic-processor-failure");
      let calls = 0;
      const options = recordingOptions(events, { metadata });
      const succeed = adapter.withLogBrewBullMqProcessor(() => { calls++; return result; }, options);
      const fail = adapter.withLogBrewBullMqProcessor(() => { calls++; throw failure; }, options);
      expect(await succeed(makeJob(1))).toBe(result);
      let observedFailure;
      try { await fail(makeJob(2)); } catch (error) { observedFailure = error; }
      expect(observedFailure).toBe(failure);
      expect(calls).toBe(2);
      expect(events).toHaveLength(2);
      expect(getActiveLogBrewTrace()).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(metadata, "component").get).toBeDefined();
      expect(JSON.stringify(events)).not.toContain("synthetic-metadata-failure");
    });

    test("capture failure preserves the application's result and rejection", async () => {
      const captureFailure = new Error("synthetic-capture-failure");
      const applicationFailure = new Error("synthetic-processor-failure");
      const result = { processed: true };
      const options = recordingOptions([], {
        client: { span() { throw captureFailure; } },
        onCaptureError() {}
      });
      const succeed = adapter.withLogBrewBullMqProcessor(() => result, options);
      const fail = adapter.withLogBrewBullMqProcessor(() => { throw applicationFailure; }, options);
      expect(await succeed(makeJob(1))).toBe(result);
      let observedFailure;
      try {
        await fail(makeJob(2));
      } catch (error) {
        observedFailure = error;
      }
      expect(observedFailure).toBe(applicationFailure);
    });
  });
}
