"use strict";

const net = require("node:net");

/**
 * @typedef {"android" | "ios"} ReleaseArtifactPlatform
 */

const HOSTED_UPLOAD_ENDPOINT = "https://api.logbrew.co/api/release-artifacts";
/** @type {ReadonlySet<string>} */
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const NOT_AN_IP = 0;
const MIN_UPLOAD_SCALAR = 0;

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
  return (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} options
 * @param {string} name
 * @returns {string}
 */
function requiredString(options, name) {
  const value = field(options, name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew React Native release-artifact helper requires ${name}`);
  }
  return value.trim();
}

/**
 * @param {unknown} options
 * @param {string} name
 * @returns {string | undefined}
 */
function optionalString(options, name) {
  const value = field(options, name);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew React Native release-artifact helper option ${name} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * @param {unknown} options
 * @param {string} name
 * @returns {string | undefined}
 */
function optionalUploadScalar(options, name) {
  const value = field(options, name);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < MIN_UPLOAD_SCALAR) {
      throw new Error(`LogBrew React Native release-artifact helper option ${name} must be non-negative`);
    }
    return String(value);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew React Native release-artifact helper option ${name} must be a non-empty string or number`);
  }
  return value.trim();
}

/**
 * @param {unknown} item
 * @returns {item is string}
 */
function isNonEmptyString(item) {
  return typeof item === "string" && item.trim() !== "";
}

/**
 * @param {unknown} value
 * @returns {value is readonly string[]}
 */
function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string[]}
 */
function normalizeStringArray(value, name) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!isNonEmptyStringArray(value)) {
    throw new Error(`LogBrew React Native release-artifact helper option ${name} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

/**
 * @param {unknown} options
 * @returns {ReleaseArtifactPlatform}
 */
function normalizePlatform(options) {
  const platform = requiredString(options, "platform").toLowerCase();
  if (platform !== "android" && platform !== "ios") {
    throw new Error("LogBrew React Native release-artifact helper option platform must be android or ios");
  }
  return platform;
}

/**
 * @param {string} endpoint
 * @returns {URL}
 */
function parseUploadUrl(endpoint) {
  try {
    return new URL(endpoint);
  } catch (error) {
    throw new Error(`upload endpoint is not a valid URL: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * @param {string} endpoint
 * @returns {URL}
 */
function parseUploadEndpoint(endpoint) {
  const parsed = parseUploadUrl(endpoint);
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("release artifact upload proof endpoint must use http or https");
  }
  return parsed;
}

/**
 * @param {URL} parsed
 * @returns {boolean}
 */
function isLoopbackUploadEndpoint(parsed) {
  const hostname = parsed.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    (net.isIP(hostname) !== NOT_AN_IP && (hostname.startsWith("127.") || hostname === "::1"))
  );
}

/**
 * @param {string} endpoint
 * @param {boolean} allowHosted
 * @returns {void}
 */
function requireUploadEndpoint(endpoint, allowHosted) {
  const parsed = parseUploadEndpoint(endpoint);
  if (isLoopbackUploadEndpoint(parsed)) {
    return;
  }
  if (!allowHosted) {
    throw new Error("release artifact hosted upload requires explicit allowHostedUpload; use loopback endpoints for local proof");
  }
  if (endpoint !== HOSTED_UPLOAD_ENDPOINT) {
    throw new Error(`hosted release artifact uploads must use ${HOSTED_UPLOAD_ENDPOINT}`);
  }
}

module.exports = {
  field,
  normalizePlatform,
  normalizeStringArray,
  optionalString,
  optionalUploadScalar,
  requireUploadEndpoint,
  requiredString
};
