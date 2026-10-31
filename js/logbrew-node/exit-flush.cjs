"use strict";

const { isTruthy, readMember } = require("./internal.cjs");

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

/**
 * @typedef {{
 *   client: WeakRef<LogBrewClient>,
 *   abortDelivery: (() => void) | undefined,
 *   failed: boolean,
 *   inFlight: boolean
 * }} ExitFlushEntry
 */

const EXIT_FLUSH_TIMEOUT_MS = 2000;
const NO_EVENTS = 0;
/** @type {Set<ExitFlushEntry>} */
const exitFlushes = new Set();
/** @type {FinalizationRegistry<ExitFlushEntry>} */
const exitFlushRegistry = new FinalizationRegistry((entry) => {
  exitFlushes.delete(entry);
});
const listener = { listening: false };

/**
 * @param {ExitFlushEntry} entry
 * @param {LogBrewClient} client
 * @returns {Promise<void>}
 */
async function flushBeforeExit(entry, client) {
  const { abortDelivery } = entry;
  const deadline = abortDelivery === undefined ? undefined : setTimeout(abortDelivery, EXIT_FLUSH_TIMEOUT_MS).unref();
  try {
    await client.flush();
  } catch {
    entry.failed = true;
  } finally {
    clearTimeout(deadline);
    entry.inFlight = false;
  }
}

/**
 * @param {ExitFlushEntry} entry
 * @returns {void}
 */
function flushPendingClient(entry) {
  const client = entry.client.deref();
  if (client === undefined || isTruthy(readMember(client, "closed"))) {
    exitFlushes.delete(entry);
    return;
  }
  if (entry.failed || entry.inFlight || isTruthy(readMember(client, "closing")) || client.pendingEvents() === NO_EVENTS) {
    return;
  }
  entry.inFlight = true;
  void flushBeforeExit(entry, client);
}

/**
 * @returns {void}
 */
function flushPendingClients() {
  for (const entry of exitFlushes) {
    flushPendingClient(entry);
  }
}

/**
 * @param {LogBrewClient} client
 * @param {(() => void) | undefined} abortDelivery
 * @returns {void}
 */
function flushOnExit(client, abortDelivery) {
  /** @type {ExitFlushEntry} */
  const entry = { abortDelivery, client: new WeakRef(client), failed: false, inFlight: false };
  exitFlushes.add(entry);
  exitFlushRegistry.register(client, entry);
  if (!listener.listening) {
    listener.listening = true;
    process.on("beforeExit", flushPendingClients);
  }
}

module.exports = { flushOnExit };
