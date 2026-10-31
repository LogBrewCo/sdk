"use strict";

const { createReactNativeErrorEvent } = require("./index.cjs");
const { captureIssueWithAdmission } = require("./fatal-replay.cjs");
const {
  DiagnosticGate,
  emitDiagnostic,
  hasControlCharacter,
  incrementBounded,
  isObjectLike,
  safeFunction,
  safeReadProperty
} = require("./global-errors-support.cjs");

/**
 * @import { UnknownFunction } from "./global-errors-support.cjs"
 * @import { ReactNativeErrorEvent } from "./index.cjs"
 * @import { Admission } from "./fatal-admission.cjs"
 * @import { LogBrewReactNativePromiseRejectionHandlers, ReactNativePromiseRejectionHealth } from "./global-errors.cjs"
 * @typedef {ReactNativePromiseRejectionHealth["lastOutcome"]} RejectionOutcome
 * @typedef {Readonly<{
 *   client: unknown,
 *   issue: UnknownFunction,
 *   maxTrackedRejections: number,
 *   mechanism: string,
 *   onDiagnostic: unknown
 * }>} RejectionTrackingOptions
 */

const AUTOMATIC_MESSAGE = "Unhandled Promise rejection";
const DEFAULT_MAX_TRACKED_REJECTIONS = 128;
const MAX_TRACKED_REJECTIONS = 1024;
const MIN_TRACKED_REJECTIONS = 1;
const MAX_STRING_ID_LENGTH = 128;
const MIN_NUMBER_ID = 0;
const MIN_STRING_ID_LENGTH = 1;
const NO_COUNT = 0;
const ID_RADIX = 36;
/** @type {Readonly<Record<"dropped" | "filtered" | "unavailable", readonly [RejectionOutcome, string]>>} */
const ADMISSION_FAILURES = {
  dropped: ["capture_failed", "promise_rejection_capture_failed"],
  filtered: ["filtered", "promise_rejection_filtered"],
  unavailable: ["admission_unavailable", "promise_rejection_admission_unavailable"]
};
const sequence = { next: NO_COUNT };

/**
 * @returns {string}
 */
function nextEventId() {
  sequence.next = incrementBounded(sequence.next);
  return `evt_rn_promise_${Date.now().toString(ID_RADIX)}_${sequence.next.toString(ID_RADIX)}`;
}

/**
 * @param {string} mechanism
 * @returns {ReactNativeErrorEvent}
 */
function createEvent(mechanism) {
  const error = new Error(AUTOMATIC_MESSAGE);
  delete error.stack;
  const event = createReactNativeErrorEvent(error, {
    handled: false,
    id: nextEventId(),
    includeStack: false,
    mechanism
  });
  return {
    ...event,
    attributes: {
      ...event.attributes,
      message: AUTOMATIC_MESSAGE,
      metadata: {
        ...event.attributes.metadata,
        automatic: true,
        fatal: false,
        handled: false,
        mechanism,
        source: "react-native.promise_rejection"
      },
      title: AUTOMATIC_MESSAGE
    }
  };
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function rejectionKey(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_NUMBER_ID) {
    return `number:${value}`;
  }
  if (typeof value === "string"
    && value.length >= MIN_STRING_ID_LENGTH
    && value.length <= MAX_STRING_ID_LENGTH
    && !hasControlCharacter(value)) {
    return `string:${value}`;
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function validMaximum(value) {
  return Number.isInteger(value) && typeof value === "number"
    && value >= MIN_TRACKED_REJECTIONS && value <= MAX_TRACKED_REJECTIONS;
}

/**
 * @returns {LogBrewReactNativePromiseRejectionHandlers}
 */
function inactiveHandlers() {
  const snapshot = Object.freeze({
    available: false,
    capturedEvents: NO_COUNT,
    evictedRejections: NO_COUNT,
    handledLaterEvents: NO_COUNT,
    lastOutcome: "unavailable",
    maxTrackedRejections: NO_COUNT,
    suppressedEvents: NO_COUNT,
    trackedRejections: NO_COUNT,
    unknownHandledEvents: NO_COUNT,
    untrackedEvents: NO_COUNT
  });
  return Object.freeze({
    health: () => snapshot,
    onHandled: () => undefined,
    onUnhandled: () => undefined
  });
}

class RejectionTracking {
  capturedEvents = NO_COUNT;
  emittedEvictionDiagnostic = false;
  evictedRejections = NO_COUNT;
  handledLaterEvents = NO_COUNT;
  handling = false;
  suppressedEvents = NO_COUNT;
  unknownHandledEvents = NO_COUNT;
  untrackedEvents = NO_COUNT;

  /**
   * @param {RejectionTrackingOptions} options
   */
  constructor(options) {
    this.options = options;
    this.diagnostics = new DiagnosticGate(options.onDiagnostic);
    /** @type {RejectionOutcome} */
    this.lastOutcome = "idle";
    /** @type {Map<string, boolean>} */
    this.tracked = new Map();
  }

  /**
   * @returns {ReactNativePromiseRejectionHealth}
   */
  health() {
    return Object.freeze({
      available: true,
      capturedEvents: this.capturedEvents,
      evictedRejections: this.evictedRejections,
      handledLaterEvents: this.handledLaterEvents,
      lastOutcome: this.lastOutcome,
      maxTrackedRejections: this.options.maxTrackedRejections,
      suppressedEvents: this.suppressedEvents,
      trackedRejections: this.tracked.size,
      unknownHandledEvents: this.unknownHandledEvents,
      untrackedEvents: this.untrackedEvents
    });
  }

  /**
   * @param {string} code
   * @param {RejectionOutcome} outcome
   * @returns {void}
   */
  suppress(code, outcome) {
    this.suppressedEvents = incrementBounded(this.suppressedEvents);
    this.lastOutcome = outcome;
    this.diagnostics.emit(code);
  }

  /**
   * @returns {void}
   */
  recordUnknownHandled() {
    this.unknownHandledEvents = incrementBounded(this.unknownHandledEvents);
    this.lastOutcome = "handled_unknown";
  }

  /**
   * @param {unknown} runtimeRejectionId
   * @returns {void}
   */
  handled(runtimeRejectionId) {
    const key = rejectionKey(runtimeRejectionId);
    const handled = key === undefined ? undefined : this.tracked.get(key);
    if (key === undefined || handled === undefined) {
      this.recordUnknownHandled();
      return;
    }
    if (handled) {
      this.suppress("promise_rejection_duplicate_suppressed", "duplicate_suppressed");
    } else {
      this.recordHandledLater(key);
    }
  }

  /**
   * @param {string} key
   * @returns {void}
   */
  recordHandledLater(key) {
    this.tracked.set(key, true);
    this.handledLaterEvents = incrementBounded(this.handledLaterEvents);
    this.lastOutcome = "handled_later";
  }

  /**
   * @param {Exclude<Admission, "admitted">} admission
   * @returns {void}
   */
  rejectAdmission(admission) {
    const [outcome, code] = ADMISSION_FAILURES[admission];
    this.lastOutcome = outcome;
    this.diagnostics.emit(code);
  }

  /**
   * @returns {boolean}
   */
  evictOldestAtCapacity() {
    const oldest = this.tracked.keys().next().value;
    if (this.tracked.size !== this.options.maxTrackedRejections || oldest === undefined) {
      return false;
    }
    this.tracked.delete(oldest);
    this.evictedRejections = incrementBounded(this.evictedRejections);
    if (!this.emittedEvictionDiagnostic) {
      this.emittedEvictionDiagnostic = true;
      this.diagnostics.emit("promise_rejection_tracking_evicted");
    }
    return true;
  }

  /**
   * @param {string} key
   * @returns {void}
   */
  track(key) {
    const evicted = this.evictOldestAtCapacity();
    this.tracked.set(key, false);
    this.lastOutcome = evicted ? "captured_with_eviction" : "captured";
  }

  /**
   * @param {string | undefined} key
   * @returns {void}
   */
  capture(key) {
    if (key === undefined) {
      this.diagnostics.emit("promise_rejection_id_unavailable");
    }
    const { client, issue, mechanism } = this.options;
    const event = createEvent(mechanism);
    const admission = captureIssueWithAdmission(client, issue, event.id, event.timestamp, event.attributes);
    if (admission === "admitted") {
      this.recordCaptured(key);
    } else {
      this.rejectAdmission(admission);
    }
  }

  /**
   * @param {string | undefined} key
   * @returns {void}
   */
  recordCaptured(key) {
    this.capturedEvents = incrementBounded(this.capturedEvents);
    if (key === undefined) {
      this.untrackedEvents = incrementBounded(this.untrackedEvents);
      this.lastOutcome = "captured_untracked";
      return;
    }
    this.track(key);
  }

  /**
   * @param {unknown} runtimeRejectionId
   * @returns {void}
   */
  unhandled(runtimeRejectionId) {
    if (this.handling) {
      this.suppress("promise_rejection_recursive_capture_suppressed", "recursive_suppressed");
      return;
    }
    const key = rejectionKey(runtimeRejectionId);
    if (key !== undefined && this.tracked.has(key)) {
      this.suppress("promise_rejection_duplicate_suppressed", "duplicate_suppressed");
      return;
    }
    this.captureOnce(key);
  }

  /**
   * @param {string | undefined} key
   * @returns {void}
   */
  captureOnce(key) {
    this.handling = true;
    try {
      this.capture(key);
    } catch {
      this.lastOutcome = "capture_failed";
      this.diagnostics.emit("promise_rejection_capture_failed");
    } finally {
      this.handling = false;
    }
  }
}

/**
 * @param {object} input
 * @param {unknown} onDiagnostic
 * @returns {number}
 */
function trackedMaximum(input, onDiagnostic) {
  const configuredMaximum = safeReadProperty(input, "maxTrackedRejections");
  const maxTrackedRejections = validMaximum(configuredMaximum) ? configuredMaximum : DEFAULT_MAX_TRACKED_REJECTIONS;
  if (configuredMaximum !== undefined && maxTrackedRejections !== configuredMaximum) {
    emitDiagnostic(onDiagnostic, "promise_rejection_configuration_invalid");
  }
  return maxTrackedRejections;
}

/**
 * @param {unknown} options
 * @param {string} mechanism
 * @returns {LogBrewReactNativePromiseRejectionHandlers}
 */
function createPromiseRejectionHandlers(options, mechanism) {
  const input = isObjectLike(options) ? options : {};
  const client = safeReadProperty(input, "client");
  const issue = safeFunction(client, "issue");
  const onDiagnostic = safeFunction(input, "onDiagnostic");
  if (!issue) {
    emitDiagnostic(onDiagnostic, "promise_rejection_handler_unavailable");
    return inactiveHandlers();
  }
  const maxTrackedRejections = trackedMaximum(input, onDiagnostic);
  const tracking = new RejectionTracking({ client, issue, maxTrackedRejections, mechanism, onDiagnostic });
  return Object.freeze({
    health() {
      return tracking.health();
    },
    onHandled(runtimeRejectionId) {
      tracking.handled(runtimeRejectionId);
    },
    onUnhandled(runtimeRejectionId) {
      tracking.unhandled(runtimeRejectionId);
    }
  });
}

module.exports = { createPromiseRejectionHandlers, inactiveHandlers };
