import {
  callNative,
  requireApplePlatform,
  requireNativeModule,
  requireReplayResult,
  requireStatusResult,
  updateNativeSnapshot
} from "./apple-native-diagnostics-module.js";
import { SdkError } from "@logbrew/sdk";
import { normalizeConfiguration } from "./apple-native-diagnostics-config.js";
import { normalizeCorrelationContext } from "./apple-native-diagnostics-context.js";

/**
 * @import {
 *   LogBrewAppleNativeCrashContextResult,
 *   LogBrewAppleNativeDiagnosticsReplayResult,
 *   LogBrewAppleNativeDiagnosticsStatus
 * } from "./apple-native-diagnostics.js"
 */

/** @type {ReadonlySet<string>} */
const INSTALL_STATUSES = new Set(["already_installed", "installed"]);
/** @type {ReadonlySet<string>} */
const STATUS_STATUSES = new Set(["not_installed", "ready"]);

/**
 * @param {unknown} [configuration]
 * @returns {LogBrewAppleNativeDiagnosticsStatus}
 */
function installLogBrewAppleNativeDiagnostics(configuration = {}) {
  requireApplePlatform();
  const nativeModule = requireNativeModule();
  const payload = normalizeConfiguration(configuration);
  const result = callNative(nativeModule, "installNativeDiagnostics", payload);
  return requireStatusResult("install", result, INSTALL_STATUSES);
}

/**
 * @param {unknown} nativeModule
 * @returns {Promise<unknown>}
 */
async function replayFromNative(nativeModule) {
  try {
    return await callNative(nativeModule, "replayNativeDiagnostics");
  } catch (error) {
    if (error instanceof SdkError) {
      throw error;
    }
    throw new SdkError(
      "native_diagnostics_failed",
      "LogBrew Apple native diagnostics replay failed"
    );
  }
}

/**
 * @returns {Promise<LogBrewAppleNativeDiagnosticsReplayResult>}
 */
async function replayLogBrewAppleNativeDiagnostics() {
  requireApplePlatform();
  const nativeModule = requireNativeModule();
  return requireReplayResult(await replayFromNative(nativeModule));
}

/**
 * @returns {LogBrewAppleNativeDiagnosticsStatus}
 */
function getLogBrewAppleNativeDiagnosticsStatus() {
  requireApplePlatform();
  const nativeModule = requireNativeModule();
  const result = callNative(nativeModule, "nativeDiagnosticsStatus");
  return requireStatusResult("status", result, STATUS_STATUSES);
}

/**
 * @param {unknown} context
 * @returns {LogBrewAppleNativeCrashContextResult}
 */
function setLogBrewAppleNativeCrashContext(context) {
  requireApplePlatform();
  const nativeModule = requireNativeModule();
  const payload = context === null ? context : normalizeCorrelationContext(context);
  return updateNativeSnapshot(nativeModule, payload, { label: "context", method: "setNativeDiagnosticsContext" });
}

const logBrewAppleNativeDiagnostics = {
  getLogBrewAppleNativeDiagnosticsStatus,
  installLogBrewAppleNativeDiagnostics,
  replayLogBrewAppleNativeDiagnostics,
  setLogBrewAppleNativeCrashContext
};

export {
  getLogBrewAppleNativeDiagnosticsStatus,
  installLogBrewAppleNativeDiagnostics,
  replayLogBrewAppleNativeDiagnostics,
  setLogBrewAppleNativeCrashContext
};
export { syncLogBrewAppleNativeCrashBreadcrumbs } from "./apple-native-diagnostics-module.js";
export default logBrewAppleNativeDiagnostics;
