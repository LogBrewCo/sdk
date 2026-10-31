"use strict";

const { callMethod, isRecord, readField } = require("./values.cjs");

/**
 * @import { TelemetryContext } from "@logbrew/sdk"
 */

const SESSION_ITEM = "logbrew.attribution.v1";
const CAMPAIGN_KEYS = ["utm_source", "utm_medium", "utm_campaign"];
const MAX_VALUE_LENGTH = 100;
const MAX_CONTEXT_TAGS = 32;
const NO_TAGS = 0;
const CONTEXT_SCHEMA_VERSION = 1;
const LAST_CONTROL_CODE = 31;
const FIRST_DELETE_CODE = 127;
const LAST_C1_CONTROL_CODE = 159;

/**
 * @param {string} character
 * @returns {boolean}
 */
function isControlCharacter(character) {
  const code = character.codePointAt(NO_TAGS);
  return code !== undefined && (code <= LAST_CONTROL_CODE || (code >= FIRST_DELETE_CODE && code <= LAST_C1_CONTROL_CODE));
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function cleanValue(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > MAX_VALUE_LENGTH) {
    return undefined;
  }
  return [...trimmed].some((character) => isControlCharacter(character)) ? undefined : trimmed;
}

/**
 * @param {unknown} value
 * @returns {URL | undefined}
 */
function parseUrl(value) {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function safeProperty(value, key) {
  try {
    return readField(value, key);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} storage
 * @returns {string | undefined}
 */
function savedText(storage) {
  try {
    const text = callMethod(storage, "getItem", [SESSION_ITEM]);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {Readonly<Record<string, unknown>>} saved
 * @returns {Record<string, string>}
 */
function savedTags(saved) {
  /** @type {Record<string, string>} */
  const tags = {};
  for (const key of [...CAMPAIGN_KEYS, "referrer_domain"]) {
    const value = cleanValue(saved[key]);
    if (value !== undefined) {
      tags[key] = value;
    }
  }
  return tags;
}

/**
 * @param {unknown} storage
 * @returns {Record<string, string> | undefined}
 */
function readSaved(storage) {
  const text = savedText(storage);
  if (text === undefined) {
    return undefined;
  }
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? savedTags(parsed) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {URL | undefined} referrer
 * @param {URL | undefined} location
 * @returns {boolean}
 */
function isOutsideReferrer(referrer, location) {
  return referrer !== undefined
    && (referrer.protocol === "https:" || referrer.protocol === "http:")
    && referrer.hostname !== ""
    && referrer.hostname !== location?.hostname;
}

/**
 * @param {unknown} browserWindow
 * @returns {Record<string, string>}
 */
function landingTags(browserWindow) {
  /** @type {Record<string, string>} */
  const tags = {};
  const location = parseUrl(readField(safeProperty(browserWindow, "location"), "href"));
  for (const key of CAMPAIGN_KEYS) {
    const value = cleanValue(location?.searchParams.get(key));
    if (value !== undefined) {
      tags[key] = value;
    }
  }
  const referrer = parseUrl(safeProperty(safeProperty(browserWindow, "document"), "referrer"));
  if (referrer !== undefined && isOutsideReferrer(referrer, location)) {
    tags["referrer_domain"] = referrer.hostname.toLowerCase();
  }
  return tags;
}

/**
 * @param {unknown} browserWindow
 * @returns {Record<string, string>}
 */
function browserAttributionTags(browserWindow) {
  const storage = safeProperty(browserWindow, "sessionStorage");
  const saved = readSaved(storage);
  if (saved !== undefined) {
    return saved;
  }
  const tags = landingTags(browserWindow);
  try {
    callMethod(storage, "setItem", [SESSION_ITEM, JSON.stringify(tags)]);
  } catch {
    return tags;
  }
  return tags;
}

/**
 * @param {TelemetryContext | undefined} context
 * @param {Readonly<Record<string, string>>} tags
 * @returns {TelemetryContext | undefined}
 */
function addBrowserAttributionContext(context, tags) {
  if (Object.keys(tags).length === NO_TAGS) {
    return context;
  }
  if (context === undefined) {
    return { schemaVersion: CONTEXT_SCHEMA_VERSION, tags };
  }
  if (!isRecord(context)
    || readField(context, "schemaVersion") !== CONTEXT_SCHEMA_VERSION
    || (readField(context, "tags") !== undefined && !isRecord(readField(context, "tags")))) {
    return context;
  }
  const merged = { ...tags, ...context.tags };
  return Object.keys(merged).length > MAX_CONTEXT_TAGS ? context : { ...context, tags: merged };
}

module.exports = { addBrowserAttributionContext, browserAttributionTags };
