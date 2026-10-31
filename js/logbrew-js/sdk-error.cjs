const MIN_RETRY_AFTER_MS = 0;

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function retryAfterMsOrUndefined(value) {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_RETRY_AFTER_MS ? value : undefined;
}

class SdkError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Readonly<{ retryAfterMs?: unknown, retryable?: unknown }> | null} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SdkError";
    this.code = code;
    const retryAfterMs = retryAfterMsOrUndefined(details?.retryAfterMs);
    if (retryAfterMs !== undefined) {
      /** @type {number | undefined} */
      this.retryAfterMs = retryAfterMs;
    }
    if (details?.retryable === true) {
      /** @type {boolean | undefined} */
      this.retryable = true;
    }
  }
}

module.exports = { SdkError, retryAfterMsOrUndefined };
