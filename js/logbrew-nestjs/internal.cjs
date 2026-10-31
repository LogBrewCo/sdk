"use strict";

/**
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import { Metadata } from "@logbrew/sdk"
 * @import { LogBrewRequestSpanEvent } from "./index.cjs"
 */

/**
 * @typedef {{
 *   readonly durationMs: number,
 *   readonly id: string,
 *   readonly method: string,
 *   readonly now: () => string,
 *   readonly path: string,
 *   readonly statusCode: number
 * }} RequestSpanFields
 */

const DEFAULT_METHOD = "GET";
const FALLBACK_PATH = "/";
const URL_BASE = "http://localhost";
const FIRST_ITEM = 0;
const NO_STATUS_CODE = 0;
const STATUS_CLASS_SIZE = 100;
const SERVER_ERROR_STATUS = 500;

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {unknown}
 */
function readField(value, name) {
  return isObjectLike(value) ? value[name] : undefined;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function pathOnly(value) {
  const rawValue = typeof value === "string" ? value : String(value);
  try {
    return new URL(rawValue, URL_BASE).pathname || FALLBACK_PATH;
  } catch {
    const [pathPart = ""] = rawValue.split("?");
    return pathPart || FALLBACK_PATH;
  }
}

/**
 * @param {unknown} request
 * @returns {string}
 */
function getRequestMethod(request) {
  const method = readField(request, "method") ?? DEFAULT_METHOD;
  return typeof method === "string" ? method : textOf(method);
}

/**
 * @param {unknown} request
 * @returns {string}
 */
function getRequestPath(request) {
  return pathOnly(readField(request, "originalUrl") ?? readField(request, "url") ?? FALLBACK_PATH);
}

/**
 * @param {unknown} request
 * @returns {string}
 */
function getRouteTemplate(request) {
  const routePath = readField(readField(request, "route"), "path");
  if (typeof routePath !== "string") {
    return getRequestPath(request);
  }
  const baseUrl = readField(request, "baseUrl") ?? "";
  const basePath = typeof baseUrl === "string" ? baseUrl : textOf(baseUrl);
  if (basePath !== "" && routePath.startsWith(basePath)) {
    return pathOnly(routePath);
  }
  return pathOnly(`${basePath}${routePath}`);
}

/**
 * @param {unknown} response
 * @returns {number}
 */
function getStatusCode(response) {
  return Number(readField(response, "statusCode") ?? NO_STATUS_CODE);
}

/**
 * @param {unknown} response
 * @returns {string}
 */
function getStatusCodeText(response) {
  return textOf(readField(response, "statusCode") ?? NO_STATUS_CODE);
}

/**
 * @param {unknown} request
 * @returns {string | undefined}
 */
function getTraceparentHeader(request) {
  const value = readField(readField(request, "headers"), "traceparent");
  const first = Array.isArray(value) ? readField(value, String(FIRST_ITEM)) : value;
  return typeof first === "string" ? first : undefined;
}

/**
 * @param {string} value
 * @returns {string}
 */
function slugify(value) {
  return (
    value
      .toLowerCase()
      .replaceAll(/[^\da-z]+/gu, "_")
      .replaceAll(/^_+|_+$/gu, "") || "event"
  );
}

/**
 * @param {number} statusCode
 * @returns {string}
 */
function statusCodeClass(statusCode) {
  if (!Number.isFinite(statusCode) || statusCode <= NO_STATUS_CODE) {
    return "unknown";
  }
  return `${String(Math.floor(statusCode / STATUS_CLASS_SIZE))}xx`;
}

/**
 * @param {Readonly<LogBrewTraceContext> | undefined} trace
 * @returns {Metadata}
 */
function traceMetadata(trace) {
  if (!trace) {
    return {};
  }
  return {
    ...(trace.parentSpanId === undefined ? {} : { parentSpanId: trace.parentSpanId }),
    sampled: trace.sampled,
    spanId: trace.spanId,
    traceId: trace.traceId
  };
}

/**
 * @param {Readonly<LogBrewTraceContext>} traceContext
 * @param {RequestSpanFields} fields
 * @returns {LogBrewRequestSpanEvent}
 */
function createTraceparentRequestSpan(traceContext, fields) {
  const { durationMs, id, method, now, path, statusCode } = fields;
  return {
    id,
    timestamp: now(),
    type: "span",

    attributes: {
      name: `${method} ${path}`,
      traceId: traceContext.traceId,

      spanId: traceContext.spanId,

      ...(traceContext.parentSpanId === undefined ? {} : { parentSpanId: traceContext.parentSpanId }),
      status: statusCode >= SERVER_ERROR_STATUS ? "error" : "ok",

      durationMs,
      metadata: {
        framework: "nestjs",
        method,
        path,
        sampled: traceContext.sampled,
        statusCode
      }
    }
  };
}

/**
 * @returns {string | undefined}
 */
function readEnvApiKey() {
  return process.env["LOGBREW_API_KEY"];
}

/**
 * @returns {string | undefined}
 */
function readEnvServerApiKey() {
  return process.env["LOGBREW_SERVER_API_KEY"];
}

module.exports = {
  createTraceparentRequestSpan,
  getRequestMethod,
  getRequestPath,
  getRouteTemplate,
  getStatusCode,
  getStatusCodeText,
  getTraceparentHeader,
  readEnvApiKey,
  readEnvServerApiKey,
  readField,
  slugify,
  statusCodeClass,
  traceMetadata
};
