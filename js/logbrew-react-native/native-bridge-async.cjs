"use strict";

const { SdkError } = require("@logbrew/sdk");
const { isCallable, isObjectLike } = require("./instrumentation-values.cjs");
const { bridgeClear, bridgeSetter, createLogBrewNativeBridgeScope } = require("./native-bridge-scope.cjs");

/**
 * @import { NativeBridgeCall, NativeBridgeScope, NativeBridgeScopeInput } from "./native-bridge-scope.cjs"
 * @import { Callable } from "./instrumentation-values.cjs"
 */

/**
 * @typedef {{ readonly clear: () => unknown, readonly payload: NativeBridgeScope, readonly sync: NativeBridgeCall }} PreparedScope
 */

/** @type {WeakMap<object, number>} */
const ASYNC_BRIDGE_PENDING = new WeakMap();
/** @type {WeakMap<object, PromiseLike<unknown>>} */
const ASYNC_BRIDGE_TAILS = new WeakMap();
const MAX_PENDING_ASYNC_SCOPES = 128;
const MAX_ASYNC_SCOPE_METADATA_ENTRIES = 64;
const MAX_ASYNC_SCOPE_JSON_LENGTH = 8192;
const NO_PENDING = 0;
const ONE_SCOPE = 1;

/**
 * @param {object} nativeBridge
 * @returns {void}
 */
function releaseAsyncScopeReservation(nativeBridge) {
  const pending = (ASYNC_BRIDGE_PENDING.get(nativeBridge) ?? ONE_SCOPE) - ONE_SCOPE;
  ASYNC_BRIDGE_PENDING.set(nativeBridge, pending);
  if (pending === NO_PENDING) {
    ASYNC_BRIDGE_PENDING.delete(nativeBridge);
    ASYNC_BRIDGE_TAILS.delete(nativeBridge);
  }
}

/**
 * @param {object} nativeBridge
 * @param {NativeBridgeScopeInput} options
 * @returns {PreparedScope}
 */
function prepareAsyncScope(nativeBridge, options) {
  try {
    const sync = bridgeSetter(nativeBridge);
    const clear = bridgeClear(nativeBridge, true);
    const payload = createLogBrewNativeBridgeScope(options);
    if (Object.keys(payload.metadata).length > MAX_ASYNC_SCOPE_METADATA_ENTRIES
      || JSON.stringify(payload).length > MAX_ASYNC_SCOPE_JSON_LENGTH) {
      throw new SdkError("native_scope_too_large", "async native bridge scope exceeds its payload limit");
    }
    return { clear, payload, sync };
  } catch (error) {
    releaseAsyncScopeReservation(nativeBridge);
    throw error;
  }
}

/**
 * @param {() => unknown} clear
 * @returns {Promise<boolean>}
 */
async function clearIgnoringFailure(clear) {
  try {
    await clear();
  } catch {
    return false;
  }
  return true;
}

/**
 * @param {PreparedScope} prepared
 * @param {Callable} work
 * @returns {Promise<unknown>}
 */
async function syncAndRunScopedWork({ clear, payload, sync }, work) {
  try {
    await sync(payload);
    return await work(payload);
  } catch (error) {
    await clearIgnoringFailure(clear);
    throw error;
  }
}

/**
 * @param {object} nativeBridge
 * @param {PreparedScope} prepared
 * @param {Callable} work
 * @returns {Promise<unknown>}
 */
async function runQueuedNativeBridgeScope(nativeBridge, prepared, work) {
  await (ASYNC_BRIDGE_TAILS.get(nativeBridge) ?? Promise.resolve());
  try {
    await prepared.clear();
    const result = await syncAndRunScopedWork(prepared, work);
    await prepared.clear();
    return result;
  } finally {
    releaseAsyncScopeReservation(nativeBridge);
  }
}

/**
 * @returns {undefined}
 */
function settledTurn() {
  return undefined;
}

/**
 * @param {Readonly<Promise<unknown>>} run
 * @returns {PromiseLike<unknown>}
 */
function queueTurn(run) {
  return run.then(settledTurn, settledTurn);
}

/**
 * @param {unknown} nativeBridge
 * @param {unknown} work
 * @returns {{ readonly bridge: object, readonly scopedWork: Callable }}
 */
function requireAsyncScopeTarget(nativeBridge, work) {
  if (!isCallable(work)) {
    throw new SdkError("configuration_error", "withLogBrewNativeBridgeScopeAsync requires a callback");
  }
  if (!isObjectLike(nativeBridge)) {
    throw new SdkError("configuration_error", "async native bridge scope requires an adapter object or function");
  }
  return { bridge: nativeBridge, scopedWork: work };
}

/**
 * @param {object} nativeBridge
 * @returns {void}
 */
function reserveAsyncScope(nativeBridge) {
  const pending = ASYNC_BRIDGE_PENDING.get(nativeBridge) ?? NO_PENDING;
  if (pending >= MAX_PENDING_ASYNC_SCOPES) {
    throw new SdkError("native_scope_queue_full", "async native bridge scope queue is full");
  }
  ASYNC_BRIDGE_PENDING.set(nativeBridge, pending + ONE_SCOPE);
}

/**
 * @param {unknown} nativeBridge
 * @param {NativeBridgeScopeInput | Callable | null | undefined} options
 * @param {unknown} [work]
 * @returns {Promise<unknown>}
 */
async function withLogBrewNativeBridgeScopeAsync(nativeBridge, options, work) {
  const resolvedOptions = typeof options === "function" ? {} : options ?? {};
  const resolvedWork = typeof options === "function" ? options : work;
  const { bridge, scopedWork } = requireAsyncScopeTarget(nativeBridge, resolvedWork);
  reserveAsyncScope(bridge);
  const prepared = prepareAsyncScope(bridge, resolvedOptions);
  const run = runQueuedNativeBridgeScope(bridge, prepared, scopedWork);
  ASYNC_BRIDGE_TAILS.set(bridge, queueTurn(run));
  return run;
}

module.exports = { withLogBrewNativeBridgeScopeAsync };
