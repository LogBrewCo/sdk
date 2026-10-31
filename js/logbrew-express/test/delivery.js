import { ANY_PORT, HOST, serve } from "./support.js";
import { RecordingTransport } from "@logbrew/sdk";
import assert from "node:assert/strict";
import { createNodeFetchTransport } from "@logbrew/node";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";

/**
 * @import { IncomingMessage, Server, ServerResponse } from "node:http"
 * @import { TestContext } from "node:test"
 * @import { Transport } from "@logbrew/sdk"
 * @typedef {{ readonly body: () => string | undefined, readonly count: () => number, readonly transport: Transport }} Delivery
 * @typedef {{ readonly apiKey: string, readonly record: (body: string) => void }} Collection
 */

const ACCEPTED = 202;
const LAST = -1;

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {Collection} collection
 * @returns {Promise<void>}
 */
async function collect(req, res, collection) {
  const { apiKey, record } = collection;
  assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
  record(await text(req));
  res.writeHead(ACCEPTED);
  res.end();
}

/**
 * @param {Collection} collection
 * @returns {Server}
 */
function createCollector(collection) {
  return createServer((req, res) => {
    void collect(req, res, collection);
  });
}

/**
 * @param {TestContext} testContext
 * @param {string} apiKey
 * @returns {Promise<Delivery>}
 */
async function createNetworkDelivery(testContext, apiKey) {
  /** @type {string[]} */
  const bodies = [];
  /**
   * @param {string} body
   * @returns {void}
   */
  function record(body) {
    bodies.push(body);
  }
  const collector = await serve(testContext, () => createCollector({ apiKey, record }).listen(ANY_PORT, HOST));
  return {
    body: () => bodies.at(LAST),
    count: () => bodies.length,
    transport: createNodeFetchTransport({ endpoint: `${collector.origin}/v1/events` })
  };
}

/**
 * @returns {Delivery}
 */
function createRecordingDelivery() {
  const transport = RecordingTransport.alwaysAccept();
  return { body: () => transport.lastBody() ?? undefined, count: () => transport.sentBodies.length, transport };
}

export { createNetworkDelivery, createRecordingDelivery };
