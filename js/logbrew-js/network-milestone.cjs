const { ACTION_STATUSES } = require("./event-validation.cjs");
const { compactMetadata } = require("./log-context.cjs");
const { sanitizeRouteTemplate } = require("./product-action.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { isRecord, requireAllowedValue, requireNonEmpty, stringOrUndefined } = require("./validation.cjs");

/**
 * @import { ActionStatus, TimelineAttributes, TimelineOptions } from "./product-action.cjs"
 * @typedef {{
 *   durationMs: number | undefined,
 *   metadata: unknown,
 *   method: string,
 *   name: string,
 *   routeTemplate: string,
 *   sessionId: unknown,
 *   status: ActionStatus,
 *   statusCode: number | undefined,
 *   traceId: unknown
 * }} NetworkMilestoneDetails
 */

const MIN_STATUS_CODE = 100;
const MAX_STATUS_CODE = 599;
const FAILURE_STATUS_CODE = 400;
const MIN_DURATION_MS = 0;
const HTTP_METHOD_PATTERN = /^[A-Z][A-Z0-9_-]*$/u;

/**
 * @param {unknown} method
 * @returns {string}
 */
function normalizeHttpMethod(method) {
  const value = method === undefined ? "GET" : method;
  if (typeof value !== "string" || value.trim() === "") {
    throw new SdkError("validation_error", "network milestone method must be a non-empty string");
  }
  const normalized = value.trim().toUpperCase();
  if (!HTTP_METHOD_PATTERN.test(normalized)) {
    throw new SdkError("validation_error", "network milestone method must be a valid HTTP method");
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function statusCodeOrUndefined(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_STATUS_CODE || value > MAX_STATUS_CODE) {
    throw new SdkError("validation_error", "network milestone statusCode must be an integer from 100 to 599");
  }
  return value;
}

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {number | undefined}
 */
function nonNegativeNumberOrUndefined(label, value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_DURATION_MS) {
    throw new SdkError("validation_error", `${label} must be a non-negative number`);
  }
  return value;
}

/**
 * @param {number | undefined} statusCode
 * @returns {"failure" | "success"}
 */
function statusFromStatusCode(statusCode) {
  return statusCode !== undefined && statusCode >= FAILURE_STATUS_CODE ? "failure" : "success";
}

/**
 * @param {Readonly<Record<string, unknown>>} request
 * @returns {NetworkMilestoneDetails}
 */
function networkMilestoneFields(request) {
  const routeTemplate = requireNonEmpty("network milestone routeTemplate", sanitizeRouteTemplate(request["routeTemplate"]));
  const method = normalizeHttpMethod(request["method"]);
  const statusCode = statusCodeOrUndefined(request["statusCode"]);
  const requestedStatus = request["status"];
  const status = requireAllowedValue(
    "network milestone status",
    requestedStatus === undefined ? statusFromStatusCode(statusCode) : requestedStatus,
    ACTION_STATUSES
  );
  const durationMs = nonNegativeNumberOrUndefined("network milestone durationMs", request["durationMs"]);
  const name = stringOrUndefined(request["name"]) ?? `network.${method.toLowerCase()} ${routeTemplate}`;
  return {
    durationMs,
    metadata: request["metadata"],
    method,
    name,
    routeTemplate,
    sessionId: request["sessionId"],
    status,
    statusCode,
    traceId: request["traceId"]
  };
}

/**
 * @param {unknown} request
 * @returns {NetworkMilestoneDetails}
 */
function networkMilestoneDetails(request) {
  if (typeof request === "string") {
    return networkMilestoneFields({ routeTemplate: request });
  }
  if (!isRecord(request)) {
    throw new SdkError("validation_error", "network milestone must be a string or object");
  }
  return networkMilestoneFields(request);
}

/**
 * @param {unknown} request
 * @param {TimelineOptions} [options]
 * @returns {TimelineAttributes}
 */
function createNetworkMilestoneAttributes(request, options = {}) {
  const details = networkMilestoneDetails(request);
  return {
    name: details.name,

    status: details.status,

    metadata: compactMetadata({
      source: "network.milestone",
      ...compactMetadata(options.metadata),
      ...compactMetadata(details.metadata),
      routeTemplate: details.routeTemplate,

      method: details.method,

      statusCode: details.statusCode,

      durationMs: details.durationMs,

      sessionId: stringOrUndefined(details.sessionId),

      traceId: stringOrUndefined(details.traceId)
    })
  };
}

module.exports = { createNetworkMilestoneAttributes };
