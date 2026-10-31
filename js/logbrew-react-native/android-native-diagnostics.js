import { hasControlCharacter, isCount, isRecord, nativeMethod, utf8Length } from "./native-diagnostics-values.js";
import { lookupNativeModule, platformOS } from "./native-module-lookup.js";
import { SdkError } from "@logbrew/sdk";

/**
 * @import { LogBrewAndroidNativeDiagnosticsReceipt } from "./android-native-diagnostics.js"
 * @typedef {LogBrewAndroidNativeDiagnosticsReceipt["status"]} ReceiptStatus
 */

const INSTALL_KEYS = new Set([
  "anrThresholdMs",
  "clientKey",
  "environment",
  "fatalHandlerOwnership",
  "projectId",
  "release",
  "service"
]);
const RECEIPT_KEYS = new Set(["pending", "status"]);
/** @type {ReadonlySet<string>} */
const INSTALL_STATUSES = new Set(["already_installed", "installed"]);
/** @type {ReadonlySet<string>} */
const STATUS_STATUSES = new Set(["not_installed", "ready"]);
/** @type {ReadonlySet<string>} */
const UNINSTALL_STATUSES = new Set(["not_installed", "uninstalled"]);
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,128}$/u;
const DEFAULT_ANR_THRESHOLD_MS = 5000;
const MIN_ANR_THRESHOLD_MS = 2000;
const MAX_ANR_THRESHOLD_MS = 60_000;
const PROJECT_ID_BYTES = 64;
const CLIENT_KEY_BYTES = 4096;
const ENVIRONMENT_BYTES = 128;
const RELEASE_BYTES = 256;
const SCOPE_BYTES = 128;
const EMPTY_LENGTH = 0;

/**
 * @param {string} message
 * @returns {SdkError}
 */
function configurationError(message) {
  return new SdkError("configuration_error", `LogBrew Android native diagnostics ${message}`);
}

/**
 * @param {unknown} value
 * @param {number} maximumBytes
 * @param {string} name
 * @returns {string}
 */
function exactText(value, maximumBytes, name) {
  if (typeof value !== "string"
    || value.length === EMPTY_LENGTH
    || value.trim() !== value
    || hasControlCharacter(value)
    || utf8Length(value) > maximumBytes) {
    throw configurationError(`${name} must be a bounded non-empty string`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function exactScope(value, name) {
  const text = exactText(value, SCOPE_BYTES, name);
  if (!SCOPE_PATTERN.test(text)
    || text.includes("..")
    || text.includes("//")) {
    throw configurationError(`${name} must be a bounded deployment identifier`);
  }
  return text;
}

/**
 * @param {unknown} threshold
 * @returns {number}
 */
function anrThreshold(threshold) {
  if (typeof threshold !== "number"
    || !Number.isSafeInteger(threshold)
    || threshold < MIN_ANR_THRESHOLD_MS
    || threshold > MAX_ANR_THRESHOLD_MS) {
    throw configurationError("anrThresholdMs must be an integer from 2000 through 60000");
  }
  return threshold;
}

/**
 * @param {unknown} value
 * @returns {Readonly<Record<string, unknown>>}
 */
function knownConfiguration(value) {
  if (!isRecord(value)) {
    throw configurationError("configuration must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!INSTALL_KEYS.has(key)) {
      throw configurationError("configuration contains an unsupported key");
    }
  }
  if (value["fatalHandlerOwnership"] !== "logbrew") {
    throw configurationError(
      "fatalHandlerOwnership must be logbrew after removing every other Android fatal handler"
    );
  }
  return value;
}

/**
 * @param {unknown} configuration
 * @returns {Record<string, unknown>}
 */
function normalizeConfiguration(configuration) {
  const value = knownConfiguration(configuration);
  const projectId = exactText(value["projectId"], PROJECT_ID_BYTES, "projectId");
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw configurationError("projectId must be a lowercase UUID");
  }
  const threshold = anrThreshold(value["anrThresholdMs"] ?? DEFAULT_ANR_THRESHOLD_MS);
  return {
    anrThresholdMs: threshold,
    clientKey: exactText(value["clientKey"], CLIENT_KEY_BYTES, "clientKey"),
    environment: exactText(value["environment"], ENVIRONMENT_BYTES, "environment"),
    fatalHandlerOwnership: "logbrew",
    projectId,
    release: exactText(value["release"], RELEASE_BYTES, "release"),
    service: exactScope(value["service"], "service")
  };
}

function requireAndroid() {
  if (platformOS() !== "android") {
    throw new SdkError(
      "unsupported_platform",
      "LogBrew Android native diagnostics require an Android native build"
    );
  }
}

/**
 * @returns {unknown}
 */
function fatalStoreModule() {
  try {
    return lookupNativeModule("LogBrewFatalStore");
  } catch {
    return undefined;
  }
}

/**
 * @param {string} method
 * @param {readonly unknown[]} args
 * @returns {unknown}
 */
function call(method, ...args) {
  const native = nativeMethod(fatalStoreModule(), method, args);
  if (!native.found) {
    throw new SdkError(
      "native_diagnostics_unavailable",
      `linked LogBrew Android diagnostics do not implement ${method}`
    );
  }
  try {
    return native.call();
  } catch {
    throw new SdkError(
      "native_diagnostics_failed",
      `LogBrew Android native diagnostics ${method} failed`
    );
  }
}

/**
 * @param {unknown} value
 * @param {Readonly<ReadonlySet<string>>} statuses
 * @returns {value is Readonly<{ pending: number, status: ReceiptStatus }>}
 */
function isReceipt(value, statuses) {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === RECEIPT_KEYS.size
    && keys.every(key => RECEIPT_KEYS.has(key))
    && typeof value["status"] === "string"
    && statuses.has(value["status"])
    && isCount(value["pending"]);
}

/**
 * @param {string} operation
 * @param {unknown} value
 * @param {Readonly<ReadonlySet<string>>} statuses
 * @returns {LogBrewAndroidNativeDiagnosticsReceipt}
 */
function receipt(operation, value, statuses) {
  const code = isRecord(value) && value["status"] === "error" ? value["code"] : undefined;
  if (typeof code === "string" && ERROR_CODE_PATTERN.test(code)) {
    throw new SdkError(
      code,
      `LogBrew Android native diagnostics ${operation} failed with ${code}`
    );
  }
  if (!isReceipt(value, statuses)) {
    throw new SdkError(
      "native_diagnostics_invalid_response",
      `LogBrew Android native diagnostics ${operation} returned an invalid response`
    );
  }
  return Object.freeze({ pending: value.pending, status: value.status });
}

/**
 * @param {unknown} [configuration]
 * @returns {LogBrewAndroidNativeDiagnosticsReceipt}
 */
function installLogBrewAndroidNativeDiagnostics(configuration = {}) {
  requireAndroid();
  return receipt(
    "install",
    call("installAndroidDiagnostics", normalizeConfiguration(configuration)),
    INSTALL_STATUSES
  );
}

/**
 * @returns {LogBrewAndroidNativeDiagnosticsReceipt}
 */
function getLogBrewAndroidNativeDiagnosticsStatus() {
  requireAndroid();
  return receipt("status", call("androidDiagnosticsStatus"), STATUS_STATUSES);
}

/**
 * @returns {LogBrewAndroidNativeDiagnosticsReceipt}
 */
function uninstallLogBrewAndroidNativeDiagnostics() {
  requireAndroid();
  return receipt("uninstall", call("uninstallAndroidDiagnostics"), UNINSTALL_STATUSES);
}

export {
  getLogBrewAndroidNativeDiagnosticsStatus,
  installLogBrewAndroidNativeDiagnostics,
  uninstallLogBrewAndroidNativeDiagnostics
};
