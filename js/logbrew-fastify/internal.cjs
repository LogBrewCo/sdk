"use strict";

const { SdkError } = require("@logbrew/sdk");

/**
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import { Transport } from "@logbrew/sdk"
 * @import { LogBrewFastifyRequestLike, LogBrewSpanRequestEvent, LogBrewTransportFactory } from "./index.cjs"
 */

/**
 * @typedef {{ readonly factory: LogBrewTransportFactory } | { readonly transport: Transport }} TransportSource
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
const MIN_STATUS_CODE = 100;
const MAX_STATUS_CODE = 999;
const STATUS_CLASS_SIZE = 100;
const SERVER_ERROR_STATUS = 500;
const OLDEST_PINO_MAJOR = 9;
const OLDEST_PINO_9_MINOR = 11;
const NEXT_PINO_MAJOR = 10;
const OLDEST_PINO_10_MINOR = 1;

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
 * @param {LogBrewFastifyRequestLike} request
 * @returns {string}
 */
function getRequestMethod(request) {
  return request.method ?? DEFAULT_METHOD;
}

/**
 * @param {LogBrewFastifyRequestLike} request
 * @returns {string}
 */
function getRequestPath(request) {
  return pathOnly(request.url ?? FALLBACK_PATH);
}

/**
 * @param {unknown} request
 * @returns {string}
 */
function getRouteTemplate(request) {
  return pathOnly(
    readField(readField(request, "routeOptions"), "url") ??
      readField(request, "routerPath") ??
      readField(readField(request, "routeConfig"), "url") ??
      readField(request, "url") ??
      FALLBACK_PATH
  );
}

/**
 * @param {unknown} reply
 * @returns {number}
 */
function getStatusCode(reply) {
  return Number(readField(reply, "statusCode") ?? NO_STATUS_CODE);
}

/**
 * @param {unknown} reply
 * @returns {string}
 */
function getStatusCodeText(reply) {
  const statusCode = readField(reply, "statusCode") ?? NO_STATUS_CODE;
  return typeof statusCode === "number" || typeof statusCode === "string" || typeof statusCode === "boolean"
    ? String(statusCode)
    : JSON.stringify(statusCode);
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
  if (!Number.isInteger(statusCode) || statusCode < MIN_STATUS_CODE || statusCode > MAX_STATUS_CODE) {
    return "unknown";
  }
  return `${String(Math.floor(statusCode / STATUS_CLASS_SIZE))}xx`;
}

/**
 * @param {Readonly<LogBrewTraceContext> | undefined} trace
 * @returns {Readonly<Record<string, unknown>>}
 */
function traceMetadata(trace) {
  if (!trace) {
    return {};
  }
  return {
    parentSpanId: trace.parentSpanId,
    sampled: trace.sampled,
    spanId: trace.spanId,
    traceId: trace.traceId
  };
}

/**
 * @param {Readonly<LogBrewTraceContext>} traceContext
 * @param {RequestSpanFields} fields
 * @returns {LogBrewSpanRequestEvent}
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
        framework: "fastify",
        method,
        path,
        sampled: traceContext.sampled,
        statusCode
      }
    }
  };
}

/**
 * @param {number} major
 * @param {number} minor
 * @returns {boolean}
 */
function isSupportedPinoVersion(major, minor) {
  return (
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    major >= OLDEST_PINO_MAJOR &&
    !(major === OLDEST_PINO_MAJOR && minor < OLDEST_PINO_9_MINOR) &&
    !(major === NEXT_PINO_MAJOR && minor < OLDEST_PINO_10_MINOR)
  );
}

/**
 * @param {unknown} version
 * @returns {void}
 */
function assertCompatibleFastifyPino(version) {
  if (typeof version !== "string") {
    throw new SdkError("configuration_error", "captureApplicationLogs requires Fastify's Pino logger to be enabled");
  }
  const match = /^(?<major>\d+)\.(?<minor>\d+)(?:\.|$)/u.exec(version);
  const major = Number(match?.groups?.["major"]);
  const minor = Number(match?.groups?.["minor"]);
  if (!isSupportedPinoVersion(major, minor)) {
    throw new SdkError(
      "configuration_error",
      `captureApplicationLogs requires Pino 9.11+ or 10.1+; Fastify is using ${version}`
    );
  }
}

/**
 * @param {unknown} record
 * @returns {boolean}
 */
function shouldCaptureFastifyApplicationLog(record) {
  return !isObjectLike(readField(record, "req")) && !isObjectLike(readField(record, "res"));
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
  assertCompatibleFastifyPino,
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
  shouldCaptureFastifyApplicationLog,
  slugify,
  statusCodeClass,
  traceMetadata
};
