import { captureBrowserError, createBrowserTraceContext, installLogBrewBrowser } from "@logbrew/browser";
import { countLogBrewDelivered } from "./delivered.js";

/**
 * @import { LogBrewBrowserContext } from "@logbrew/browser"
 * @import { TransportResponse } from "@logbrew/sdk"
 * @import { Bench } from "./loop.js"
 */

/** @type {string[]} */
const bodies = [];
const DELIVERED = { attempts: 1, statusCode: 202 };
/** @type {{ logbrew: LogBrewBrowserContext | undefined }} */
const state = { logbrew: undefined };

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
 * @returns {LogBrewBrowserContext}
 */
function requireLogBrew() {
  if (state.logbrew === undefined) {
    throw new Error("call init first");
  }
  return state.logbrew;
}

/** @type {Bench} */
const bench = {
  delivered: (signal) => countLogBrewDelivered(bodies, signal),
  error(error) {
    void captureBrowserError(error, requireLogBrew());
  },
  flush: async () => requireLogBrew().flush(),
  init() {
    state.logbrew = installLogBrewBrowser({ clientKey: "LOGBREW_BROWSER_KEY", transport: { send } });
  },
  span(name) {
    const trace = createBrowserTraceContext();
    const start = performance.now();
    requireLogBrew().client.span(crypto.randomUUID(), new Date().toISOString(), {
      durationMs: performance.now() - start,
      name,
      spanId: trace.spanId,
      status: "ok",
      traceId: trace.traceId
    });
  }
};

export { bench };
