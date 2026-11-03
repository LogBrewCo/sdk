import "reflect-metadata";
import { Controller, Get, Module, NotFoundException, Param, ParseIntPipe } from "@nestjs/common";
import { LogBrewInterceptor } from "@logbrew/nestjs";
import { NestFactory } from "@nestjs/core";
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

/**
 * @import { TestContext } from "node:test"
 * @import { INestApplication } from "@nestjs/common"
 * @typedef {{ readonly events: readonly unknown[], readonly statusCode: number }} Delivery
 * @typedef {{ readonly app: INestApplication, readonly bodies: readonly string[], readonly flushed: Promise<unknown> }} Run
 */

const SERVER_API_KEY = "LOGBREW_SERVER_API_KEY";
const FLUSHED = "flushed";
const HOST = "127.0.0.1";
const ANY_PORT = 0;
const ID_ARGUMENT = 0;
const ACCEPTED = 202;
const BAD_REQUEST = 400;
const NOT_FOUND = 404;
const SERVER_ERROR = 500;
const NONE = 0;
const ONE = 1;

class ItemsController {
  /**
   * @returns {never}
   */
  missing() {
    throw new NotFoundException("Item not found");
  }

  /**
   * @param {number} id
   * @returns {{ readonly id: number }}
   */
  item(id) {
    return { id };
  }

  /**
   * @returns {never}
   */
  broken() {
    throw new Error("route exploded");
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @returns {void}
 */
function route(method, path) {
  const descriptor = Object.getOwnPropertyDescriptor(ItemsController.prototype, method);
  assert.notEqual(descriptor, undefined);
  if (descriptor !== undefined) {
    Get(path)(ItemsController.prototype, method, descriptor);
  }
}

Controller()(ItemsController);
route("missing", "/missing");
route("item", "/items/:id");
route("broken", "/broken");
Param("id", ParseIntPipe)(ItemsController.prototype, "item", ID_ARGUMENT);

class ItemsModule {}
Module({ controllers: [ItemsController] })(ItemsModule);

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
  const app = await NestFactory.create(ItemsModule, { logger: false });
  app.useGlobalInterceptors(new LogBrewInterceptor({
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
  }));
  return { app, bodies, flushed };
}

/**
 * @param {TestContext} testContext
 * @param {boolean} captureClientErrors
 * @param {string} path
 * @returns {Promise<Delivery>}
 */
async function send(testContext, captureClientErrors, path) {
  const run = await createRun(captureClientErrors);
  testContext.after(async () => {
    await run.app.close();
  });
  await run.app.listen(ANY_PORT, HOST);
  const response = await fetch(`${await run.app.getUrl()}${path}`);
  await response.arrayBuffer();
  await run.flushed;
  return { events: eventsOf(run.bodies), statusCode: response.status };
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

void test("a NotFoundException stays a request span, not an issue", async (testContext) => {
  assertRequestSpanOnly(await send(testContext, false, "/missing"), NOT_FOUND);
});

void test("a failed validation pipe stays a request span, not an issue", async (testContext) => {
  assertRequestSpanOnly(await send(testContext, false, "/items/abc"), BAD_REQUEST);
});

void test("captureClientErrors reports errors with a 4xx status as issues", async (testContext) => {
  const missing = await send(testContext, true, "/missing");
  const invalid = await send(testContext, true, "/items/abc");
  assert.equal(eventsOfType(missing, "issue").length, ONE);
  assert.equal(eventsOfType(invalid, "issue").length, ONE);
});

void test("a server error still becomes an issue", async (testContext) => {
  const broken = await send(testContext, false, "/broken");
  assert.equal(broken.statusCode, SERVER_ERROR);
  assert.equal(eventsOfType(broken, "issue").length, ONE);
});
