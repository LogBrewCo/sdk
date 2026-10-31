import { LogBrewClient } from "@logbrew/sdk";
import assert from "node:assert/strict";
import { once } from "node:events";

/**
 * @import { DroppedEvent, OpenTelemetryHrTimeLike, OpenTelemetryReadableSpanLike, OpenTelemetrySpanContextLike, RecordingTransport, Transport, TransportResponse } from "@logbrew/sdk"
 */

/**
 * @template T
 * @typedef {{ readonly promise: Readonly<Promise<T>>, readonly resolve: (value: T) => void }} Deferred
 */

/**
 * @typedef {{ readonly maxQueueSize?: number, readonly maxRetries?: number, readonly onEventDropped?: (drop: Readonly<DroppedEvent>) => void }} ClientOverrides
 * @typedef {OpenTelemetryReadableSpanLike & { readonly ended: boolean }} SampleReadableSpan
 * @typedef {{ readonly firstSendStarted: Deferred<void>, readonly releaseFirstSend: Deferred<TransportResponse>, readonly sends: readonly string[], readonly transport: Transport }} GatedTransport
 */

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";
const CHILD_SPAN_ID = "b7ad6b7169203331";
const TRACE_FLAGS_UNSAMPLED = 0;
const TRACE_FLAGS_SAMPLED = 1;
const EPOCH_SECONDS = 1_780_000_000;
const ZERO_SECONDS = 0;
const START_NANOS = 100_000_000;
const END_NANOS = 225_000_000;
const DURATION_NANOS = 125_000_000;
const EXCEPTION_NANOS = 160_000_000;
const CACHE_LOOKUP_NANOS = 180_000_000;
const FIRST_SEND = 1;
const LOGGER_TRACE = {
  parentSpanId: PARENT_SPAN_ID,
  sampled: true,
  spanId: CHILD_SPAN_ID,
  traceId: TRACE_ID
};

/**
 * @param {ClientOverrides} overrides
 * @returns {LogBrewClient}
 */
function sampleClient(overrides = {}) {
  return LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    maxRetries: 2,
    sdkName: "logbrew-js",
    sdkVersion: "0.1.0",
    ...overrides
  });
}

/**
 * @param {number} seconds
 * @param {number} nanos
 * @returns {OpenTelemetryHrTimeLike}
 */
function hrTime(seconds, nanos) {
  return [seconds, nanos];
}

/**
 * @param {string} traceId
 * @param {string} spanId
 * @param {number} traceFlags
 * @returns {() => OpenTelemetrySpanContextLike}
 */
function spanContextOf(traceId, spanId, traceFlags) {
  return () => ({ spanId, traceFlags, traceId });
}

/**
 * @returns {NonNullable<OpenTelemetryReadableSpanLike["events"]>}
 */
function sampleSpanEvents() {
  return [
    {
      attributes: {
        "exception.escaped": false,
        "exception.message": "contains private payload",
        "exception.stacktrace": "private stack",
        "exception.type": "TypeError"
      },
      name: "exception",
      time: hrTime(EPOCH_SECONDS, EXCEPTION_NANOS)
    },
    {
      attributes: {
        "cache.hit": false,
        "cache.key": "private-cache-key"
      },
      name: "cache.lookup",
      time: hrTime(EPOCH_SECONDS, CACHE_LOOKUP_NANOS)
    }
  ];
}

/**
 * @returns {NonNullable<OpenTelemetryReadableSpanLike["links"]>}
 */
function sampleSpanLinks() {
  return [
    {
      attributes: {
        "http.url": "https://api.example/internal?api_key=redacted",
        "messaging.operation.name": "process"
      },
      context: {
        spanId: "2222222222222222",
        traceFlags: 1,
        traceId: "11111111111111111111111111111111"
      }
    }
  ];
}

/**
 * @returns {SampleReadableSpan}
 */
function sampleOpenTelemetryReadableSpan() {
  return {
    attributes: {
      "db.statement": "select * from users where api_key = 'redacted'",
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "http.route": "/orders/:id",
      "url.full": "https://api.example/orders/42?api_key=redacted#frag"
    },
    droppedAttributesCount: 1,
    droppedEventsCount: 2,
    droppedLinksCount: 3,
    duration: hrTime(ZERO_SECONDS, DURATION_NANOS),
    endTime: hrTime(EPOCH_SECONDS, END_NANOS),
    ended: true,
    events: sampleSpanEvents(),
    instrumentationScope: {
      name: "@opentelemetry/instrumentation-http",
      version: "1.2.3"
    },
    kind: 2,
    links: sampleSpanLinks(),
    name: "GET /orders/:id",
    parentSpanContext: {
      spanId: PARENT_SPAN_ID,
      traceFlags: 1,
      traceId: TRACE_ID
    },
    resource: {
      attributes: {
        "deployment.environment.name": "production",
        "host.name": "private-host",
        "service.name": "checkout"
      }
    },
    spanContext: spanContextOf(TRACE_ID, CHILD_SPAN_ID, TRACE_FLAGS_SAMPLED),
    startTime: hrTime(EPOCH_SECONDS, START_NANOS),
    status: { code: 1 }
  };
}

/**
 * @param {string} traceId
 * @param {string} spanId
 * @param {number} traceFlags
 * @returns {SampleReadableSpan}
 */
function sampleSpanWithContext(traceId, spanId, traceFlags) {
  return { ...sampleOpenTelemetryReadableSpan(), spanContext: spanContextOf(traceId, spanId, traceFlags) };
}

/**
 * @template T
 * @returns {Deferred<T>}
 */
function deferred() {
  const settled = new AbortController();
  /** @type {{ readonly value: T }[]} */
  const values = [];
  /**
   * @returns {Promise<T>}
   */
  async function settledValue() {
    await once(settled.signal, "abort");
    const [first] = values;
    assert.ok(first !== undefined, "expected a resolved value");
    return first.value;
  }
  return {
    promise: settledValue(),
    resolve(value) {
      values.push({ value });
      settled.abort();
    }
  };
}

/**
 * @param {() => Promise<unknown>} run
 * @returns {Promise<unknown>}
 */
async function captureRejection(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected callback to reject");
}

/**
 * @param {(...args: readonly never[]) => unknown} target
 * @param {readonly unknown[]} args
 * @returns {unknown}
 */
function callUnchecked(target, args) {
  /** @type {unknown} */
  const result = Reflect.apply(target, undefined, args);
  return result;
}

/**
 * @param {number} laterStatus
 * @returns {GatedTransport}
 */
function gatedTransport(laterStatus) {
  /** @type {string[]} */
  const sends = [];
  /** @type {Deferred<void>} */
  const firstSendStarted = deferred();
  /** @type {Deferred<TransportResponse>} */
  const releaseFirstSend = deferred();
  return {
    firstSendStarted,
    releaseFirstSend,
    sends,
    transport: {
      async send(_apiKey, body) {
        sends.push(body);
        if (sends.length === FIRST_SEND) {
          firstSendStarted.resolve();
          return releaseFirstSend.promise;
        }
        return { attempts: 1, statusCode: laterStatus };
      }
    }
  };
}

/**
 * @param {string} value
 * @returns {unknown}
 */
function parseJson(value) {
  /** @type {unknown} */
  const parsed = JSON.parse(value);
  return parsed;
}

/**
 * @param {RecordingTransport} transport
 * @returns {unknown}
 */
function lastPayload(transport) {
  const body = transport.lastBody();
  assert.ok(body !== null, "expected a sent body");
  return parseJson(body);
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function member(value, key) {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} value
 * @param {string} keyPath
 * @returns {unknown}
 */
function pick(value, keyPath) {
  let current = value;
  for (const key of keyPath.split(".")) {
    current = member(current, key);
  }
  return current;
}

/**
 * @param {unknown} event
 * @param {string} key
 * @returns {unknown}
 */
function metadataValue(event, key) {
  return member(pick(event, "attributes.metadata"), key);
}

/**
 * @param {string} output
 * @param {readonly string[]} needles
 * @returns {void}
 */
function assertExcludes(output, needles) {
  for (const needle of needles) {
    assert.equal(output.includes(needle), false, `output must not include ${needle}`);
  }
}

/**
 * @param {unknown} value
 * @returns {readonly unknown[]}
 */
function items(value) {
  assert.ok(Array.isArray(value), "expected an array");
  /** @type {readonly unknown[]} */
  const list = value;
  return list;
}

/**
 * @param {unknown} payload
 * @param {string} keyPath
 * @returns {readonly unknown[]}
 */
function eventValues(payload, keyPath) {
  return items(pick(payload, "events")).map((event) => pick(event, keyPath));
}

/**
 * @param {unknown} payload
 * @param {string} id
 * @returns {unknown}
 */
function eventById(payload, id) {
  const event = items(pick(payload, "events")).find((candidate) => pick(candidate, "id") === id);
  assert.ok(event !== undefined, `expected event ${id}`);
  return event;
}

export {
  CACHE_LOOKUP_NANOS,
  CHILD_SPAN_ID,
  EPOCH_SECONDS,
  LOGGER_TRACE,
  PARENT_SPAN_ID,
  START_NANOS,
  TRACE_FLAGS_SAMPLED,
  TRACE_FLAGS_UNSAMPLED,
  TRACE_ID,
  ZERO_SECONDS,
  assertExcludes,
  callUnchecked,
  captureRejection,
  deferred,
  eventById,
  eventValues,
  gatedTransport,
  hrTime,
  items,
  lastPayload,
  member,
  metadataValue,
  parseJson,
  pick,
  sampleClient,
  sampleOpenTelemetryReadableSpan,
  sampleSpanWithContext,
  spanContextOf
};
