const { SdkError, TransportError } = require("@logbrew/sdk");
const { readField, textOf } = require("./index-values.cjs");

/**
 * @typedef {{ readonly get: (name: string) => unknown }} HeadersLike
 * @typedef {(endpoint: string, init: Readonly<Record<string, unknown>>) => unknown} FetchLike
 * @typedef {{
 *   readonly endpoint?: unknown,
 *   readonly fetchImpl?: unknown,
 *   readonly headers?: unknown
 * }} FetchTransportConfig
 * @typedef {{
 *   statusCode: unknown,
 *   attempts: number,
 *   retryAfterMs?: number,
 *   errorCode?: string
 * }} FetchTransportResponse
 * @typedef {{ readonly send: (apiKey: string, body: string) => Promise<FetchTransportResponse> }} FetchTransport
 */

const DEFAULT_ENDPOINT = "https://api.logbrew.co/v1/events";
const RATE_LIMIT_BODY_LIMIT_BYTES = 4096;
const TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;
const NO_WAIT = 0;
const SINGLE_ATTEMPT = 1;
const RETRY_AFTER_SECONDS_RE = /^\d+$/u;
const HTTP_DATE_RE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

/**
 * @param {unknown} value
 * @returns {value is FetchLike}
 */
function isFetchLike(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is HeadersLike}
 */
function isHeadersLike(value) {
  return typeof readField(value, "get") === "function";
}

/**
 * @param {unknown} value
 * @returns {value is { readonly text: () => unknown }}
 */
function hasText(value) {
  return typeof readField(value, "text") === "function";
}

/**
 * @returns {FetchLike | undefined}
 */
function defaultFetch() {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
}

/**
 * @param {string} endpoint
 * @returns {URL}
 */
function parseEndpointUrl(endpoint) {
  try {
    return new URL(endpoint);
  } catch {
    throw new SdkError("configuration_error", "createReactNativeFetchTransport endpoint must be an absolute URL");
  }
}

/**
 * @param {unknown} endpoint
 * @returns {asserts endpoint is string}
 */
function validateDeliveryEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new SdkError("configuration_error", "createReactNativeFetchTransport requires a non-empty endpoint");
  }
  const parsed = parseEndpointUrl(endpoint);
  if (parsed.protocol !== "https:") {
    throw new SdkError("configuration_error", "createReactNativeFetchTransport endpoint must use HTTPS");
  }
  if (endpoint !== `${parsed.origin}${parsed.pathname}`) {
    throw new SdkError("configuration_error", "createReactNativeFetchTransport endpoint must be a plain HTTPS path");
  }
}

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
  if (RETRY_AFTER_SECONDS_RE.test(trimmed)) {
    const milliseconds = Number(trimmed) * MS_PER_SECOND;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const timestamp = HTTP_DATE_RE.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  return Number.isFinite(timestamp) ? Math.max(NO_WAIT, timestamp - now) : undefined;
}

/**
 * @param {unknown} headers
 * @returns {number | undefined}
 */
function retryAfterMsFromHeaders(headers) {
  if (!isHeadersLike(headers)) {
    return undefined;
  }
  return retryAfterMsFromHeader(headers.get("retry-after"));
}

/**
 * @param {unknown} response
 * @returns {number}
 */
function declaredContentLength(response) {
  const headers = readField(response, "headers");
  return Number(isHeadersLike(headers) ? headers.get("content-length") : undefined);
}

/**
 * @param {unknown} text
 * @returns {unknown}
 */
function rateLimitBodyCode(text) {
  const textLength = typeof text === "string" ? text.length : readField(text, "length");
  /** @type {unknown} */
  const parsed = Number(textLength) <= RATE_LIMIT_BODY_LIMIT_BYTES ? JSON.parse(textOf(text)) : undefined;
  return readField(parsed, "code");
}

/**
 * @param {unknown} response
 * @returns {Promise<string | undefined>}
 */
async function rateLimitCode(response) {
  try {
    const length = declaredContentLength(response);
    if (!Number.isSafeInteger(length) || length > RATE_LIMIT_BODY_LIMIT_BYTES || !hasText(response)) {
      return undefined;
    }
    const code = rateLimitBodyCode(await response.text());
    return code === "rate_limited" || code === "usage_limit_exceeded" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {FetchTransportConfig} [config]
 * @returns {FetchTransport}
 */
function createReactNativeFetchTransport({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = defaultFetch(),
  headers = {}
} = {}) {
  validateDeliveryEndpoint(endpoint);
  if (!isFetchLike(fetchImpl)) {
    throw new SdkError("configuration_error", "createReactNativeFetchTransport requires fetch");
  }
  if (headers === null || Array.isArray(headers) || typeof headers !== "object") {
    throw new SdkError("configuration_error", "createReactNativeFetchTransport headers must be an object");
  }

  return Object.freeze({
    async send(apiKey, body) {
      try {
        const response = await fetchImpl(endpoint, {
          body,
          headers: {
            ...headers,
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json"
          },
          method: "POST"
        });
        const retryAfterMs = retryAfterMsFromHeaders(readField(response, "headers"));
        const errorCode = readField(response, "status") === TOO_MANY_REQUESTS ? await rateLimitCode(response) : undefined;
        return {
          statusCode: readField(response, "status"),

          attempts: SINGLE_ATTEMPT,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          ...(errorCode === undefined ? {} : { errorCode })
        };
      } catch {
        throw TransportError.network("LogBrew React Native delivery failed");
      }
    }
  });
}

module.exports = { createReactNativeFetchTransport, defaultFetch };
