"use strict";

const { captureIssueWithAdmission } = require("./fatal-replay.cjs");
const { createAutomaticErrorEvent } = require("./global-errors-event.cjs");
const { emitDiagnostic, incrementBounded, isFunction, isObjectLike } = require("./global-errors-support.cjs");

/**
 * @import { DiagnosticEmitter, UnknownFunction } from "./global-errors-support.cjs"
 * @import { Admission } from "./fatal-admission.cjs"
 * @import { FatalController } from "./fatal-replay.cjs"
 * @import {
 *   LogBrewReactNativeGlobalErrorHandlerInstallation,
 *   ReactNativeFatalReplayHealth,
 *   ReactNativeGlobalErrorHealth
 * } from "./global-errors.cjs"
 * @typedef {ReactNativeGlobalErrorHealth["lastOutcome"]} GlobalErrorOutcome
 * @typedef {Readonly<{
 *   client: object,
 *   diagnostics: DiagnosticEmitter,
 *   errorUtils: object,
 *   fatal: FatalController,
 *   getGlobalHandler: UnknownFunction,
 *   issue: UnknownFunction,
 *   onDiagnostic: unknown,
 *   previousHandler: UnknownFunction,
 *   setGlobalHandler: UnknownFunction
 * }>} GlobalErrorCaptureOptions
 */

const NO_COUNT = 0;
/** @type {Readonly<Record<"dropped" | "failed" | "filtered" | "unavailable", readonly [GlobalErrorOutcome, string]>>} */
const NONFATAL_FAILURES = {
  dropped: ["capture_failed", "capture_failed"],
  failed: ["capture_failed", "capture_failed"],
  filtered: ["filtered", "capture_filtered"],
  unavailable: ["admission_unavailable", "capture_admission_unavailable"]
};

/** @type {WeakMap<object, LogBrewReactNativeGlobalErrorHandlerInstallation>} */
const installations = new WeakMap();

/**
 * @returns {LogBrewReactNativeGlobalErrorHandlerInstallation}
 */
function inactiveInstallation() {
  const snapshot = Object.freeze({
    active: false,
    capturedEvents: NO_COUNT,
    lastOutcome: "unavailable",
    suppressedEvents: NO_COUNT
  });
  /** @type {ReactNativeFatalReplayHealth} */
  const fatalSnapshot = Object.freeze({
    acknowledgedRecords: NO_COUNT,
    available: false,
    corruptRecords: NO_COUNT,
    droppedRecords: NO_COUNT,
    lastOutcome: "unavailable",
    replayedRecords: NO_COUNT,
    storedRecords: NO_COUNT
  });
  return Object.freeze({
    discardPendingFatalRecord: () => false,
    fatalHealth: () => fatalSnapshot,
    health: () => snapshot,
    remove: () => false
  });
}

/**
 * @param {object} client
 * @returns {boolean}
 */
function markPersistedFatal(client) {
  try {
    /** @type {unknown} */
    const addBreadcrumb = Reflect.get(client, "addBreadcrumb");
    const breadcrumb = { category: "react-native.fatal", level: "fatal", type: "error" };
    if (!isFunction(addBreadcrumb)) {
      return false;
    }
    Reflect.apply(addBreadcrumb, client, [breadcrumb]);
    return true;
  } catch {
    return false;
  }
}

class GlobalErrorCapture {
  active = true;
  capturedEvents = NO_COUNT;
  /** @type {WeakSet<object>} */
  capturedErrors = new WeakSet();
  handling = false;
  /** @type {GlobalErrorOutcome} */
  lastOutcome = "idle";
  suppressedEvents = NO_COUNT;

  /**
   * @param {GlobalErrorCaptureOptions} options
   */
  constructor(options) {
    this.options = options;
    /**
     * @param {unknown} error
     * @param {unknown} isFatal
     * @returns {void}
     */
    const handler = (error, isFatal) => {
      this.handle(error, isFatal);
    };
    this.handler = handler;
  }

  /**
   * @returns {ReactNativeGlobalErrorHealth}
   */
  health() {
    return Object.freeze({
      active: this.active,
      capturedEvents: this.capturedEvents,
      lastOutcome: this.lastOutcome,
      suppressedEvents: this.suppressedEvents
    });
  }

  /**
   * @param {"duplicate_capture_suppressed" | "recursive_capture_suppressed"} code
   * @returns {void}
   */
  recordSuppression(code) {
    this.suppressedEvents = incrementBounded(this.suppressedEvents);
    this.lastOutcome = code === "recursive_capture_suppressed" ? "recursive_suppressed" : "duplicate_suppressed";
    this.options.diagnostics.emit(code);
  }

  /**
   * @param {unknown} error
   * @returns {void}
   */
  captureFatal(error) {
    const { client, diagnostics, fatal } = this.options;
    if (!fatal.available) {
      this.lastOutcome = "fatal_unsupported";
      diagnostics.emit("fatal_capture_requires_sync_store");
    } else if (fatal.store(error)) {
      this.lastOutcome = "fatal_stored";
      markPersistedFatal(client);
    } else {
      this.lastOutcome = fatal.health().lastOutcome === "admission_unavailable"
        ? "admission_unavailable"
        : "fatal_store_failed";
    }
  }

  /**
   * @param {unknown} error
   * @returns {Admission | "failed"}
   */
  admitNonfatal(error) {
    const { client, issue } = this.options;
    try {
      const event = createAutomaticErrorEvent(error, client);
      return captureIssueWithAdmission(client, issue, event.id, event.timestamp, event.attributes);
    } catch {
      return "failed";
    }
  }

  /**
   * @param {unknown} error
   * @returns {void}
   */
  captureNonfatal(error) {
    if (isObjectLike(error)) {
      this.capturedErrors.add(error);
    }
    const admission = this.admitNonfatal(error);
    if (admission === "admitted") {
      this.capturedEvents = incrementBounded(this.capturedEvents);
      this.lastOutcome = "captured";
    } else {
      this.recordNonfatalFailure(error, admission);
    }
  }

  /**
   * @param {unknown} error
   * @param {Exclude<Admission, "admitted"> | "failed"} admission
   * @returns {void}
   */
  recordNonfatalFailure(error, admission) {
    if (isObjectLike(error)) {
      this.capturedErrors.delete(error);
    }
    const [outcome, code] = NONFATAL_FAILURES[admission];
    this.lastOutcome = outcome;
    this.options.diagnostics.emit(code);
  }

  /**
   * @param {unknown} error
   * @param {unknown} isFatal
   * @returns {void}
   */
  capture(error, isFatal) {
    if (isFatal === true) {
      this.captureFatal(error);
    } else if (isObjectLike(error) && this.capturedErrors.has(error)) {
      this.recordSuppression("duplicate_capture_suppressed");
    } else {
      this.captureNonfatal(error);
    }
  }

  /**
   * @param {unknown} error
   * @param {unknown} isFatal
   * @returns {void}
   */
  handle(error, isFatal) {
    const { previousHandler } = this.options;
    if (!this.active) {
      previousHandler(error, isFatal);
      return;
    }
    if (this.handling) {
      this.recordSuppression("recursive_capture_suppressed");
      return;
    }
    this.handleOnce(error, isFatal);
  }

  /**
   * @param {unknown} error
   * @param {unknown} isFatal
   * @returns {void}
   */
  handleOnce(error, isFatal) {
    const { previousHandler } = this.options;
    this.handling = true;
    try {
      this.capture(error, isFatal);
    } finally {
      try {
        previousHandler(error, isFatal);
      } finally {
        this.handling = false;
      }
    }
  }

  /**
   * @returns {boolean | undefined}
   */
  ownsHandler() {
    const { errorUtils, getGlobalHandler } = this.options;
    try {
      return getGlobalHandler.call(errorUtils) === this.handler;
    } catch {
      return undefined;
    }
  }

  /**
   * @param {GlobalErrorOutcome} outcome
   * @returns {void}
   */
  deactivate(outcome) {
    this.active = false;
    this.lastOutcome = outcome;
    installations.delete(this.options.errorUtils);
  }

  /**
   * @returns {boolean}
   */
  remove() {
    if (!this.active) {
      return false;
    }
    const owns = this.ownsHandler();
    if (owns === false) {
      this.deactivate("handler_replaced");
    }
    return owns === true && this.restoreForRemoval();
  }

  /**
   * @returns {boolean}
   */
  restoreForRemoval() {
    const { errorUtils, previousHandler, setGlobalHandler } = this.options;
    try {
      setGlobalHandler.call(errorUtils, previousHandler);
    } catch {
      this.lastOutcome = "remove_failed";
      return false;
    }
    this.deactivate("removed");
    return true;
  }

  /**
   * @returns {boolean}
   */
  restorePreviousHandler() {
    const { errorUtils, previousHandler, setGlobalHandler } = this.options;
    try {
      if (this.ownsHandler() === true) {
        setGlobalHandler.call(errorUtils, previousHandler);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @returns {LogBrewReactNativeGlobalErrorHandlerInstallation}
   */
  installationHandle() {
    const { fatal } = this.options;
    return Object.freeze({
      discardPendingFatalRecord: () => fatal.discard(),
      fatalHealth: () => fatal.health(),
      health: () => this.health(),
      remove: () => this.remove()
    });
  }

  /**
   * @param {unknown} onDiagnostic
   * @returns {LogBrewReactNativeGlobalErrorHandlerInstallation}
   */
  failInstallation(onDiagnostic) {
    this.active = false;
    this.restorePreviousHandler();
    emitDiagnostic(onDiagnostic, "handler_unavailable");
    return inactiveInstallation();
  }

  /**
   * @returns {LogBrewReactNativeGlobalErrorHandlerInstallation}
   */
  install() {
    const { errorUtils, fatal, onDiagnostic, setGlobalHandler } = this.options;
    const installation = this.installationHandle();
    try {
      setGlobalHandler.call(errorUtils, this.handler);
    } catch {
      return this.failInstallation(onDiagnostic);
    }
    installations.set(errorUtils, installation);
    fatal.replay();
    return installation;
  }
}

/**
 * @param {unknown} value
 * @returns {LogBrewReactNativeGlobalErrorHandlerInstallation | undefined}
 */
function activeInstallation(value) {
  const existing = isObjectLike(value) ? installations.get(value) : undefined;
  return existing?.health().active === true ? existing : undefined;
}

module.exports = { GlobalErrorCapture, activeInstallation, inactiveInstallation };
