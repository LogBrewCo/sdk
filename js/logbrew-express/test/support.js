import assert from "node:assert/strict";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";

/**
 * @import { Server } from "node:http"
 * @import { TestContext } from "node:test"
 * @import { NextFunction, Request, Response } from "express"
 * @import { LogBrewExpressContext } from "@logbrew/express"
 * @import { Transport, TransportResponse } from "@logbrew/sdk"
 * @typedef {{ readonly close: () => void, readonly origin: string, readonly port: number }} Listening
 * @typedef {{ readonly fail: (reason: unknown) => void, readonly open: () => void, readonly wait: () => Promise<void> }} Latch
 * @typedef {{ readonly attempts: number, readonly intervalMs: number, readonly message: string }} Polling
 * @typedef {{ readonly failed: boolean, readonly reason: unknown }} Outcome
 * @typedef {{ readonly bodies: readonly string[], readonly transport: Transport }} Recorder
 * @typedef {{ readonly count: () => number, readonly onFlush: () => void, readonly wait: () => Promise<void> }} FlushLatch
 * @typedef {(error: unknown, req: Request, res: Response, next: NextFunction) => void} FinalErrorHandler
 * @typedef {{ readonly add: () => void, readonly value: () => number }} Counter
 */

const HOST = "127.0.0.1";
const ANY_PORT = 0;
const NO_PORT = 0;
const NO_ATTEMPTS = 0;
const NO_FLUSHES = 0;
const ZERO = 0;
const STEP = 1;
const OPEN = "open";
const ACCEPTED = 202;
const ONE_ATTEMPT = 1;
const SERVER_ERROR = 500;
const PRIVATE_SPAN_PARENT = "4444444444444444";
const TRACE_ID_LENGTH = 32;
const FIRST_TRACE = 1;
const POLLING_ATTEMPTS = 100;
const POLLING_INTERVAL_MS = 5;
const TRACE_PATH = Object.freeze(["attributes", "context", "trace"]);

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isRecord(value) {
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
  return isRecord(value) ? value[name] : undefined;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} names
 * @returns {unknown}
 */
function readPath(value, names) {
  const [name, ...rest] = names;
  return name === undefined ? value : readPath(readField(value, name), rest);
}

/**
 * @param {unknown} event
 * @param {string} name
 * @returns {unknown}
 */
function traceField(event, name) {
  return readPath(event, [...TRACE_PATH, name]);
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJson(text) {
  /** @type {unknown} */
  const value = JSON.parse(text);
  return value;
}

/**
 * @param {string} body
 * @returns {readonly unknown[]}
 */
function eventsOf(body) {
  const events = readField(parseJson(body), "events");
  return isList(events) ? events : [];
}

/**
 * @param {readonly string[]} bodies
 * @returns {readonly unknown[]}
 */
function eventsOfBodies(bodies) {
  return bodies.flatMap((body) => eventsOf(body));
}

/**
 * @param {unknown} event
 * @returns {unknown}
 */
function eventType(event) {
  return readField(event, "type");
}

/**
 * @param {readonly unknown[]} events
 * @param {string} type
 * @returns {readonly unknown[]}
 */
function eventsOfType(events, type) {
  return events.filter((event) => eventType(event) === type);
}

/**
 * @param {readonly unknown[]} events
 * @param {string} type
 * @returns {unknown}
 */
function eventOfType(events, type) {
  return events.find((event) => eventType(event) === type);
}

/**
 * @param {readonly unknown[]} actual
 * @param {readonly unknown[]} expected
 * @returns {void}
 */
function assertSameMembers(actual, expected) {
  assert.equal(actual.length, expected.length);
  assert.deepEqual(new Set(actual), new Set(expected));
}

/**
 * @param {string} text
 * @param {readonly string[]} markers
 * @returns {void}
 */
function assertExcludes(text, markers) {
  for (const marker of markers) {
    assert.equal(text.includes(marker), false, `telemetry included ${marker}`);
  }
}

/**
 * @param {number} count
 * @returns {readonly string[]}
 */
function expectedTraceIds(count) {
  return Array.from({ length: count }, (_value, index) => String(index + FIRST_TRACE).repeat(TRACE_ID_LENGTH));
}

/**
 * @param {number} index
 * @param {string} flags
 * @returns {string}
 */
function traceparentFor(index, flags) {
  return `00-${String(index + FIRST_TRACE).repeat(TRACE_ID_LENGTH)}-${PRIVATE_SPAN_PARENT}-${flags}`;
}

/**
 * @param {() => Server} start
 * @returns {Promise<Listening>}
 */
async function listen(start) {
  const server = start();
  await once(server, "listening");
  const address = server.address();
  const port = isRecord(address) && typeof address.port === "number" ? address.port : NO_PORT;
  return {
    close: () => {
      server.closeAllConnections();
      server.close();
    },
    origin: `http://${HOST}:${String(port)}`,
    port
  };
}

/**
 * @param {TestContext} testContext
 * @param {() => Server} start
 * @returns {Promise<Listening>}
 */
async function serve(testContext, start) {
  const server = await listen(start);
  testContext.after(server.close);
  return server;
}

/**
 * @returns {Latch}
 */
function createLatch() {
  const target = new EventTarget();
  const opened = once(target, OPEN);
  /** @type {Outcome[]} */
  const outcomes = [];
  return {
    fail: (reason) => {
      outcomes.push({ failed: true, reason });
      target.dispatchEvent(new Event(OPEN));
    },
    open: () => {
      outcomes.push({ failed: false, reason: undefined });
      target.dispatchEvent(new Event(OPEN));
    },
    wait: async () => {
      await opened;
      const [first] = outcomes;
      if (first?.failed === true) {
        throw first.reason;
      }
    }
  };
}

/**
 * @returns {Counter}
 */
function createCounter() {
  let value = ZERO;
  return {
    add: () => {
      value += STEP;
    },
    value: () => value
  };
}

/**
 * @param {number} expected
 * @returns {FlushLatch}
 */
function createFlushLatch(expected) {
  const latch = createLatch();
  let flushes = NO_FLUSHES;
  return {
    count: () => flushes,
    onFlush: () => {
      flushes += STEP;
      if (flushes === expected) {
        latch.open();
      }
    },
    wait: latch.wait
  };
}

/**
 * @param {number} [statusCode]
 * @returns {TransportResponse}
 */
function transportResponse(statusCode = ACCEPTED) {
  return { attempts: ONE_ATTEMPT, statusCode };
}

/**
 * @param {(body: string) => number} [statusOf]
 * @returns {Recorder}
 */
function createRecorder(statusOf = () => ACCEPTED) {
  /** @type {string[]} */
  const bodies = [];
  return {
    bodies,
    transport: {
      send: async (_key, body) => {
        bodies.push(body);
        return transportResponse(statusOf(body));
      }
    }
  };
}

/**
 * @param {() => boolean} predicate
 * @param {Polling} polling
 * @returns {Promise<void>}
 */
async function poll(predicate, polling) {
  if (polling.attempts <= NO_ATTEMPTS) {
    assert.fail(polling.message);
  }
  if (predicate()) {
    return;
  }
  await delay(polling.intervalMs);
  await poll(predicate, { ...polling, attempts: polling.attempts - STEP });
}

/**
 * @param {() => boolean} predicate
 * @param {string} message
 * @returns {Promise<void>}
 */
async function waitFor(predicate, message) {
  await poll(predicate, { attempts: POLLING_ATTEMPTS, intervalMs: POLLING_INTERVAL_MS, message });
}

/**
 * @param {number} timeoutMs
 * @param {string} message
 * @param {AbortSignal} signal
 * @returns {Promise<never>}
 */
async function failAfter(timeoutMs, message, signal) {
  await delay(timeoutMs, undefined, { signal });
  throw new Error(message);
}

/**
 * @param {() => Promise<unknown>} wait
 * @param {number} timeoutMs
 * @param {string} message
 * @returns {Promise<void>}
 */
async function withinTimeout(wait, timeoutMs, message) {
  const controller = new AbortController();
  try {
    await Promise.race([wait(), failAfter(timeoutMs, message, controller.signal)]);
  } finally {
    controller.abort();
  }
}

/**
 * @param {Request} req
 * @returns {LogBrewExpressContext}
 */
function requestContext(req) {
  const context = req.logbrew;
  assert.ok(context !== undefined, "request has no LogBrew context");
  return context;
}

/**
 * @param {(error: unknown, res: Response) => void} handle
 * @returns {FinalErrorHandler}
 */
function finalErrorHandler(handle) {
  /**
   * @param {unknown} error
   * @param {Request} _req
   * @param {Response} res
   * @param {NextFunction} _next
   * @returns {void}
   */
  function finalError(error, _req, res, _next) {
    handle(error, res);
  }
  return finalError;
}

/**
 * @param {number} port
 * @param {string} requestText
 * @returns {Promise<void>}
 */
async function disconnectAfterFirstChunk(port, requestText) {
  const socket = connect(port, HOST);
  const closed = once(socket, "close");
  socket.once("connect", () => {
    socket.write(requestText);
  });
  socket.once("data", () => {
    socket.destroy();
  });
  await closed;
}

/**
 * @template Value
 * @param {Value} value
 * @returns {PromiseLike<Value>}
 */
function createThenable(value) {
  return {
    then: async (onFulfilled, onRejected) => {
      const settled = Promise.resolve(value);
      return settled.then(onFulfilled, onRejected);
    }
  };
}

/**
 * @param {unknown} value
 * @returns {never}
 */
function throwValue(value) {
  throw value;
}

export {
  ANY_PORT,
  HOST,
  SERVER_ERROR,
  assertExcludes,
  assertSameMembers,
  createCounter,
  createFlushLatch,
  createLatch,
  createRecorder,
  createThenable,
  disconnectAfterFirstChunk,
  eventOfType,
  eventType,
  eventsOf,
  eventsOfBodies,
  eventsOfType,
  expectedTraceIds,
  finalErrorHandler,
  isList,
  isRecord,
  listen,
  parseJson,
  readField,
  readPath,
  requestContext,
  serve,
  throwValue,
  traceField,
  traceparentFor,
  transportResponse,
  waitFor,
  withinTimeout
};
