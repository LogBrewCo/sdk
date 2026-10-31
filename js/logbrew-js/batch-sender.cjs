const { incrementBounded, nextBoundedTimestamp } = require("./bounded-number.cjs");
const { propertyOf } = require("./error-details.cjs");
const { SdkError, retryAfterMsOrUndefined } = require("./sdk-error.cjs");
const { TransportError } = require("./transport-error.cjs");
const { isRecord } = require("./validation.cjs");

/**
 * @typedef {"none" | "transport_error" | "invalid_response" | "network_error" | "success" | "client_error" | "server_error" | "other_status"} StatusClass
 * @typedef {Readonly<{ send: (apiKey: string, body: string) => unknown }>} BatchTransport
 * @typedef {Readonly<{ statusCode: number, attempts: number }>} SendResult
 * @typedef {Readonly<{ apiKey: () => string, maxRetries: number }>} SenderConfig
 */

const FIRST_ATTEMPT = 1;
const MIN_STATUS = 100;
const MAX_STATUS = 599;
const MIN_SUCCESS = 200;
const MIN_REDIRECT = 300;
const MIN_CLIENT_ERROR = 400;
const MIN_SERVER_ERROR = 500;
const UNAUTHORIZED = 401;
const REQUEST_TIMEOUT = 408;
const TOO_MANY_REQUESTS = 429;

/**
 * @param {number} statusCode
 * @returns {StatusClass}
 */
function statusClass(statusCode) {
  if (statusCode >= MIN_SUCCESS && statusCode < MIN_REDIRECT) {
    return "success";
  }
  if (statusCode >= MIN_CLIENT_ERROR && statusCode < MIN_SERVER_ERROR) {
    return "client_error";
  }
  return statusCode >= MIN_SERVER_ERROR ? "server_error" : "other_status";
}

/**
 * @param {Readonly<Record<string, unknown>>} response
 * @returns {number | undefined}
 */
function validStatusCode(response) {
  const { statusCode } = response;
  if (typeof statusCode !== "number" || !Number.isSafeInteger(statusCode)) {
    return undefined;
  }
  return statusCode >= MIN_STATUS && statusCode <= MAX_STATUS ? statusCode : undefined;
}

/**
 * @param {unknown} response
 * @param {number} statusCode
 * @returns {void}
 */
function rejectRefusal(response, statusCode) {
  if (statusCode === UNAUTHORIZED) {
    throw new SdkError("unauthenticated", "transport rejected the API key");
  }
  if (statusCode === TOO_MANY_REQUESTS) {
    const retryAfterMs = propertyOf(response, "retryAfterMs");
    const errorCode = propertyOf(response, "errorCode");
    throw new SdkError("rate_limited", "transport rate limited the batch", {
      retryAfterMs,
      retryable: errorCode !== "usage_limit_exceeded"
        && (retryAfterMsOrUndefined(retryAfterMs) !== undefined || errorCode === "rate_limited")
    });
  }
}

class BatchSender {
  /**
   * @param {SenderConfig} config
   */
  constructor(config) {
    this.apiKey = config.apiKey;
    this.maxRetries = config.maxRetries;
    this.deliveryAttemptCount = 0;
    this.lastAttemptAtUnixMs = 0;
    /** @type {StatusClass} */
    this.lastStatusClass = "none";
  }

  /**
   * @param {BatchTransport} transport
   * @param {string} body
   * @returns {Promise<SendResult>}
   */
  async send(transport, body) {
    const maxAttempts = this.maxRetries + FIRST_ATTEMPT;
    for (let attempts = FIRST_ATTEMPT; attempts <= maxAttempts; attempts += FIRST_ATTEMPT) {
      this.beginAttempt();
      const canRetry = attempts < maxAttempts;
      try {
        const statusCode = this.acceptedStatus(await transport.send(this.apiKey(), body), canRetry);
        if (statusCode !== undefined) {
          return { attempts, statusCode };
        }
      } catch (error) {
        this.recover(error, canRetry);
      }
    }
    throw new SdkError("transport_error", "exhausted retries");
  }

  /**
   * @returns {void}
   */
  beginAttempt() {
    this.deliveryAttemptCount = incrementBounded(this.deliveryAttemptCount);
    this.lastAttemptAtUnixMs = nextBoundedTimestamp(this.lastAttemptAtUnixMs);
    this.lastStatusClass = "transport_error";
  }

  /**
   * @param {unknown} response
   * @param {boolean} canRetry
   * @returns {number | undefined}
   */
  acceptedStatus(response, canRetry) {
    const statusCode = this.classifiedStatus(response);
    rejectRefusal(response, statusCode);
    if (statusCode >= MIN_SUCCESS && statusCode < MIN_REDIRECT) {
      return statusCode;
    }
    const retryableStatus = statusCode === REQUEST_TIMEOUT || statusCode >= MIN_SERVER_ERROR;
    if (retryableStatus && canRetry) {
      return undefined;
    }
    throw new SdkError("transport_error", `unexpected transport status ${statusCode}`, { retryable: retryableStatus });
  }

  /**
   * @param {unknown} response
   * @returns {number}
   */
  classifiedStatus(response) {
    const statusCode = isRecord(response) ? validStatusCode(response) : undefined;
    if (statusCode === undefined) {
      this.lastStatusClass = "invalid_response";
      throw new SdkError("transport_error", "invalid transport response");
    }
    this.lastStatusClass = statusClass(statusCode);
    return statusCode;
  }

  /**
   * @param {unknown} reason
   * @param {boolean} canRetry
   * @returns {void}
   */
  recover(reason, canRetry) {
    if (reason instanceof SdkError || !(reason instanceof TransportError)) {
      throw reason;
    }
    this.lastStatusClass = "network_error";
    if (reason.retryable && canRetry) {
      return;
    }
    throw new SdkError(reason.code, reason.message, { retryable: reason.retryable });
  }
}

module.exports = { BatchSender };
