import { hasControlCharacter, hasOwnKey, isRecord, utf8Length } from "./native-diagnostics-values.js";
import { SdkError } from "@logbrew/sdk";

/**
 * @typedef {{
 *   apiKey: string,
 *   endpoint?: string,
 *   environment: string,
 *   fatalHandlerOwnership: "logbrew",
 *   hangThresholdSeconds?: number,
 *   projectId: string,
 *   release: string,
 *   service: string
 * }} AppleInstallPayload
 */

const ALLOWED_KEYS = new Set([
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
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const DEFAULT_MAX_BYTES = 256;
const AUTH_KEY_BYTES = 4096;
const PROJECT_ID_BYTES = 64;
const ENDPOINT_BYTES = 2048;
const MIN_HANG_THRESHOLD_SECONDS = 1;
const MAX_HANG_THRESHOLD_SECONDS = 30;
const EMPTY_LENGTH = 0;

/**
 * @param {string} message
 * @returns {SdkError}
 */
function configurationError(message) {
  return new SdkError("configuration_error", `LogBrew Apple native diagnostics ${message}`);
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {number} [maxBytes]
 * @returns {string}
 */
function exactString(name, value, maxBytes = DEFAULT_MAX_BYTES) {
  if (typeof value !== "string"
    || value.length === EMPTY_LENGTH
    || value.trim() !== value
    || hasControlCharacter(value)
    || utf8Length(value) > maxBytes) {
    throw configurationError(`${name} must be a non-empty bounded string without surrounding whitespace or control characters`);
  }
  return value;
}

/**
 * @param {string} endpoint
 * @returns {URL}
 */
function parseEndpoint(endpoint) {
  try {
    return new URL(endpoint);
  } catch {
    throw configurationError("endpoint must be an absolute HTTPS URL");
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function exactDeliveryEndpoint(value) {
  const endpoint = exactString("endpoint", value, ENDPOINT_BYTES);
  const parsed = parseEndpoint(endpoint);
  if (parsed.protocol !== "https:") {
    throw configurationError("endpoint must use HTTPS");
  }
  if (parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || endpoint !== `${parsed.origin}${parsed.pathname}`) {
    throw configurationError("endpoint must be a plain HTTPS path without embedded auth, query, or fragment values");
  }
  return endpoint;
}

/**
 * @param {unknown} threshold
 * @returns {number}
 */
function hangThreshold(threshold) {
  if (typeof threshold !== "number"
    || !Number.isFinite(threshold)
    || threshold < MIN_HANG_THRESHOLD_SECONDS
    || threshold > MAX_HANG_THRESHOLD_SECONDS) {
    throw configurationError("hangThresholdSeconds must be a finite number from 1 through 30");
  }
  return threshold;
}

/**
 * @param {unknown} configuration
 * @returns {Readonly<Record<string, unknown>>}
 */
function knownConfiguration(configuration) {
  if (!isRecord(configuration)) {
    throw configurationError("configuration must be an object");
  }
  for (const key of Object.keys(configuration)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw configurationError(`configuration contains unsupported key ${JSON.stringify(key)}`);
    }
  }
  if (hasOwnKey(configuration, "apiKey") && hasOwnKey(configuration, "clientKey")) {
    throw configurationError("apiKey and clientKey are mutually exclusive");
  }
  return configuration;
}

/**
 * @param {Readonly<Record<string, unknown>>} configuration
 * @returns {string}
 */
function exactProjectId(configuration) {
  const projectId = exactString("projectId", configuration["projectId"], PROJECT_ID_BYTES);
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw configurationError("projectId must be a lowercase UUID");
  }
  return projectId;
}

/**
 * @param {Readonly<Record<string, unknown>>} configuration
 * @returns {{ endpoint?: string, hangThresholdSeconds?: number }}
 */
function optionalSettings(configuration) {
  const { endpoint, hangThresholdSeconds } = configuration;
  return {
    ...(endpoint === undefined ? {} : { endpoint: exactDeliveryEndpoint(endpoint) }),
    ...(hangThresholdSeconds === undefined ? {} : { hangThresholdSeconds: hangThreshold(hangThresholdSeconds) })
  };
}

/**
 * @param {unknown} input
 * @returns {AppleInstallPayload}
 */
function normalizeConfiguration(input) {
  const configuration = knownConfiguration(input);
  const authKey = exactString("apiKey or clientKey", configuration["clientKey"] ?? configuration["apiKey"], AUTH_KEY_BYTES);
  const projectId = exactProjectId(configuration);
  if (configuration["fatalHandlerOwnership"] !== "logbrew") {
    throw configurationError(
      "fatalHandlerOwnership must be the exact string logbrew after confirming no other native fatal handler is installed"
    );
  }

  return {
    apiKey: authKey,
    environment: exactString("environment", configuration["environment"]),
    fatalHandlerOwnership: "logbrew",
    projectId,
    release: exactString("release", configuration["release"]),
    service: exactString("service", configuration["service"]),
    ...optionalSettings(configuration)
  };
}

export { configurationError, normalizeConfiguration };
