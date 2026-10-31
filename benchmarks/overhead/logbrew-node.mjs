import { createLogBrewNodeClient, createLogBrewTraceContext } from "@logbrew/node";
import { countLogBrewDelivered } from "./delivered.js";
import { createIssueAttributesFromError } from "@logbrew/sdk";
import { randomUUID } from "node:crypto";

/**
 * @import { LogBrewClient, TransportResponse } from "@logbrew/sdk"
 * @import { Bench } from "./loop.js"
 */

/** @type {string[]} */
const bodies = [];
const DELIVERED = { attempts: 1, statusCode: 202 };
/** @type {{ client: LogBrewClient | undefined }} */
const state = { client: undefined };

/**
 * @param {string} _key
 * @param {string} body
 * @returns {Promise<TransportResponse>}
 */
async function send(_key, body) {
  bodies.push(body);
  return DELIVERED;
}

/**
 * @returns {LogBrewClient}
 */
function requireClient() {
  if (state.client === undefined) {
    throw new Error("call init first");
  }
  return state.client;
}

/** @type {Bench} */
const bench = {
  delivered: (signal) => countLogBrewDelivered(bodies, signal),
  error(error) {
    requireClient().issue(randomUUID(), new Date().toISOString(), createIssueAttributesFromError(error));
  },
  flush: async () => requireClient().flush(),
  init() {
    state.client = createLogBrewNodeClient({ apiKey: "LOGBREW_API_KEY", transport: { send } });
  },
  span(name) {
    const trace = createLogBrewTraceContext();
    const start = performance.now();
    requireClient().span(randomUUID(), new Date().toISOString(), {
      durationMs: performance.now() - start,
      name,
      spanId: trace.spanId,
      status: "ok",
      traceId: trace.traceId
    });
  }
};

export { bench };
