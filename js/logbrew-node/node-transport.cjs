"use strict";

const { TransportError, SdkError } = require("@logbrew/sdk");
const { callMethod, isTruthy, readMember, readOptionalMember } = require("./internal.cjs");
const { ignoreBreadcrumbUrl } = require("./breadcrumbs.cjs");
const { errorMessage } = require("./span-support.cjs");

/**
 * @import { Transport, TransportResponse } from "@logbrew/sdk"
 */

/**
 * @typedef {Readonly<{ endpoint: unknown, fetchImpl: unknown, headers: Readonly<Record<string, string>> | undefined }>} FetchTransportSettings
 */

const RATE_LIMIT_BODY_LIMIT_BYTES = 4096;
const RATE_LIMITED_STATUS = 429;
const SINGLE_ATTEMPT = 1;
const MILLISECONDS_PER_SECOND = 1000;
const NO_DELAY = 0;
const NO_BYTES = 0;
const WHOLE_SECONDS = /^\d+$/u;
const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

/**
 * @param {unknown} value
 * @returns {value is typeof fetch}
 */
function isFetch(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} headers
 * @returns {string | undefined}
 */
function readRetryAfter(headers) {
  if (!isTruthy(headers) || typeof readMember(headers, "get") !== "function") {
    return undefined;
  }
  const value = callMethod(headers, "get", ["retry-after"]);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * @param {unknown} headers
 * @returns {number | undefined}
 */
function retryAfterMsFromHeaders(headers) {
  const trimmed = readRetryAfter(headers);
  if (trimmed === undefined) {
    return undefined;
  }
  if (WHOLE_SECONDS.test(trimmed)) {
    const milliseconds = Number(trimmed) * MILLISECONDS_PER_SECOND;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const timestamp = HTTP_DATE.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  return Number.isFinite(timestamp) ? Math.max(NO_DELAY, timestamp - Date.now()) : undefined;
}

/**
 * @param {unknown} value
 * @returns {Buffer}
 */
function bodyChunk(value) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("The response body chunk must be a Uint8Array");
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * @param {unknown} reader
 * @param {Buffer} body
 * @returns {Promise<Buffer | undefined>}
 */
async function readLimitedBody(reader, body) {
  /** @type {unknown} */
  const result = await callMethod(reader, "read", []);
  if (isTruthy(readMember(result, "done"))) {
    return body;
  }
  const value = readMember(result, "value");
  if (body.length + Number(readMember(value, "byteLength")) > RATE_LIMIT_BODY_LIMIT_BYTES) {
    await callMethod(reader, "cancel", []);
    return undefined;
  }
  return readLimitedBody(reader, Buffer.concat([body, bodyChunk(value)]));
}

/**
 * @param {unknown} response
 * @returns {unknown}
 */
function openBodyReader(response) {
  const body = readMember(response, "body");
  const getReader = readOptionalMember(body, "getReader");
  return getReader === undefined || getReader === null ? undefined : callMethod(body, "getReader", []);
}

/**
 * @param {Buffer} body
 * @returns {string | undefined}
 */
function parseRateLimitCode(body) {
  /** @type {unknown} */
  const parsed = JSON.parse(body.toString("utf8"));
  const code = readOptionalMember(parsed, "code");
  return code === "rate_limited" || code === "usage_limit_exceeded" ? code : undefined;
}

/**
 * @param {unknown} response
 * @returns {Promise<string | undefined>}
 */
async function rateLimitCode(response) {
  try {
    const reader = openBodyReader(response);
    if (!isTruthy(reader)) {
      return undefined;
    }
    const body = await readLimitedBody(reader, Buffer.alloc(NO_BYTES));
    return body === undefined ? undefined : parseRateLimitCode(body);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} exitAbort
 * @returns {AbortSignal}
 */
function exitSignal(exitAbort) {
  if (!(exitAbort instanceof AbortController)) {
    throw new TypeError("Cannot read properties of undefined (reading 'signal')");
  }
  return exitAbort.signal;
}

/**
 * @param {unknown} fetchImpl
 * @param {unknown} exitAbort
 * @returns {unknown}
 */
function abortableFetch(fetchImpl, exitAbort) {
  const signal = exitSignal(exitAbort);
  if (!isFetch(fetchImpl)) {
    return fetchImpl;
  }
  const fetchFunction = fetchImpl;
  /**
   * @param {string | URL | Request} url
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async function abortable(url, init) {
    return fetchFunction(url, { ...init, signal });
  }
  return abortable;
}

/**
 * @param {FetchTransportSettings} settings
 * @returns {Transport}
 */
function createFetchTransport({ endpoint, fetchImpl, headers }) {
  ignoreBreadcrumbUrl(endpoint);
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new SdkError("configuration_error", "createNodeFetchTransport requires a non-empty endpoint");
  }
  if (!isFetch(fetchImpl)) {
    throw new SdkError("configuration_error", "createNodeFetchTransport requires fetch");
  }
  return {
    async send(apiKey, body) {
      try {
        const response = await fetchImpl(endpoint, {
          body,
          headers: {
            "content-type": "application/json",

            authorization: `Bearer ${apiKey}`,
            ...headers
          },
          method: "POST"
        });
        const retryAfterMs = retryAfterMsFromHeaders(response.headers);
        const errorCode = response.status === RATE_LIMITED_STATUS ? await rateLimitCode(response) : undefined;
        /** @type {TransportResponse} */
        const result = {
          statusCode: response.status,

          attempts: SINGLE_ATTEMPT,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          ...(errorCode === undefined ? {} : { errorCode })
        };
        return result;
      } catch (error) {
        throw TransportError.network(`fetch failed: ${errorMessage(error)}`);
      }
    }
  };
}

module.exports = { abortableFetch, createFetchTransport };
