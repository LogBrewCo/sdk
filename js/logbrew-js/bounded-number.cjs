const STEP = 1;
const EPOCH_MS = 0;

/**
 * @param {number} current
 * @param {number} increment
 * @returns {number}
 */
function addBounded(current, increment) {
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}

/**
 * @param {number} value
 * @returns {number}
 */
function incrementBounded(value) {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + STEP;
}

/**
 * @param {number} previous
 * @returns {number}
 */
function nextBoundedTimestamp(previous) {
  const now = Date.now();
  if (!Number.isFinite(now)) {
    return previous;
  }
  const bounded = Math.min(Number.MAX_SAFE_INTEGER, Math.max(EPOCH_MS, Math.floor(now)));
  return Math.max(previous, bounded);
}

module.exports = { addBounded, incrementBounded, nextBoundedTimestamp };
