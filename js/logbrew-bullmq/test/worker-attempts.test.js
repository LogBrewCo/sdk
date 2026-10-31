import { expect, test } from "bun:test";
import { getActiveLogBrewTrace, runWithLogBrewTrace } from "@logbrew/node";
import { LogBrewClient } from "@logbrew/sdk";
import { instrumentLogBrewBullMqProcessor } from "@logbrew/bullmq";

/**
 * @import { LogBrewBullMqSpanOptions } from "@logbrew/bullmq"
 * @typedef {{
 *   readonly attempt: unknown,
 *   readonly component: unknown,
 *   readonly hasAttempt: boolean,
 *   readonly parentSpanId: unknown,
 *   readonly spanId: unknown,
 *   readonly traceId: unknown
 * }} RecordedSpan
 * @typedef {{
 *   readonly attemptsMade: unknown,
 *   readonly data: { readonly template: string },
 *   readonly name: string,
 *   readonly opts: { readonly telemetry: { readonly metadata: string } },
 *   readonly queueName: string
 * }} TestJob
 * @typedef {(this: unknown, ...args: readonly unknown[]) => { readonly processed: boolean }} ClassProcess
 * @typedef {{ args: readonly unknown[], self: unknown }} ReceivedCall
 */

const ATTEMPT_KEY = "bullmq.job.attempts.made";
const TRACE_ID = "22222222222222222222222222222222";
const PARENT_SPAN_ID = "1111111111111111";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;
const FIRST_SPAN_ID = 3;
const HEX = 16;
const SPAN_ID_LENGTH = 16;
const FIRST_ATTEMPT = 0;
const SECOND_ATTEMPT = 1;
const THIRD_ATTEMPT = 2;
const FOURTH_ATTEMPT = 3;
const CALLER_ATTEMPT = 99;
const SINGLE_EVENT = 1;
const TWO_EVENTS = 2;
const INVALID_COUNTERS = [
  undefined,
  -SECOND_ATTEMPT,
  SECOND_ATTEMPT / THIRD_ATTEMPT,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + SECOND_ATTEMPT,
  "1"
];
const PRIVATE_TEXT = [
  "synthetic-counter-failure",
  "synthetic-metadata-failure",
  "synthetic-private-payload",
  "synthetic-processor-failure"
];
const RESOLVED = "resolved";
const RESULT = { processed: true };
const PROCESSOR_FAILURE = new Error("synthetic-processor-failure");

/**
 * @returns {never}
 */
function throwProcessorFailure() {
  throw PROCESSOR_FAILURE;
}

/**
 * @param {() => Promise<unknown>} run
 * @returns {Promise<unknown>}
 */
async function rejectionOf(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return RESOLVED;
}

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {unknown}
 */
function readField(value, name) {
  return isObject(value) ? value[name] : undefined;
}

/**
 * @param {unknown} event
 * @returns {RecordedSpan}
 */
function toRecordedSpan(event) {
  const attributes = readField(event, "attributes");
  const metadata = readField(attributes, "metadata");
  return {
    attempt: readField(metadata, ATTEMPT_KEY),
    component: readField(metadata, "component"),
    hasAttempt: isObject(metadata) && Object.hasOwn(metadata, ATTEMPT_KEY),
    parentSpanId: readField(attributes, "parentSpanId"),
    spanId: readField(attributes, "spanId"),
    traceId: readField(attributes, "traceId")
  };
}

/**
 * @param {LogBrewClient} client
 * @returns {readonly RecordedSpan[]}
 */
function recordedSpans(client) {
  /** @type {unknown} */
  const preview = JSON.parse(client.previewJson());
  const events = readField(preview, "events");
  return isList(events) ? events.map((event) => toRecordedSpan(event)) : [];
}

/**
 * @param {LogBrewClient} client
 * @returns {void}
 */
function expectNoPrivateText(client) {
  const text = client.previewJson();
  for (const fragment of PRIVATE_TEXT) {
    expect(text).not.toContain(fragment);
  }
}

/**
 * @param {unknown} attemptsMade
 * @returns {TestJob}
 */
function makeJob(attemptsMade) {
  return {
    attemptsMade,
    data: { template: "synthetic-private-payload" },
    name: "welcome",
    opts: { telemetry: { metadata: JSON.stringify({ logbrew: { traceparent: TRACEPARENT } }) } },
    queueName: "email"
  };
}

/**
 * @returns {TestJob}
 */
function makeThrowingCounterJob() {
  const job = makeJob(FIRST_ATTEMPT);
  Object.defineProperty(job, "attemptsMade", {
    get: () => {
      throw new Error("synthetic-counter-failure");
    }
  });
  return job;
}

/**
 * @returns {Record<string, string>}
 */
function makeThrowingMetadata() {
  /** @type {Record<string, string>} */
  const metadata = {};
  Object.defineProperty(metadata, "component", {
    enumerable: true,
    get: () => {
      throw new Error("synthetic-metadata-failure");
    }
  });
  return metadata;
}

/**
 * @returns {LogBrewClient}
 */
function createClient() {
  return LogBrewClient.create({
    apiKey: "LOGBREW_SERVER_API_KEY",
    sdkName: "bullmq-worker-attempts-test",
    sdkVersion: "0.1.0"
  });
}

/**
 * @param {LogBrewClient} client
 * @param {Readonly<Record<string, string | number | boolean | null>>} [metadata]
 * @returns {LogBrewBullMqSpanOptions}
 */
function recordingOptions(client, metadata) {
  const state = { nextSpanId: FIRST_SPAN_ID };
  return {
    client,
    metadata: { ...(metadata ?? { component: "worker" }) },
    spanIdFactory: () => {
      const spanId = state.nextSpanId.toString(HEX).padStart(SPAN_ID_LENGTH, "0");
      state.nextSpanId += SECOND_ATTEMPT;
      return spanId;
    }
  };
}

/**
 * @param {(job: TestJob) => unknown} processor
 * @param {LogBrewBullMqSpanOptions} options
 * @returns {(job: TestJob) => Promise<unknown>}
 */
function instrumentedProcessor(processor, options) {
  const target = { process: processor };
  instrumentLogBrewBullMqProcessor(target, options);
  return async (job) => target.process(job);
}

/**
 * @param {LogBrewClient} client
 * @param {readonly unknown[]} attempts
 * @returns {void}
 */
function expectCorrelatedAttempts(client, attempts) {
  const events = recordedSpans(client);
  expect(events.map((event) => event.attempt)).toEqual([...attempts]);
  expect(events.map((event) => event.traceId)).toEqual(attempts.map(() => TRACE_ID));
  expect(events.map((event) => event.parentSpanId)).toEqual(attempts.map(() => PARENT_SPAN_ID));
  expect(new Set(events.map((event) => event.spanId)).size).toBe(attempts.length);
  expectNoPrivateText(client);
}

/**
 * @returns {{ readonly received: ReceivedCall, readonly target: { readonly process: ClassProcess } }}
 */
function createClassTarget() {
  /** @type {ReceivedCall} */
  const received = { args: [], self: undefined };
  /** @type {ClassProcess} */
  function process(...args) {
    const [currentJob] = args;
    received.self = this;
    received.args = args;
    if (typeof currentJob === "object" && currentJob !== null) {
      Reflect.set(currentJob, "attemptsMade", FOURTH_ATTEMPT);
    }
    return RESULT;
  }
  return { received, target: { process } };
}

/**
 * @param {{
 *   readonly call: readonly unknown[],
 *   readonly client: LogBrewClient,
 *   readonly options: LogBrewBullMqSpanOptions,
 *   readonly original: ClassProcess,
 *   readonly received: Readonly<ReceivedCall>,
 *   readonly target: { readonly process: ClassProcess }
 * }} input
 * @returns {void}
 */
function expectClassInstrumentation(input) {
  const { call, client, options, original, received, target } = input;
  expect(received.self).toBe(target);
  expect(received.args).toEqual([...call]);
  expect(target.process).toBe(original);
  expect(recordedSpans(client).map((event) => [event.attempt, event.component])).toEqual([[THIRD_ATTEMPT, "worker"]]);
  expect(options.metadata?.[ATTEMPT_KEY]).toBe(CALLER_ATTEMPT);
  expect(target.process(...call)).toBe(RESULT);
  expect(recordedSpans(client)).toHaveLength(SINGLE_EVENT);
}

test("failure then recovery preserves outcomes and producer correlation", async () => {
  const client = createClient();
  const job = makeJob(FIRST_ATTEMPT);
  const processor = instrumentedProcessor((currentJob) => {
    expect(currentJob).toBe(job);
    expect(getActiveLogBrewTrace()?.traceId).toBe(TRACE_ID);
    return currentJob.attemptsMade === FIRST_ATTEMPT ? throwProcessorFailure() : RESULT;
  }, recordingOptions(client));
  expect(await rejectionOf(async () => processor(job))).toBe(PROCESSOR_FAILURE);
  expect(getActiveLogBrewTrace()).toBeUndefined();
  Reflect.set(job, "attemptsMade", SECOND_ATTEMPT);
  expect(await processor(job)).toBe(RESULT);
  expect(getActiveLogBrewTrace()).toBeUndefined();
  expectCorrelatedAttempts(client, [FIRST_ATTEMPT, SECOND_ATTEMPT]);
});

test("class instrumentation snapshots the counter and restores the method", async () => {
  const client = createClient();
  const options = recordingOptions(client, { [ATTEMPT_KEY]: CALLER_ATTEMPT, component: "worker" });
  const call = [makeJob(THIRD_ATTEMPT), "synthetic-lock", new AbortController().signal, "extra"];
  const { received, target } = createClassTarget();
  const { process: original } = target;
  const instrumentation = instrumentLogBrewBullMqProcessor(target, options);
  expect(await Promise.resolve(target.process(...call))).toBe(RESULT);
  instrumentation.uninstall();
  expectClassInstrumentation({ call, client, options, original, received, target });
});

test("unavailable or invalid counters remain absent", async () => {
  const client = createClient();
  const processor = instrumentedProcessor(() => "done", recordingOptions(client));
  const results = await Promise.all(INVALID_COUNTERS.map(async (counter) => processor(makeJob(counter))));
  const events = recordedSpans(client);
  expect(results).toEqual(INVALID_COUNTERS.map(() => "done"));
  expect(events.filter((event) => event.hasAttempt)).toEqual([]);
  expect(events.map((event) => event.component)).toEqual(INVALID_COUNTERS.map(() => "worker"));
});

test("concurrent jobs retain their own counter without mutating caller metadata", async () => {
  const client = createClient();
  const options = recordingOptions(client);
  /** @type {{ second: Promise<unknown> }} */
  const pending = { second: Promise.resolve() };
  const processor = instrumentedProcessor(async (job) => {
    await Promise.resolve();
    if (job.attemptsMade === FIRST_ATTEMPT) {
      await pending.second;
    }
    return job.attemptsMade;
  }, options);
  const first = processor(makeJob(FIRST_ATTEMPT));
  pending.second = processor(makeJob(FOURTH_ATTEMPT));
  expect([await pending.second, await first]).toEqual([FOURTH_ATTEMPT, FIRST_ATTEMPT]);
  expect(recordedSpans(client).map((event) => event.attempt)).toEqual([FOURTH_ATTEMPT, FIRST_ATTEMPT]);
  expect(options.metadata).toEqual({ component: "worker" });
});

test("counter accessor failures leave the processor's outcome and scope intact", async () => {
  const client = createClient();
  const job = makeThrowingCounterJob();
  const outer = { sampled: true, spanId: "5555555555555555", traceId: "44444444444444444444444444444444" };
  const options = recordingOptions(client);
  const succeed = instrumentedProcessor(() => getActiveLogBrewTrace()?.traceId, options);
  const fail = instrumentedProcessor(throwProcessorFailure, options);
  await runWithLogBrewTrace(outer, async () => {
    expect([await succeed(job), getActiveLogBrewTrace()]).toEqual([TRACE_ID, outer]);
    expect(await rejectionOf(async () => fail(job))).toBe(PROCESSOR_FAILURE);
    expect(getActiveLogBrewTrace()).toBe(outer);
  });
  expect(getActiveLogBrewTrace()).toBeUndefined();
  expect(recordedSpans(client).map((event) => [event.hasAttempt, event.component])).toEqual([[false, "worker"], [false, "worker"]]);
  expectCorrelatedAttempts(client, [undefined, undefined]);
});

test("metadata accessors cannot prevent processing or replace its result", async () => {
  const client = createClient();
  const metadata = makeThrowingMetadata();
  const options = { ...recordingOptions(client), metadata };
  const succeed = instrumentedProcessor(() => RESULT, options);
  const fail = instrumentedProcessor(throwProcessorFailure, options);
  expect(await succeed(makeJob(SECOND_ATTEMPT))).toBe(RESULT);
  expect(await rejectionOf(async () => fail(makeJob(THIRD_ATTEMPT)))).toBe(PROCESSOR_FAILURE);
  expect([recordedSpans(client).length, getActiveLogBrewTrace()]).toEqual([TWO_EVENTS, undefined]);
  expect(() => metadata["component"]).toThrow("synthetic-metadata-failure");
  expectNoPrivateText(client);
});

test("capture failure preserves the application's result and rejection", async () => {
  const captureFailure = new Error("synthetic-capture-failure");
  const client = createClient();
  client.span = () => {
    throw captureFailure;
  };
  const options = { ...recordingOptions(client), onCaptureError: () => undefined };
  const succeed = instrumentedProcessor(() => RESULT, options);
  const fail = instrumentedProcessor(throwProcessorFailure, options);
  expect(await succeed(makeJob(SECOND_ATTEMPT))).toBe(RESULT);
  expect(await rejectionOf(async () => fail(makeJob(THIRD_ATTEMPT)))).toBe(PROCESSOR_FAILURE);
});
