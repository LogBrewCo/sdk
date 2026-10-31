const { ACTION_STATUSES } = require("./event-validation.cjs");
const { compactMetadata } = require("./log-context.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { hasUnicodeControlCharacter, isRecord, requireAllowedValue, requireNonEmpty, stringOrUndefined } = require("./validation.cjs");

/**
 * @import { ActionAttributes, MetadataValue, ProductAnalyticsKind } from "./index.cjs"
 * @typedef {ActionAttributes["status"]} ActionStatus
 * @typedef {Readonly<{ metadata?: unknown }>} TimelineOptions
 * @typedef {{ name: string, status: ActionStatus, metadata: Record<string, MetadataValue> }} TimelineAttributes
 * @typedef {{
 *   funnel?: unknown,
 *   metadata?: unknown,
 *   name: string,
 *   routeTemplate?: unknown,
 *   screen?: unknown,
 *   sessionId?: unknown,
 *   status: ActionStatus,
 *   step?: unknown,
 *   traceId?: unknown
 * }} ProductActionDetails
 */

/** @type {1} */
const PRODUCT_ANALYTICS_SCHEMA_VERSION = 1;
/** @type {readonly ProductAnalyticsKind[]} */
const PRODUCT_ANALYTICS_KINDS = Object.freeze(["page_view", "screen_view", "interaction"]);
const MAX_PRODUCT_ANALYTICS_SURFACE_LENGTH = 256;
const ROUTE_BASE_URL = "https://logbrew.example";
const ROUTE_LOCATION_PATTERN = /[?#]/u;

/**
 * @param {string} trimmed
 * @returns {string}
 */
function routePathname(trimmed) {
  try {
    const { pathname } = new URL(trimmed, ROUTE_BASE_URL);
    return pathname === "" ? "/" : pathname;
  } catch {
    const [path] = trimmed.split(ROUTE_LOCATION_PATTERN);
    return path === undefined || path === "" ? "/" : path;
  }
}

/**
 * @param {unknown} routeTemplate
 * @returns {string | undefined}
 */
function sanitizeRouteTemplate(routeTemplate) {
  if (routeTemplate === undefined) {
    return undefined;
  }
  if (typeof routeTemplate !== "string") {
    throw new SdkError("validation_error", "routeTemplate must be a string");
  }
  const trimmed = routeTemplate.trim();
  return trimmed === "" ? "" : routePathname(trimmed);
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
  if (
    normalized === ""
    || [...normalized].length > MAX_PRODUCT_ANALYTICS_SURFACE_LENGTH
    || hasUnicodeControlCharacter(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

/**
 * @param {ProductAnalyticsKind} kind
 * @param {unknown} surface
 * @returns {Record<string, unknown>}
 */
function productAnalyticsMetadata(kind, surface) {
  return {
    analyticsSchemaVersion: PRODUCT_ANALYTICS_SCHEMA_VERSION,

    analyticsKind: kind,
    analyticsSurface: boundedProductAnalyticsSurface(surface)
  };
}

/**
 * @param {unknown} action
 * @returns {ProductActionDetails}
 */
function productActionDetails(action) {
  if (typeof action === "string") {
    return { name: action, status: "success" };
  }
  if (!isRecord(action)) {
    throw new SdkError("validation_error", "product action must be a string or object");
  }
  const name = requireNonEmpty("product action name", action["name"]);
  const status = requireAllowedValue(
    "product action status",
    action["status"] === undefined ? "success" : action["status"],
    ACTION_STATUSES
  );
  return {
    funnel: action["funnel"],
    metadata: action["metadata"],
    name,
    routeTemplate: action["routeTemplate"],
    screen: action["screen"],
    sessionId: action["sessionId"],
    status,
    step: action["step"],
    traceId: action["traceId"]
  };
}

/**
 * @param {unknown} action
 * @param {TimelineOptions} [options]
 * @returns {TimelineAttributes}
 */
function createProductActionAttributes(action, options = {}) {
  const details = productActionDetails(action);
  const routeTemplate = sanitizeRouteTemplate(details.routeTemplate);
  const surface = routeTemplate === undefined || routeTemplate === "" ? details.screen : routeTemplate;
  return {
    name: details.name,

    status: details.status,

    metadata: compactMetadata({
      source: "product.action",
      ...compactMetadata(options.metadata),
      ...compactMetadata(details.metadata),
      routeTemplate,

      sessionId: stringOrUndefined(details.sessionId),

      traceId: stringOrUndefined(details.traceId),

      screen: stringOrUndefined(details.screen),

      funnel: stringOrUndefined(details.funnel),

      step: stringOrUndefined(details.step),
      ...productAnalyticsMetadata("interaction", surface)
    })
  };
}

module.exports = {
  PRODUCT_ANALYTICS_KINDS,
  PRODUCT_ANALYTICS_SCHEMA_VERSION,
  createProductActionAttributes,
  sanitizeRouteTemplate
};
