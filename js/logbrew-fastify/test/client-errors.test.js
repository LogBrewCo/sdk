import assert from "node:assert/strict";
import fastify from "fastify";
import { logbrewFastifyPlugin } from "@logbrew/fastify";
import { once } from "node:events";
import test from "node:test";

/**
 * @import { TestContext } from "node:test"
 * @import { FastifyInstance } from "fastify"
 * @typedef {{ readonly events: readonly unknown[], readonly statusCode: number }} Delivery
 * @typedef {{ readonly method: "GET" | "POST", readonly payload?: Readonly<Record<string, string>>, readonly url: string }} Call
 * @typedef {{ readonly app: FastifyInstance, readonly bodies: readonly string[], readonly flushed: Promise<unknown> }} Run
 */

const SERVER_API_KEY = "LOGBREW_SERVER_API_KEY";
const FLUSHED = "flushed";
const ACCEPTED = 202;
const BAD_REQUEST = 400;
const NOT_FOUND = 404;
const SERVER_ERROR = 500;
const NONE = 0;
const ONE = 1;
const ITEM_SCHEMA = {
  body: { properties: { name: { type: "string" } }, required: ["name"], type: "object" }
};
/** @type {Call} */
const MISSING = { method: "GET", url: "/missing" };
/** @type {Call} */
const INVALID = { method: "POST", payload: {}, url: "/items" };

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
 * @param {readonly string[]} names
 * @returns {unknown}
 */
function readPath(value, names) {
  const [name, ...rest] = names;
  if (name === undefined) {
    return value;
  }
  return readPath(isRecord(value) ? value[name] : undefined, rest);
}

/**
 * @param {readonly string[]} bodies
 * @returns {readonly unknown[]}
 */
function eventsOf(bodies) {
  return bodies.flatMap((body) => {
    /** @type {unknown} */
    const batch = JSON.parse(body);
    const events = readPath(batch, ["events"]);
    return isList(events) ? events : [];
  });
}

/**
 * @param {Delivery} delivery
 * @param {string} type
 * @returns {readonly unknown[]}
 */
function eventsOfType(delivery, type) {
  return delivery.events.filter((event) => readPath(event, ["type"]) === type);
}

/**
 * @param {boolean} captureClientErrors
 * @returns {Promise<Run>}
 */
async function createRun(captureClientErrors) {
  /** @type {string[]} */
  const bodies = [];
  const flushes = new EventTarget();
  const flushed = once(flushes, FLUSHED);
  const app = fastify();
  await app.register(logbrewFastifyPlugin, {
    captureClientErrors,
    onFlush: () => {
      flushes.dispatchEvent(new Event(FLUSHED));
    },
    serverApiKey: SERVER_API_KEY,
    transport: {
      send: async (_key, body) => {
        bodies.push(body);
        return { attempts: ONE, statusCode: ACCEPTED };
      }
    }
  });
  app.get("/missing", async () => {
    throw Object.assign(new Error("Not Found"), { statusCode: NOT_FOUND });
  });
  app.post("/items", { schema: ITEM_SCHEMA }, async () => ({ ok: true }));
  app.get("/broken", async () => {
    throw new Error("route exploded");
  });
  return { app, bodies, flushed };
}

/**
 * @param {TestContext} testContext
 * @param {boolean} captureClientErrors
 * @param {Call} call
 * @returns {Promise<Delivery>}
 */
async function send(testContext, captureClientErrors, call) {
  const run = await createRun(captureClientErrors);
  testContext.after(async () => {
    await run.app.close();
  });
  const response = await run.app.inject(call);
  await run.flushed;
  return { events: eventsOf(run.bodies), statusCode: response.statusCode };
}

/**
 * @param {Delivery} delivery
 * @param {number} statusCode
 * @returns {void}
 */
function assertRequestSpanOnly(delivery, statusCode) {
  const [span] = eventsOfType(delivery, "span");
  assert.equal(delivery.statusCode, statusCode);
  assert.equal(eventsOfType(delivery, "issue").length, NONE);
  assert.equal(readPath(span, ["attributes", "metadata", "statusCode"]), statusCode);
}

void test("a thrown 404 stays a request span, not an issue", async (testContext) => {
  assertRequestSpanOnly(await send(testContext, false, MISSING), NOT_FOUND);
});

void test("a body validation error stays a request span, not an issue", async (testContext) => {
  assertRequestSpanOnly(await send(testContext, false, INVALID), BAD_REQUEST);
});

void test("an unknown route stays a request span, not an issue", async (testContext) => {
  assertRequestSpanOnly(await send(testContext, false, { method: "GET", url: "/no-such-page" }), NOT_FOUND);
});

void test("captureClientErrors reports errors with a 4xx status as issues", async (testContext) => {
  const missing = await send(testContext, true, MISSING);
  const invalid = await send(testContext, true, INVALID);
  assert.equal(eventsOfType(missing, "issue").length, ONE);
  assert.equal(eventsOfType(invalid, "issue").length, ONE);
});

void test("a server error still becomes an issue", async (testContext) => {
  const broken = await send(testContext, false, { method: "GET", url: "/broken" });
  assert.equal(broken.statusCode, SERVER_ERROR);
  assert.equal(eventsOfType(broken, "issue").length, ONE);
});
