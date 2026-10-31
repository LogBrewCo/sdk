"use strict";

const { nativeBridgeRuntime } = require("./instrumentation-runtime.cjs");

/**
 * @typedef {() => unknown} Remover
 * @typedef {{
 *   readonly add: (remover: Remover) => void,
 *   readonly markNativeScopeApplied: () => void,
 *   readonly removeAfterSetupFailure: (nativeBridge: unknown) => boolean,
 *   readonly removeAll: (nativeBridge: unknown) => void
 * }} InstrumentationTeardown
 * @typedef {{ readonly failed: Remover[], readonly failures: unknown[] }} RemovalOutcome
 */

const NO_FAILURES = 0;

/**
 * @param {unknown} nativeBridge
 * @returns {unknown[]}
 */
function clearNativeBridgeFailures(nativeBridge) {
  const hasNativeBridge = Boolean(nativeBridge);
  if (!hasNativeBridge) {
    return [];
  }
  try {
    nativeBridgeRuntime.clearLogBrewNativeBridgeScope(nativeBridge);
    return [];
  } catch (error) {
    return [error];
  }
}

/**
 * @param {unknown} nativeBridge
 * @param {readonly Remover[]} pending
 * @returns {RemovalOutcome}
 */
function runRemovers(nativeBridge, pending) {
  const failures = clearNativeBridgeFailures(nativeBridge);
  /** @type {Remover[]} */
  const failed = [];
  for (const removeListener of pending) {
    try {
      removeListener();
    } catch (error) {
      failed.push(removeListener);
      failures.push(error);
    }
  }
  return { failed, failures };
}

/**
 * @returns {InstrumentationTeardown}
 */
function createInstrumentationTeardown() {
  /** @type {Remover[]} */
  const removers = [];
  let nativeScopeApplied = false;
  /**
   * @param {unknown} nativeBridge
   * @returns {void}
   */
  function removeConfigured(nativeBridge) {
    const { failed, failures } = runRemovers(nativeBridge, removers.splice(NO_FAILURES));
    removers.push(...failed);
    const [firstFailure] = failures;
    if (failures.length > NO_FAILURES) {
      throw firstFailure;
    }
  }
  return {
    add: (remover) => {
      removers.unshift(remover);
    },
    markNativeScopeApplied: () => {
      nativeScopeApplied = true;
    },
    removeAfterSetupFailure: (nativeBridge) => {
      try {
        removeConfigured(nativeScopeApplied ? nativeBridge : undefined);
        return true;
      } catch {
        return false;
      }
    },
    removeAll: removeConfigured
  };
}

module.exports = { createInstrumentationTeardown };
