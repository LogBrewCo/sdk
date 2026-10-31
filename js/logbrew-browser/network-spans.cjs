"use strict";

const { callMethod, isList, readField, stringOrUndefined } = require("./values.cjs");
const {
  nonNegativeNumberOrUndefined,
  numberOrUndefined,
  roundDurationMs,
  routeTemplatePath,
  sanitizeSourcePath
} = require("./browser-events.cjs");
const { SdkError } = require("@logbrew/sdk");
const { shouldPropagateTraceparent } = require("./traceparent-fetch.cjs");

/**
 * @import { BrowserFetchInput, BrowserFetchPathTemplate, BrowserTraceContext, TracePropagationTarget } from "./index.cjs"
 * @typedef {{ readonly nowMs?: (() => number) | undefined }} ClockOptions
 * @typedef {{
 *   readonly durationMs: number,
 *   readonly errorType: string | undefined,
 *   readonly method: string,
 *   readonly requestPath: string,
 *   readonly responseBodySize: number | undefined,
 *   readonly status: "error" | "ok",
 *   readonly statusCode: number | undefined,
 *   readonly tracePropagated: boolean
 * }} FetchDetails
 */

const NO_DURATION = 0;
const NO_BYTES = 0;
const DECIMAL = 10;
const ERROR_STATUS = 400;

/**
 * @param {unknown} targets
 * @param {string} name
 * @param {{ readonly optional?: boolean }} [options]
 * @returns {void}
 */
function validateTargets(targets, name, { optional = false } = {}) {
  if (targets === undefined && optional) {
    return;
  }
  if (!isList(targets)) {
    throw new SdkError("configuration_error", `${name} must be an array`);
  }
}

/**
 * @param {string} url
 * @param {readonly TracePropagationTarget[] | undefined} captureTargets
 * @returns {boolean}
 */
function shouldCaptureRequest(url, captureTargets) {
  if (captureTargets === undefined) {
    return true;
  }
  return shouldPropagateTraceparent(url, captureTargets);
}

/**
 * @param {unknown} value
 * @returns {value is () => number}
 */
function isClock(value) {
  return typeof value === "function";
}

/**
 * @param {ClockOptions} options
 * @returns {number}
 */
function nowMs(options) {
  if (typeof options.nowMs === "function") {
    return numberOrUndefined(options.nowMs()) ?? Date.now();
  }
  const performance = readField(globalThis, "performance");
  const now = readField(performance, "now");
  return isClock(now) ? now.call(performance) : Date.now();
}

/**
 * @param {number} startMs
 * @param {ClockOptions} options
 * @returns {number}
 */
function durationSince(startMs, options) {
  const endMs = nowMs(options);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return NO_DURATION;
  }
  return roundDurationMs(endMs - startMs);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorType(error) {
  return stringOrUndefined(readField(error, "name")) ?? "Error";
}

/**
 * @param {BrowserTraceContext} traceContext
 * @returns {string}
 */
function traceparentFromTraceContext(traceContext) {
  return `00-${traceContext.traceId}-${traceContext.spanId}-${traceContext.traceFlags}`;
}

/**
 * @param {unknown} method
 * @returns {string}
 */
function normalizeMethod(method) {
  return typeof method === "string" && method.trim() !== ""
    ? method.trim().toUpperCase()
    : "GET";
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function nonNegativeIntegerOrUndefined(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= NO_BYTES ? value : undefined;
}

/**
 * @param {unknown} contentLength
 * @returns {number | undefined}
 */
function contentLengthBytes(contentLength) {
  if (typeof contentLength !== "string" || contentLength.trim() === "") {
    return undefined;
  }
  const parsed = Number.parseInt(contentLength, DECIMAL);
  return Number.isFinite(parsed) && parsed >= NO_BYTES ? parsed : undefined;
}

/**
 * @param {unknown} input
 * @param {unknown} init
 * @returns {string}
 */
function fetchMethod(input, init) {
  return normalizeMethod(readField(init, "method") ?? readField(input, "method") ?? "GET");
}

/**
 * @param {unknown} response
 * @returns {number | undefined}
 */
function responseBodySize(response) {
  const headers = readField(response, "headers");
  return contentLengthBytes(callMethod(headers, "get", ["content-length"]) ?? callMethod(headers, "get", ["Content-Length"]));
}

/**
 * @param {BrowserFetchInput} request
 * @param {BrowserFetchPathTemplate | undefined} resourcePathTemplate
 * @param {string} method
 * @returns {string}
 */
function fetchPathTemplate(request, resourcePathTemplate, method) {
  const path = sanitizeSourcePath(request.url) ?? "/";
  if (typeof resourcePathTemplate === "function") {
    return routeTemplatePath(resourcePathTemplate({
      input: request.input,

      init: request.init,
      method,
      path
    }) ?? path);
  }
  if (typeof resourcePathTemplate === "string" && resourcePathTemplate.trim() !== "") {
    return routeTemplatePath(resourcePathTemplate);
  }
  return routeTemplatePath(path);
}

/**
 * @param {BrowserFetchInput} request
 * @param {BrowserFetchPathTemplate | undefined} resourcePathTemplate
 * @returns {FetchDetails}
 */
function fetchDetails(request, resourcePathTemplate) {
  const statusCode = nonNegativeIntegerOrUndefined(request.statusCode);
  const errorTypeValue = stringOrUndefined(request.errorType);
  const method = fetchMethod(request.input, { method: request.method });
  return {
    durationMs: nonNegativeNumberOrUndefined(request.durationMs) ?? NO_DURATION,
    errorType: errorTypeValue,
    method,
    requestPath: fetchPathTemplate(request, resourcePathTemplate, method),
    responseBodySize: nonNegativeIntegerOrUndefined(request.responseBodySize),
    status: errorTypeValue !== undefined || (statusCode !== undefined && statusCode >= ERROR_STATUS) ? "error" : "ok",
    statusCode,
    tracePropagated: request.tracePropagated === true
  };
}

/**
 * @param {FetchDetails} details
 * @returns {Record<string, unknown>}
 */
function fetchMetadata(details) {
  return {
    errorType: details.errorType,
    method: details.method,
    operation: "http.client",
    requestPath: details.requestPath,
    responseBodySize: details.responseBodySize,
    statusCode: details.statusCode,
    tracePropagated: details.tracePropagated
  };
}

module.exports = {
  contentLengthBytes,
  durationSince,
  errorType,
  fetchDetails,
  fetchMetadata,
  fetchMethod,
  nonNegativeIntegerOrUndefined,
  normalizeMethod,
  nowMs,
  responseBodySize,
  shouldCaptureRequest,
  traceparentFromTraceContext,
  validateTargets
};
