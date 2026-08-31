import { SdkError } from "@logbrew/sdk";
import { NativeModules, Platform, TurboModuleRegistry } from "react-native";

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

export function installLogBrewAndroidNativeDiagnostics(configuration = {}) {
  requireAndroid();
  return receipt(
    "install",
    call("installAndroidDiagnostics", normalizeConfiguration(configuration)),
    new Set(["already_installed", "installed"])
  );
}

export function getLogBrewAndroidNativeDiagnosticsStatus() {
  requireAndroid();
  return receipt(
    "status",
    call("androidDiagnosticsStatus"),
    new Set(["not_installed", "ready"])
  );
}

export function uninstallLogBrewAndroidNativeDiagnostics() {
  requireAndroid();
  return receipt(
    "uninstall",
    call("uninstallAndroidDiagnostics"),
    new Set(["not_installed", "uninstalled"])
  );
}

function normalizeConfiguration(value) {
  if (!isObject(value)) {
    throw configurationError("configuration must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!INSTALL_KEYS.has(key)) {
      throw configurationError("configuration contains an unsupported key");
    }
  }
  if (value.fatalHandlerOwnership !== "logbrew") {
    throw configurationError(
      "fatalHandlerOwnership must be logbrew after removing every other Android fatal handler"
    );
  }
  const projectId = exactText(value.projectId, 64, "projectId");
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(projectId)) {
    throw configurationError("projectId must be a lowercase UUID");
  }
  const threshold = value.anrThresholdMs ?? 5000;
  if (!Number.isSafeInteger(threshold) || threshold < 2000 || threshold > 60000) {
    throw configurationError("anrThresholdMs must be an integer from 2000 through 60000");
  }
  return {
    anrThresholdMs: threshold,
    clientKey: exactText(value.clientKey, 4096, "clientKey"),
    environment: exactText(value.environment, 128, "environment"),
    fatalHandlerOwnership: "logbrew",
    projectId,
    release: exactText(value.release, 256, "release"),
    service: exactScope(value.service, "service")
  };
}

function exactScope(value, name) {
  const text = exactText(value, 128, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(text)
    || text.includes("..")
    || text.includes("//")) {
    throw configurationError(`${name} must be a bounded deployment identifier`);
  }
  return text;
}

function exactText(value, maximumBytes, name) {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || controlCharacter(value)
    || utf8Length(value) > maximumBytes) {
    throw configurationError(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function requireAndroid() {
  if (Platform?.OS !== "android") {
    throw new SdkError(
      "unsupported_platform",
      "LogBrew Android native diagnostics require an Android native build"
    );
  }
}

function call(method, ...args) {
  let nativeModule;
  try {
    nativeModule = TurboModuleRegistry?.get?.("LogBrewFatalStore")
      ?? NativeModules?.LogBrewFatalStore;
  } catch {
    nativeModule = undefined;
  }
  if (typeof nativeModule?.[method] !== "function") {
    throw new SdkError(
      "native_diagnostics_unavailable",
      `linked LogBrew Android diagnostics do not implement ${method}`
    );
  }
  try {
    return nativeModule[method](...args);
  } catch {
    throw new SdkError(
      "native_diagnostics_failed",
      `LogBrew Android native diagnostics ${method} failed`
    );
  }
}

function receipt(operation, value, statuses) {
  if (isObject(value)
    && value.status === "error"
    && typeof value.code === "string"
    && /^[a-z0-9_]{1,128}$/u.test(value.code)) {
    throw new SdkError(
      value.code,
      `LogBrew Android native diagnostics ${operation} failed with ${value.code}`
    );
  }
  if (!isObject(value)
    || !exactKeys(value, RECEIPT_KEYS)
    || !statuses.has(value.status)
    || !Number.isSafeInteger(value.pending)
    || value.pending < 0) {
    throw new SdkError(
      "native_diagnostics_invalid_response",
      `LogBrew Android native diagnostics ${operation} returned an invalid response`
    );
  }
  return Object.freeze({ pending: value.pending, status: value.status });
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function controlCharacter(value) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function utf8Length(value) {
  let length = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    length += code <= 127 ? 1 : code <= 2047 ? 2 : code <= 65535 ? 3 : 4;
  }
  return length;
}

function configurationError(message) {
  return new SdkError("configuration_error", `LogBrew Android native diagnostics ${message}`);
}
