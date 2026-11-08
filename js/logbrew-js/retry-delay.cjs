const MAX_DELIVERY_INTERVAL_MS = 60_000;
const MAX_PAUSE_PROBE_DELAY_MS = 300_000;
const MIN_RATE_LIMIT_WAIT_MS = 1000;
const MAX_RATE_LIMIT_WAIT_MS = 3_600_000;
const MAX_BACKOFF_EXPONENT = 30;
const FIRST_FAILURE = 1;
const NO_EXPONENT = 0;
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
 * @param {number} maxRetryDelayMs
 * @param {number} consecutiveFailures
 * @param {number} [jitter]
 * @returns {number}
 */
function pauseProbeDelayMs(maxRetryDelayMs, consecutiveFailures, jitter = Math.random()) {
  const exponent = Math.min(Math.max(NO_EXPONENT, consecutiveFailures - FIRST_FAILURE), MAX_BACKOFF_EXPONENT);
  const ceiling = Math.min(maxRetryDelayMs * (BACKOFF_BASE ** exponent), Math.max(maxRetryDelayMs, MAX_PAUSE_PROBE_DELAY_MS));
  return Math.floor(ceiling / HALF + (ceiling / HALF) * jitter);
}

/**
 * @param {number} delayMs
 * @returns {number}
 */
function rateLimitWaitMs(delayMs) {
  const bounded = Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(MIN_RATE_LIMIT_WAIT_MS, delayMs));
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, bounded + Math.floor(Math.random() * (Math.floor(bounded / JITTER_DIVISOR) + INCLUSIVE)));
}

module.exports = { MAX_DELIVERY_INTERVAL_MS, automaticRetryDelayMs, pauseProbeDelayMs, rateLimitWaitMs };
