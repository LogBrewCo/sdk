"use strict";

const { callMethod, readField } = require("./values.cjs");

/**
 * @import { TransportResponse } from "@logbrew/sdk"
 * @typedef {{ readonly headers?: unknown, readonly status: number, readonly text?: unknown }} HttpResponse
 */

const RATE_LIMIT_BODY_LIMIT_BYTES = 4096;
const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
const TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;
const NO_DELAY = 0;
const SINGLE_ATTEMPT = 1;

/**
 * @param {unknown} value
 * @param {number} [now]
 * @returns {number | undefined}
 */
function retryAfterMsFromHeader(value, now = Date.now()) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const milliseconds = Number(trimmed) * MS_PER_SECOND;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const timestamp = HTTP_DATE.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  return Number.isFinite(timestamp) ? Math.max(NO_DELAY, timestamp - now) : undefined;
}

/**
 * @param {HttpResponse} response
 * @param {string} name
 * @returns {unknown}
 */
function responseHeader(response, name) {
  return callMethod(response.headers, "get", [name]);
}

/**
 * @param {HttpResponse} response
 * @returns {Promise<string | undefined>}
 */
async function rateLimitCode(response) {
  try {
    const length = Number(responseHeader(response, "content-length"));
    if (!Number.isSafeInteger(length) || length > RATE_LIMIT_BODY_LIMIT_BYTES || typeof response.text !== "function") {
      return undefined;
    }
    /** @type {unknown} */
    const text = await callMethod(response, "text", []);
    const code = typeof text === "string" && text.length <= RATE_LIMIT_BODY_LIMIT_BYTES ? readField(JSON.parse(text), "code") : undefined;
    return code === "rate_limited" || code === "usage_limit_exceeded" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {HttpResponse} response
 * @returns {Promise<TransportResponse>}
 */
async function transportResponse(response) {
  const retryAfterMs = retryAfterMsFromHeader(responseHeader(response, "retry-after"));
  const errorCode = response.status === TOO_MANY_REQUESTS ? await rateLimitCode(response) : undefined;
  return {
    statusCode: response.status,

    attempts: SINGLE_ATTEMPT,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(errorCode === undefined ? {} : { errorCode })
  };
}

module.exports = { retryAfterMsFromHeader, transportResponse };
