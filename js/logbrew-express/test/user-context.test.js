import {
  ANY_PORT,
  HOST,
  SERVER_ERROR,
  assertSameMembers,
  createFlushLatch,
  createRecorder,
  eventOfType,
  eventType,
  eventsOf,
  finalErrorHandler,
  readPath,
  requestContext,
  serve
} from "./support.js";
import { logbrewErrorHandler, logbrewMiddleware, withLogBrewExpressHandler } from "@logbrew/express";
import assert from "node:assert/strict";
import express from "express";
import test from "node:test";

/**
 * @import { TestContext } from "node:test"
 * @import { Express, Request, Response } from "express"
 * @import { FlushLatch, Recorder } from "./support.js"
 */

const SERVER_API_KEY = "LOGBREW_SERVER_API_KEY";
const USER_ID = "user-42";
const REQUESTS = 2;

/**
 * @param {Request} req
 * @returns {Promise<never>}
 */
async function failAccount(req) {
  assert.equal(requestContext(req).setUser(USER_ID), true);
  await Promise.resolve();
  throw new Error("account failed");
}

/**
 * @param {Request} _req
 * @param {Response} res
 * @returns {void}
 */
function sendHealth(_req, res) {
  res.json({ ok: true });
}

/**
 * @param {Recorder} recorder
 * @param {FlushLatch} flushes
 * @returns {Express}
 */
function createAccountApp(recorder, flushes) {
  const app = express();
  app.use(logbrewMiddleware({ onFlush: flushes.onFlush, serverApiKey: SERVER_API_KEY, transport: recorder.transport }));
  app.get("/account", withLogBrewExpressHandler(failAccount));
  app.get("/health", sendHealth);
  app.use(logbrewErrorHandler({ serverApiKey: SERVER_API_KEY }));
  app.use(finalErrorHandler((_error, res) => {
    res.status(SERVER_ERROR).end();
  }));
  return app;
}

/**
 * @param {TestContext} testContext
 * @returns {Promise<readonly string[]>}
 */
async function serveAccountAndHealth(testContext) {
  const recorder = createRecorder();
  const flushes = createFlushLatch(REQUESTS);
  const app = createAccountApp(recorder, flushes);
  const server = await serve(testContext, () => app.listen(ANY_PORT, HOST));
  await fetch(`${server.origin}/account`);
  await fetch(`${server.origin}/health`);
  await flushes.wait();
  return recorder.bodies;
}

void test("req.logbrew.setUser tags every event of its own request and no other request", async (testContext) => {
  const bodies = await serveAccountAndHealth(testContext);
  const account = bodies.find((body) => eventOfType(eventsOf(body), "issue") !== undefined);
  const health = bodies.find((body) => body !== account);
  assert.ok(account !== undefined && health !== undefined);
  assertSameMembers(eventsOf(account).map((event) => eventType(event)), ["issue", "span"]);
  for (const event of eventsOf(account)) {
    assert.deepEqual(readPath(event, ["attributes", "context", "subject"]), { id: USER_ID, kind: "user" });
  }
  assert.equal(health.includes("subject"), false);
});
