const { incrementBounded } = require("./bounded-number.cjs");
const { propertyOf } = require("./error-details.cjs");
const { automaticRetryDelayMs, rateLimitWaitMs } = require("./retry-delay.cjs");
const { SdkError } = require("./sdk-error.cjs");

/**
 * @typedef {"none" | "authentication" | "rate_limit" | "non_retryable"} PauseReason
 * @typedef {Readonly<{ pausedReason: PauseReason, retryDelayMs: number }>} FailurePlan
 * @typedef {Readonly<{ code: string, retryAfterMs: number | undefined, retryable: boolean | undefined }>} DeliveryFailure
 * @typedef {Readonly<{
 *   canDeliver: () => boolean,
 *   isOpen: () => boolean,
 *   queueLength: () => number,
 *   flush: () => Promise<unknown>,
 *   serialize: (operation: () => Promise<void>) => Promise<void>,
 *   deliveryIntervalMs: number,
 *   deliveryQueueThreshold: number
 * }>} DeliveryHost
 */

const NO_DELAY = 0;
/** @type {FailurePlan} */
const NON_RETRYABLE = { pausedReason: "non_retryable", retryDelayMs: NO_DELAY };
const NO_EVENTS = 0;

/**
 * @param {unknown} timer
 * @returns {void}
 */
function unrefTimer(timer) {
  const unref = typeof timer === "object" ? propertyOf(timer, "unref") : undefined;
  if (typeof unref === "function") {
    Reflect.apply(unref, timer, []);
  }
}

/**
 * @param {unknown} reason
 * @returns {DeliveryFailure | undefined}
 */
function deliveryFailure(reason) {
  if (!(reason instanceof SdkError)) {
    return undefined;
  }
  return { code: reason.code, retryAfterMs: reason.retryAfterMs, retryable: reason.retryable };
}

/**
 * @param {DeliveryFailure} reason
 * @param {number} retryDelayMs
 * @returns {FailurePlan}
 */
function sdkFailurePlan(reason, retryDelayMs) {
  if (reason.code === "unauthenticated") {
    return { pausedReason: "authentication", retryDelayMs: NO_DELAY };
  }
  if (reason.code === "rate_limited") {
    return reason.retryable === true
      ? { pausedReason: "none", retryDelayMs: rateLimitWaitMs(reason.retryAfterMs ?? retryDelayMs) }
      : { pausedReason: "rate_limit", retryDelayMs: NO_DELAY };
  }
  return reason.retryable === true
    ? { pausedReason: "none", retryDelayMs }
    : { pausedReason: "non_retryable", retryDelayMs: NO_DELAY };
}

class AutomaticDelivery {
  /**
   * @param {DeliveryHost} host
   */
  constructor(host) {
    this.host = host;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.deliveryTimer = undefined;
    this.automaticFlushActive = false;
    this.automaticFlushPending = false;
    /** @type {PauseReason} */
    this.automaticPauseReason = "none";
    this.consecutiveDeliveryFailures = 0;
    this.retryDelayMs = 0;
  }

  /**
   * @returns {boolean}
   */
  ready() {
    return this.host.canDeliver() && this.automaticPauseReason === "none";
  }

  /**
   * @returns {void}
   */
  schedule() {
    if (!this.ready()) {
      return;
    }
    if (this.automaticFlushActive) {
      this.automaticFlushPending = true;
    } else if (this.retryDelayMs > NO_DELAY) {
      this.armTimer(this.retryDelayMs);
    } else if (this.host.queueLength() >= this.host.deliveryQueueThreshold) {
      this.requestFlush();
    } else {
      this.armTimer(this.host.deliveryIntervalMs);
    }
  }

  /**
   * @param {number} delayMs
   * @returns {void}
   */
  armTimer(delayMs) {
    if (!this.ready() || this.deliveryTimer !== undefined) {
      return;
    }
    const timer = setTimeout(() => {
      if (this.deliveryTimer !== timer) {
        return;
      }
      this.deliveryTimer = undefined;
      this.retryDelayMs = 0;
      this.requestFlush();
    }, delayMs);
    this.deliveryTimer = timer;
    unrefTimer(timer);
  }

  /**
   * @returns {void}
   */
  clearTimer() {
    if (this.deliveryTimer === undefined) {
      return;
    }
    globalThis.clearTimeout(this.deliveryTimer);
    this.deliveryTimer = undefined;
  }

  /**
   * @returns {void}
   */
  requestFlush() {
    if (!this.ready()) {
      return;
    }
    this.clearTimer();
    if (this.automaticFlushActive) {
      this.automaticFlushPending = true;
      return;
    }
    this.automaticFlushActive = true;
    queueMicrotask(() => {
      void this.runFlush();
    });
  }

  /**
   * @returns {Promise<void>}
   */
  async runFlush() {
    if (this.stopWhenClosed()) {
      return;
    }
    await this.host.serialize(async () => {
      let succeeded = false;
      try {
        await this.host.flush();
        this.recordSuccess();
        succeeded = true;
      } catch (error) {
        this.recordFailure(error);
      } finally {
        this.automaticFlushActive = false;
        this.afterFlush(succeeded);
      }
    });
  }

  /**
   * @returns {boolean}
   */
  stopWhenClosed() {
    if (this.host.isOpen()) {
      return false;
    }
    this.automaticFlushActive = false;
    this.automaticFlushPending = false;
    return true;
  }

  /**
   * @param {boolean} succeeded
   * @returns {void}
   */
  afterFlush(succeeded) {
    if (!this.host.isOpen()) {
      this.automaticFlushPending = false;
      return;
    }
    const drainCoalesced = succeeded && this.automaticFlushPending && this.host.queueLength() > NO_EVENTS;
    this.automaticFlushPending = false;
    if (drainCoalesced) {
      this.requestFlush();
    } else if (succeeded) {
      this.schedule();
    } else {
      this.resume();
    }
  }

  /**
   * @returns {void}
   */
  recordSuccess() {
    this.automaticPauseReason = "none";
    this.consecutiveDeliveryFailures = 0;
    this.retryDelayMs = 0;
  }

  /**
   * @param {unknown} reason
   * @returns {void}
   */
  recordFailure(reason) {
    this.consecutiveDeliveryFailures = incrementBounded(this.consecutiveDeliveryFailures);
    this.retryDelayMs = 0;
    const failure = deliveryFailure(reason);
    const plan = failure === undefined ? NON_RETRYABLE : sdkFailurePlan(failure, this.backoffDelayMs(failure));
    this.automaticPauseReason = plan.pausedReason;
    this.retryDelayMs = plan.retryDelayMs;
  }

  /**
   * @param {DeliveryFailure} reason
   * @returns {number}
   */
  backoffDelayMs(reason) {
    const backoff = reason.code !== "unauthenticated" && reason.retryable === true
      && (reason.code !== "rate_limited" || reason.retryAfterMs === undefined);
    return backoff ? automaticRetryDelayMs(this.host.deliveryIntervalMs, this.consecutiveDeliveryFailures) : NO_DELAY;
  }

  /**
   * @returns {void}
   */
  resume() {
    if (this.automaticPauseReason !== "none") {
      return;
    }
    if (this.retryDelayMs > NO_DELAY) {
      this.armTimer(this.retryDelayMs);
      return;
    }
    this.schedule();
  }

  /**
   * @returns {Readonly<{ scheduled: boolean, coalesced: boolean, pausedReason: PauseReason, consecutiveFailures: number, retryDelayMs: number }>}
   */
  health() {
    return {
      coalesced: this.automaticFlushPending,
      consecutiveFailures: this.consecutiveDeliveryFailures,
      pausedReason: this.automaticPauseReason,
      retryDelayMs: this.retryDelayMs,
      scheduled: this.deliveryTimer !== undefined
    };
  }
}

module.exports = { AutomaticDelivery };
