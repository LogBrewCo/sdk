const { PRODUCT_ANALYTICS_SCHEMA_VERSION } = require("@logbrew/sdk");
const { readField, textOf } = require("./index-values.cjs");

/**
 * @import { LooseRecord } from "./index-values.cjs"
 * @typedef {{ readonly timestamp: unknown, readonly attributes: LooseRecord }} BreadcrumbEvent
 * @typedef {{ readonly category: string, readonly type: string }} BreadcrumbKind
 * @typedef {{ readonly addBreadcrumb: (breadcrumb: LooseRecord, timestamp: unknown) => unknown }} BreadcrumbClient
 */

const LAST_ROUTE = Symbol.for("co.logbrew.react-native.last-route");
const MAX_ACTION_NAME_LENGTH = 64;
const MAX_BREADCRUMB_MESSAGE_LENGTH = 512;
const MAX_PRODUCT_ANALYTICS_SURFACE_LENGTH = 256;
const SCREEN_ACTION_PREFIX = "screen:";
const LAST_C0_CONTROL = 31;
const FIRST_C1_CONTROL = 127;
const LAST_C1_CONTROL = 159;
const START = 0;
const ACTION_NAME_RE = /^[A-Za-z0-9_.:-]+$/u;

/**
 * @param {unknown} client
 * @returns {client is BreadcrumbClient}
 */
function hasAddBreadcrumb(client) {
  return typeof readField(client, "addBreadcrumb") === "function";
}

/**
 * @param {readonly string[]} characters
 * @returns {boolean}
 */
function hasControlCharacter(characters) {
  return characters.some(character => {
    const code = character.codePointAt(START);
    return code !== undefined && (code <= LAST_C0_CONTROL || (code >= FIRST_C1_CONTROL && code <= LAST_C1_CONTROL));
  });
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function boundedBreadcrumbMessage(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const characters = [...value];
  if (characters.length > MAX_BREADCRUMB_MESSAGE_LENGTH || hasControlCharacter(characters)) {
    return undefined;
  }
  return value;
}

/**
 * @param {unknown} client
 * @param {BreadcrumbEvent} event
 * @param {BreadcrumbKind} kind
 * @returns {void}
 */
function recordIssueBreadcrumb(client, event, { category, type }) {
  if (!hasAddBreadcrumb(client)) {
    return;
  }
  const rawStatus = event.attributes["status"];
  const status = typeof rawStatus === "string" ? rawStatus : undefined;
  const message = boundedBreadcrumbMessage(event.attributes["name"]);
  client.addBreadcrumb({
    category,
    type,

    level: status === "failure" || status === "error" ? "error" : "info",
    ...(message === undefined ? {} : { message }),
    ...(status === undefined ? {} : { data: { status } })
  }, event.timestamp);
  if (category === "navigation" && message !== undefined) {
    Reflect.set(client, LAST_ROUTE, message);
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function slugify(value) {
  return textOf(value)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "") || "event";
}

/**
 * @param {string} screenName
 * @returns {string}
 */
function screenActionName(screenName) {
  const directName = `${SCREEN_ACTION_PREFIX}${screenName}`;
  if (directName.length <= MAX_ACTION_NAME_LENGTH && ACTION_NAME_RE.test(directName)) {
    return directName;
  }
  const maxScreenSegmentLength = MAX_ACTION_NAME_LENGTH - SCREEN_ACTION_PREFIX.length;
  const screenSegment = slugify(screenName)
    .slice(START, maxScreenSegmentLength)
    .replace(/_+$/u, "") || "event";
  return `${SCREEN_ACTION_PREFIX}${screenSegment}`;
}

/**
 * @param {unknown} surface
 * @returns {string | undefined}
 */
function boundedProductAnalyticsSurface(surface) {
  if (typeof surface !== "string") {
    return undefined;
  }
  const normalized = surface.trim();
  const characters = [...normalized];
  if (normalized === "" || characters.length > MAX_PRODUCT_ANALYTICS_SURFACE_LENGTH || hasControlCharacter(characters)) {
    return undefined;
  }
  return normalized;
}

/**
 * @param {string} kind
 * @param {unknown} surface
 * @returns {{ analyticsSchemaVersion: number, analyticsKind: string, analyticsSurface: string | undefined }}
 */
function productAnalyticsMetadata(kind, surface) {
  return {
    analyticsSchemaVersion: PRODUCT_ANALYTICS_SCHEMA_VERSION,

    analyticsKind: kind,
    analyticsSurface: boundedProductAnalyticsSurface(surface)
  };
}

module.exports = { productAnalyticsMetadata, recordIssueBreadcrumb, screenActionName };
