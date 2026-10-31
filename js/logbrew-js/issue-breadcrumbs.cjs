"use strict";

const { SdkError } = require("./sdk-error.cjs");
const { boundedText, optionalText, requireMachineName } = require("./issue-text.cjs");
const { optionalEntry, rejectUnknownKeys, requireObject, requireTimestamp } = require("./validation.cjs");

/**
 * @import { IssueBreadcrumb, IssueBreadcrumbDataValue, IssueBreadcrumbLevel } from "./index.cjs"
 */

const MAX_ISSUE_BREADCRUMBS = 64;
const MIN_ISSUE_BREADCRUMBS = 1;
const MAX_BREADCRUMB_MESSAGE_LENGTH = 512;
const MAX_BREADCRUMB_DATA_FIELDS = 8;
const MAX_BREADCRUMB_DATA_STRING_LENGTH = 256;
const DATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const BREADCRUMB_KEYS = new Set(["timestamp", "type", "category", "level", "message", "data"]);
/** @type {ReadonlyMap<string, IssueBreadcrumbLevel>} */
const BREADCRUMB_LEVEL_ALIASES = new Map([
  ["trace", "debug"],
  ["debug", "debug"],
  ["info", "info"],
  ["log", "info"],
  ["warn", "warning"],
  ["warning", "warning"],
  ["error", "error"],
  ["fatal", "critical"],
  ["critical", "critical"]
]);

/**
 * @param {unknown} value
 * @returns {IssueBreadcrumbLevel | undefined}
 */
function optionalBreadcrumbLevel(value) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = typeof value === "string" ? BREADCRUMB_LEVEL_ALIASES.get(value) : undefined;
  if (normalized === undefined) {
    throw new SdkError(
      "validation_error",
      `issue breadcrumb level must be one of: ${[...BREADCRUMB_LEVEL_ALIASES.keys()].join(", ")}`
    );
  }
  return normalized;
}

/**
 * @param {string} key
 * @returns {string}
 */
function requireDataKey(key) {
  if (!DATA_KEY_PATTERN.test(key)) {
    throw new SdkError("validation_error", `issue breadcrumb data key must match ${DATA_KEY_PATTERN}`);
  }
  return key;
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {IssueBreadcrumbDataValue}
 */
function breadcrumbDataValue(key, value) {
  if (typeof value === "string") {
    return boundedText(`issue breadcrumb data value for ${key}`, value, MAX_BREADCRUMB_DATA_STRING_LENGTH);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SdkError("validation_error", `issue breadcrumb data value for ${key} must be finite`);
    }
    return value;
  }
  if (typeof value === "boolean" || value === null) {
    return value;
  }
  throw new SdkError(
    "validation_error",
    `issue breadcrumb data value for ${key} must be a string, number, boolean, or null`
  );
}

/**
 * @param {unknown} data
 * @returns {Record<string, IssueBreadcrumbDataValue> | undefined}
 */
function validateBreadcrumbData(data) {
  if (data === undefined) {
    return undefined;
  }
  /** @type {readonly (readonly [string, unknown])[]} */
  const entries = Object.entries(requireObject("issue breadcrumb data", data));
  if (entries.length > MAX_BREADCRUMB_DATA_FIELDS) {
    throw new SdkError(
      "validation_error",
      `issue breadcrumb data must contain at most ${MAX_BREADCRUMB_DATA_FIELDS} fields`
    );
  }
  return Object.fromEntries(entries.map(([key, value]) => [requireDataKey(key), breadcrumbDataValue(key, value)]));
}

/**
 * @param {unknown} breadcrumb
 * @param {unknown} [defaultTimestamp]
 * @returns {IssueBreadcrumb}
 */
function validateIssueBreadcrumb(breadcrumb, defaultTimestamp) {
  const source = requireObject("issue breadcrumb", breadcrumb);
  rejectUnknownKeys("issue breadcrumb", source, BREADCRUMB_KEYS);
  const timestamp = requireTimestamp(source["timestamp"] ?? defaultTimestamp);
  const category = requireMachineName("issue breadcrumb category", source["category"]);
  const type = source["type"] === undefined ? undefined : requireMachineName("issue breadcrumb type", source["type"]);
  const level = optionalBreadcrumbLevel(source["level"]);
  const message = optionalText("issue breadcrumb message", source["message"], MAX_BREADCRUMB_MESSAGE_LENGTH);
  const data = validateBreadcrumbData(source["data"]);
  return {
    timestamp,
    ...optionalEntry("type", type),
    category,
    ...optionalEntry("level", level),
    ...optionalEntry("message", message),
    ...optionalEntry("data", data)
  };
}

/**
 * @param {unknown} breadcrumbs
 * @returns {IssueBreadcrumb[] | undefined}
 */
function validateIssueBreadcrumbs(breadcrumbs) {
  if (breadcrumbs === undefined) {
    return undefined;
  }
  if (!Array.isArray(breadcrumbs) || breadcrumbs.length < MIN_ISSUE_BREADCRUMBS || breadcrumbs.length > MAX_ISSUE_BREADCRUMBS) {
    throw new SdkError("validation_error", `issue breadcrumbs must contain 1-${MAX_ISSUE_BREADCRUMBS} entries`);
  }
  /** @type {readonly unknown[]} */
  const list = breadcrumbs;
  return list.map((breadcrumb) => validateIssueBreadcrumb(breadcrumb));
}

module.exports = { MAX_ISSUE_BREADCRUMBS, validateIssueBreadcrumb, validateIssueBreadcrumbs };
