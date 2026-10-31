import { isCount, isRecord, nativeMethod } from "./native-diagnostics-values.js";
import { lookupNativeModule, platformOS } from "./native-module-lookup.js";
import { SdkError } from "@logbrew/sdk";

/**
 * @import {
 *   LogBrewAppleNativeCrashContextResult,
 *   LogBrewAppleNativeDiagnosticsReplayResult,
 *   LogBrewAppleNativeDiagnosticsStatus
 * } from "./apple-native-diagnostics.js"
 * @typedef {LogBrewAppleNativeDiagnosticsStatus["status"]} AppleStatus
 * @typedef {LogBrewAppleNativeDiagnosticsStatus["lifecycle"]} AppleLifecycle
 * @typedef {Readonly<{ method: string, label: string }>} SnapshotTarget
 */

/** @type {ReadonlySet<string>} */
const LIFECYCLE_STATUSES = new Set([
  "failed",
  "idle",
  "installed",
  "replaying",
  "stopped",
  "unknown"
]);
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,128}$/u;
const SNAPSHOT_RESULT_KEYS = 1;

function requireApplePlatform() {
  if (platformOS() !== "ios") {
    throw new SdkError(
      "unsupported_platform",
      "LogBrew Apple native diagnostics are available only in an iOS native build"
    );
  }
}

/**
 * @returns {unknown}
 */
function appleDiagnosticsModule() {
  try {
    return lookupNativeModule("LogBrewAppleDiagnostics");
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFalsy(value) {
  const present = Boolean(value);
  return !present;
}

/**
 * @returns {unknown}
 */
function requireNativeModule() {
  const nativeModule = appleDiagnosticsModule();
  if (isFalsy(nativeModule)) {
    throw new SdkError(
      "native_diagnostics_unavailable",
      "LogBrew Apple native diagnostics require the AppleDiagnostics CocoaPods subspec; Expo projects can add @logbrew/react-native/expo"
    );
  }
  return nativeModule;
}

/**
 * @param {unknown} nativeModule
 * @param {string} method
 * @param {readonly unknown[]} args
 * @returns {unknown}
 */
function callNative(nativeModule, method, ...args) {
  const native = nativeMethod(nativeModule, method, args);
  if (!native.found) {
    throw new SdkError(
      "native_diagnostics_unavailable",
      `linked LogBrew Apple diagnostics do not implement ${method}`
    );
  }
  try {
    return native.call();
  } catch {
    throw new SdkError(
      "native_diagnostics_failed",
      `LogBrew Apple native diagnostics ${method} failed`
    );
  }
}

/**
 * @param {unknown} result
 * @returns {string | undefined}
 */
function errorResultCode(result) {
  const code = isRecord(result) && result["status"] === "error" ? result["code"] : undefined;
  return typeof code === "string" && ERROR_CODE_PATTERN.test(code) ? code : undefined;
}

/**
 * @param {unknown} nativeModule
 * @param {unknown} payload
 * @param {SnapshotTarget} target
 * @returns {LogBrewAppleNativeCrashContextResult}
 */
function updateNativeSnapshot(nativeModule, payload, target) {
  const result = callNative(nativeModule, target.method, payload);
  const expectedStatus = payload === null ? "cleared" : "updated";
  const code = errorResultCode(result);
  if (code !== undefined) {
    throw new SdkError(code, `LogBrew Apple native diagnostics ${target.label} failed with ${code}`);
  }
  if (!isRecord(result)
    || Object.keys(result).length !== SNAPSHOT_RESULT_KEYS
    || result["status"] !== expectedStatus) {
    throw new SdkError(
      "native_diagnostics_invalid_response",
      `LogBrew Apple native diagnostics ${target.label} returned an invalid response`
    );
  }
  return Object.freeze({ status: expectedStatus });
}

/**
 * @param {unknown} snapshot
 * @returns {LogBrewAppleNativeCrashContextResult}
 */
function syncLogBrewAppleNativeCrashBreadcrumbs(snapshot) {
  requireApplePlatform();
  return updateNativeSnapshot(
    requireNativeModule(),
    snapshot,
    { label: "breadcrumbs", method: "setNativeDiagnosticsBreadcrumbs" }
  );
}

/**
 * @param {unknown} value
 * @param {Readonly<ReadonlySet<string>>} allowed
 * @returns {value is AppleStatus}
 */
function isAllowedStatus(value, allowed) {
  return typeof value === "string" && allowed.has(value);
}

/**
 * @param {unknown} value
 * @returns {value is AppleLifecycle}
 */
function isLifecycle(value) {
  return typeof value === "string" && LIFECYCLE_STATUSES.has(value);
}

/**
 * @param {string} operation
 * @param {unknown} result
 * @param {Readonly<ReadonlySet<string>>} allowedStatuses
 * @returns {LogBrewAppleNativeDiagnosticsStatus}
 */
function requireStatusResult(operation, result, allowedStatuses) {
  const code = errorResultCode(result);
  if (code !== undefined) {
    throw new SdkError(code, `LogBrew Apple native diagnostics ${operation} failed with ${code}`);
  }
  const status = isRecord(result) ? result["status"] : undefined;
  const lifecycle = isRecord(result) ? result["lifecycle"] : undefined;
  if (!isRecord(result)
    || !isAllowedStatus(status, allowedStatuses)
    || !isLifecycle(lifecycle)
    || !isCount(result["pending"])
    || !isCount(result["acknowledged"])
    || !isCount(result["discarded"])) {
    throw new SdkError(
      "native_diagnostics_invalid_response",
      `LogBrew Apple native diagnostics ${operation} returned an invalid response`
    );
  }
  return Object.freeze({
    acknowledged: result["acknowledged"],
    discarded: result["discarded"],
    lifecycle,
    pending: result["pending"],
    status
  });
}

/**
 * @param {unknown} result
 * @returns {LogBrewAppleNativeDiagnosticsReplayResult}
 */
function requireReplayResult(result) {
  const code = errorResultCode(result);
  if (code !== undefined) {
    throw new SdkError(code, `LogBrew Apple native diagnostics replay failed with ${code}`);
  }
  if (!isRecord(result)
    || result["status"] !== "replayed"
    || !isCount(result["attempted"])
    || !isCount(result["acknowledged"])
    || !isCount(result["discarded"])
    || !isCount(result["pending"])
    || result["acknowledged"] + result["discarded"] > result["attempted"]) {
    throw new SdkError(
      "native_diagnostics_invalid_response",
      "LogBrew Apple native diagnostics replay returned an invalid response"
    );
  }
  return Object.freeze({
    acknowledged: result["acknowledged"],
    attempted: result["attempted"],
    discarded: result["discarded"],
    pending: result["pending"],
    status: result["status"]
  });
}

export {
  callNative,
  requireApplePlatform,
  requireNativeModule,
  requireReplayResult,
  requireStatusResult,
  syncLogBrewAppleNativeCrashBreadcrumbs,
  updateNativeSnapshot
};
