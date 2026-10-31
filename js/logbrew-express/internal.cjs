"use strict";

const { randomBytes } = require("node:crypto");
const { runWithLogBrewTrace } = require("@logbrew/node");

/**
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import { Metadata } from "@logbrew/sdk"
 * @import { LogBrewExpressSharedOptions } from "./index.cjs"
 */

const DEFAULT_METHOD = "GET";
const UNMATCHED_ROUTE = "<unmatched>";
const FIRST_ITEM = 0;
const NO_STATUS_CODE = 0;
const STATUS_CLASS_SIZE = 100;
const MIN_CLIENT_ERROR = 400;
const MIN_SERVER_ERROR = 500;
const ZERO_ID = "0000000000000000";
const NONZERO_ID = "0000000000000001";
const MAX_HANDLER_ARITY = 3;

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
 * @template Value
 * @typedef {{ readonly get: () => Value, readonly set: (value: Value) => void }} Cell
 */

/**
 * @template Value
 * @param {Value} initial
 * @returns {Cell<Value>}
 */
function createCell(initial) {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    }
  };
}

/**
 * @param {unknown} value
 * @returns {value is PromiseLike<unknown>}
 */
function isThenable(value) {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    typeof Reflect.get(value, "then") === "function"
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isRequestHandler(value) {
  return typeof value === "function" && value.length <= MAX_HANDLER_ARITY;
}

/**
 * @param {unknown} req
 * @returns {string}
 */
function getRequestMethod(req) {
  const method = readField(req, "method") ?? DEFAULT_METHOD;
  return typeof method === "string" ? method : textOf(method);
}

/**
 * @param {unknown} req
 * @returns {string}
 */
function getRouteTemplate(req) {
  const routePath = readField(readField(req, "route"), "path");
  return typeof routePath === "string" ? routePath : UNMATCHED_ROUTE;
}

/**
 * @param {unknown} res
 * @returns {number}
 */
function getStatusCode(res) {
  return Number(readField(res, "statusCode") ?? NO_STATUS_CODE);
}

/**
 * @param {unknown} res
 * @returns {string}
 */
function getStatusCodeText(res) {
  return textOf(readField(res, "statusCode") ?? NO_STATUS_CODE);
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
 * @param {number} statusCode
 * @param {boolean} completed
 * @returns {"error" | "ok"}
 */
function spanStatus(statusCode, completed) {
  return statusCode >= MIN_SERVER_ERROR || !completed ? "error" : "ok";
}

/**
 * @param {unknown} req
 * @param {unknown} res
 * @returns {boolean}
 */
function responseCompleted(req, res) {
  return (
    readField(req, "aborted") !== true &&
    !(readField(res, "destroyed") === true && readField(res, "writableFinished") === false)
  );
}

/**
 * @param {unknown} req
 * @param {unknown} res
 * @returns {Metadata}
 */
function incompleteResponseMetadata(req, res) {
  return responseCompleted(req, res) ? {} : { responseCompleted: false };
}

/**
 * @param {unknown} req
 * @returns {string | undefined}
 */
function getTraceparentHeader(req) {
  const value = readField(readField(req, "headers"), "traceparent");
  const first = Array.isArray(value) ? readField(value, String(FIRST_ITEM)) : value;
  return typeof first === "string" ? first : undefined;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isClientError(error) {
  const status = readField(error, "status") ?? readField(error, "statusCode");
  return typeof status === "number" && Number.isInteger(status) && status >= MIN_CLIENT_ERROR && status < MIN_SERVER_ERROR;
}

/**
 * @param {number} byteLength
 * @returns {string}
 */
function randomHex(byteLength) {
  const hex = randomBytes(byteLength).toString("hex");
  return hex === ZERO_ID ? NONZERO_ID : hex;
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
 * @template Result
 * @param {Readonly<LogBrewTraceContext> | undefined} trace
 * @param {() => Result} work
 * @returns {Result}
 */
function runWithTrace(trace, work) {
  return trace === undefined ? work() : runWithLogBrewTrace(trace, work);
}

/**
 * @param {LogBrewExpressSharedOptions} options
 * @returns {number}
 */
function nowMs(options) {
  if (typeof options.nowMs === "function") {
    return options.nowMs();
  }
  return performance.now();
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
  createCell,
  getRequestMethod,
  getRouteTemplate,
  getStatusCode,
  getStatusCodeText,
  getTraceparentHeader,
  incompleteResponseMetadata,
  isClientError,
  isObjectLike,
  isRequestHandler,
  isThenable,
  nowMs,
  randomHex,
  readEnvApiKey,
  readEnvServerApiKey,
  readField,
  responseCompleted,
  runWithTrace,
  slugify,
  spanStatus,
  statusCodeClass
};
