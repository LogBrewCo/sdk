const { SdkError } = require("@logbrew/sdk");
const { isCallable, readField } = require("./instrumentation-values.cjs");
const { bridgeClear, bridgeSetter, createLogBrewNativeBridgeScope } = require("./native-bridge-scope.cjs");
const { withLogBrewNativeBridgeScopeAsync } = require("./native-bridge-async.cjs");

/**
 * @import { NativeBridgeScope, NativeBridgeScopeInput } from "./native-bridge-scope.cjs"
 * @import { Callable } from "./instrumentation-values.cjs"
 */

/**
 * @typedef {{ readonly settled: boolean, readonly value: unknown }} ScopeOutcome
 */

/**
 * @param {unknown} nativeBridge
 * @returns {void}
 */
function clearLogBrewNativeBridgeScope(nativeBridge) {
  bridgeClear(nativeBridge)();
}

/**
 * @param {unknown} nativeBridge
 * @returns {boolean}
 */
function clearPreservingFailure(nativeBridge) {
  try {
    clearLogBrewNativeBridgeScope(nativeBridge);
  } catch {
    return false;
  }
  return true;
}

/**
 * @param {unknown} nativeBridge
 * @param {NativeBridgeScopeInput} [options]
 * @returns {NativeBridgeScope}
 */
function syncLogBrewNativeBridgeScope(nativeBridge, options = {}) {
  const payload = createLogBrewNativeBridgeScope(options);
  const sync = bridgeSetter(nativeBridge);
  try {
    sync(payload);
  } catch (error) {
    clearPreservingFailure(nativeBridge);
    throw error;
  }
  return payload;
}

/**
 * @param {unknown} nativeBridge
 * @param {unknown} result
 * @returns {PromiseLike<unknown>}
 */
function settleScopePromise(nativeBridge, result) {
  /**
   * @param {unknown} value
   * @returns {unknown}
   */
  function clearAfterValue(value) {
    clearLogBrewNativeBridgeScope(nativeBridge);
    return value;
  }

  /**
   * @param {unknown} error
   * @returns {never}
   */
  function clearAfterFailure(error) {
    clearPreservingFailure(nativeBridge);
    throw error;
  }

  return Promise.resolve(result).then(clearAfterValue, clearAfterFailure);
}

/**
 * @param {unknown} nativeBridge
 * @param {Callable} work
 * @param {NativeBridgeScope} payload
 * @returns {ScopeOutcome}
 */
function runScopeCallback(nativeBridge, work, payload) {
  try {
    const result = work(payload);
    if (isCallable(readField(result, "then"))) {
      return { settled: false, value: settleScopePromise(nativeBridge, result) };
    }
    return { settled: true, value: result };
  } catch (error) {
    clearPreservingFailure(nativeBridge);
    throw error;
  }
}

/**
 * @param {unknown} nativeBridge
 * @param {NativeBridgeScopeInput | Callable | null | undefined} options
 * @param {unknown} [work]
 * @returns {unknown}
 */
function withLogBrewNativeBridgeScope(nativeBridge, options, work) {
  const resolvedOptions = typeof options === "function" ? {} : options ?? {};
  const resolvedWork = typeof options === "function" ? options : work;
  if (!isCallable(resolvedWork)) {
    throw new SdkError("configuration_error", "withLogBrewNativeBridgeScope requires a callback");
  }

  const payload = syncLogBrewNativeBridgeScope(nativeBridge, resolvedOptions);
  const outcome = runScopeCallback(nativeBridge, resolvedWork, payload);
  if (outcome.settled) {
    clearLogBrewNativeBridgeScope(nativeBridge);
  }
  return outcome.value;
}

const defaultExport = {
  clearLogBrewNativeBridgeScope,
  createLogBrewNativeBridgeScope,
  syncLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScopeAsync
};

module.exports = { ...defaultExport, default: defaultExport };
