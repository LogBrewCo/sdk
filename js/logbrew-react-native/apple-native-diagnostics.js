import { SdkError } from "@logbrew/sdk";
import { NativeModules, Platform, TurboModuleRegistry } from "react-native";

const INSTALL_STATUSES = new Set(["already_installed", "installed"]);
const LIFECYCLE_STATUSES = new Set([
  "failed",
  "idle",
  "installed",
  "replaying",
  "stopped",
  "unknown"
]);

export function installLogBrewAppleNativeDiagnostics(configuration = {}) {
  requireApplePlatform();
  const nativeModule = requireNativeModule();
  const payload = normalizeConfiguration(configuration);
  const result = callNative(nativeModule, "installNativeDiagnostics", payload);
  return requireStatusResult("install", result, INSTALL_STATUSES);
}

export async function replayLogBrewAppleNativeDiagnostics() {
  requireApplePlatform();
  const nativeModule = requireNativeModule();
  let result;
  try {
    result = await callNative(nativeModule, "replayNativeDiagnostics");
  } catch (error) {
    if (error instanceof SdkError) {
      throw error;
    }
    throw new SdkError(
      "native_diagnostics_failed",
      "LogBrew Apple native diagnostics replay failed"
    );
  }
  return requireReplayResult(result);
}

export function getLogBrewAppleNativeDiagnosticsStatus() {
  requireApplePlatform();
  const nativeModule = requireNativeModule();
  const result = callNative(nativeModule, "nativeDiagnosticsStatus");
  return requireStatusResult("status", result, new Set(["not_installed", "ready"]));
}

function normalizeConfiguration(configuration) {
  if (!configuration
    || Array.isArray(configuration)
    || typeof configuration !== "object") {
    throw configurationError("configuration must be an object");
  }
  const allowedKeys = new Set([
    "apiKey",
    "clientKey",
    "endpoint",
    "environment",
    "fatalHandlerOwnership",
    "hangThresholdSeconds",
    "projectId",
    "release",
    "service"
  ]);
  for (const key of Object.keys(configuration)) {
    if (!allowedKeys.has(key)) {
      throw configurationError(`configuration contains unsupported key ${JSON.stringify(key)}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(configuration, "apiKey")
    && Object.prototype.hasOwnProperty.call(configuration, "clientKey")) {
    throw configurationError("apiKey and clientKey are mutually exclusive");
  }
  const authKey = exactString(
    "apiKey or clientKey",
    configuration.clientKey ?? configuration.apiKey,
    4096
  );
  const projectId = exactString("projectId", configuration.projectId, 64);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(projectId)) {
    throw configurationError("projectId must be a lowercase UUID");
  }
  if (configuration.fatalHandlerOwnership !== "logbrew") {
    throw configurationError(
      "fatalHandlerOwnership must be the exact string logbrew after confirming no other native fatal handler is installed"
    );
  }

  const payload = {
    apiKey: authKey,
    environment: exactString("environment", configuration.environment),
    fatalHandlerOwnership: "logbrew",
    projectId,
    release: exactString("release", configuration.release),
    service: exactString("service", configuration.service)
  };
  if (configuration.endpoint !== undefined) {
    payload.endpoint = exactDeliveryEndpoint(configuration.endpoint);
  }
  if (configuration.hangThresholdSeconds !== undefined) {
    const threshold = configuration.hangThresholdSeconds;
    if (typeof threshold !== "number"
      || !Number.isFinite(threshold)
      || threshold < 1
      || threshold > 30) {
      throw configurationError("hangThresholdSeconds must be a finite number from 1 through 30");
    }
    payload.hangThresholdSeconds = threshold;
  }
  return payload;
}

function requireApplePlatform() {
  if (Platform?.OS !== "ios") {
    throw new SdkError(
      "unsupported_platform",
      "LogBrew Apple native diagnostics are available only in an iOS native build"
    );
  }
}

function requireNativeModule() {
  let nativeModule;
  try {
    nativeModule = TurboModuleRegistry?.get?.("LogBrewAppleDiagnostics")
      ?? NativeModules?.LogBrewAppleDiagnostics;
  } catch {
    nativeModule = undefined;
  }
  if (!nativeModule) {
    throw new SdkError(
      "native_diagnostics_unavailable",
      "LogBrew Apple native diagnostics require the AppleDiagnostics CocoaPods subspec; Expo projects can add @logbrew/react-native/expo"
    );
  }
  return nativeModule;
}

function callNative(nativeModule, method, ...args) {
  if (typeof nativeModule?.[method] !== "function") {
    throw new SdkError(
      "native_diagnostics_unavailable",
      `linked LogBrew Apple diagnostics do not implement ${method}`
    );
  }
  try {
    return nativeModule[method](...args);
  } catch {
    throw new SdkError(
      "native_diagnostics_failed",
      `LogBrew Apple native diagnostics ${method} failed`
    );
  }
}

function requireStatusResult(operation, result, allowedStatuses) {
  if (isErrorResult(result)) {
    throw new SdkError(
      result.code,
      `LogBrew Apple native diagnostics ${operation} failed with ${result.code}`
    );
  }
  if (!isPlainObject(result)
    || !allowedStatuses.has(result.status)
    || !LIFECYCLE_STATUSES.has(result.lifecycle)
    || !isCount(result.pending)
    || !isCount(result.acknowledged)
    || !isCount(result.discarded)) {
    throw new SdkError(
      "native_diagnostics_invalid_response",
      `LogBrew Apple native diagnostics ${operation} returned an invalid response`
    );
  }
  return Object.freeze({
    acknowledged: result.acknowledged,
    discarded: result.discarded,
    lifecycle: result.lifecycle,
    pending: result.pending,
    status: result.status
  });
}

function requireReplayResult(result) {
  if (isErrorResult(result)) {
    throw new SdkError(
      result.code,
      `LogBrew Apple native diagnostics replay failed with ${result.code}`
    );
  }
  if (!isPlainObject(result)
    || result.status !== "replayed"
    || !isCount(result.attempted)
    || !isCount(result.acknowledged)
    || !isCount(result.discarded)
    || !isCount(result.pending)
    || result.acknowledged + result.discarded > result.attempted) {
    throw new SdkError(
      "native_diagnostics_invalid_response",
      "LogBrew Apple native diagnostics replay returned an invalid response"
    );
  }
  return Object.freeze({
    acknowledged: result.acknowledged,
    attempted: result.attempted,
    discarded: result.discarded,
    pending: result.pending,
    status: result.status
  });
}

function isErrorResult(result) {
  return isPlainObject(result)
    && result.status === "error"
    && typeof result.code === "string"
    && /^[a-z0-9_]{1,128}$/u.test(result.code);
}

function isPlainObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactString(name, value, maxBytes = 256) {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || hasControlCharacter(value)
    || utf8Length(value) > maxBytes) {
    throw configurationError(`${name} must be a non-empty bounded string without surrounding whitespace or control characters`);
  }
  return value;
}

function exactDeliveryEndpoint(value) {
  const endpoint = exactString("endpoint", value, 2048);
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw configurationError("endpoint must be an absolute HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw configurationError("endpoint must use HTTPS");
  }
  if (parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || endpoint !== `${parsed.origin}${parsed.pathname}`) {
    throw configurationError("endpoint must be a plain HTTPS path without embedded auth, query, or fragment values");
  }
  return endpoint;
}

function hasControlCharacter(value) {
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function utf8Length(value) {
  let bytes = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function configurationError(message) {
  return new SdkError("configuration_error", `LogBrew Apple native diagnostics ${message}`);
}

const logBrewAppleNativeDiagnostics = {
  getLogBrewAppleNativeDiagnosticsStatus,
  installLogBrewAppleNativeDiagnostics,
  replayLogBrewAppleNativeDiagnostics
};

export default logBrewAppleNativeDiagnostics;
