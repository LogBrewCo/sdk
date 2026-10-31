const MAX_DELIVERY_INTERVAL_MS = 60_000;
const MIN_RATE_LIMIT_WAIT_MS = 1000;
const MAX_RATE_LIMIT_WAIT_MS = 3_600_000;
const MAX_BACKOFF_EXPONENT = 30;
const FIRST_FAILURE = 1;
const BACKOFF_BASE = 2;
const HALF = 2;
const INCLUSIVE = 1;
const JITTER_DIVISOR = 10;

/**
 * @param {number} deliveryIntervalMs
 * @param {number} consecutiveFailures
 * @returns {number}
 */
function automaticRetryDelayMs(deliveryIntervalMs, consecutiveFailures) {
  const exponent = Math.min(consecutiveFailures - FIRST_FAILURE, MAX_BACKOFF_EXPONENT);
  const maximumDelay = Math.min(MAX_DELIVERY_INTERVAL_MS, deliveryIntervalMs * (BACKOFF_BASE ** exponent));
  const minimumDelay = Math.ceil(maximumDelay / HALF);
  return minimumDelay + Math.floor(Math.random() * (maximumDelay - minimumDelay + INCLUSIVE));
}

/**
 * @param {number} delayMs
 * @returns {number}
 */
function rateLimitWaitMs(delayMs) {
  const bounded = Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(MIN_RATE_LIMIT_WAIT_MS, delayMs));
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, bounded + Math.floor(Math.random() * (Math.floor(bounded / JITTER_DIVISOR) + INCLUSIVE)));
}

module.exports = { MAX_DELIVERY_INTERVAL_MS, automaticRetryDelayMs, rateLimitWaitMs };
