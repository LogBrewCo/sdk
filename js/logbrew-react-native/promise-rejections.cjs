"use strict";

const { createPromiseRejectionHandlers, inactiveHandlers } = require("./promise-rejection-handlers.cjs");
const { emitDiagnostic, isObjectLike, safeFunction, safeReadProperty } = require("./global-errors-support.cjs");

/**
 * @import { UnknownFunction } from "./global-errors-support.cjs"
 * @import {
 *   LogBrewReactNativePromiseRejectionHandlers,
 *   LogBrewReactNativePromiseRejectionTrackerInstallation,
 *   ReactNativePromiseRejectionTrackerHealth
 * } from "./global-errors.cjs"
 * @typedef {ReactNativePromiseRejectionTrackerHealth["engine"]} TrackerEngine
 * @typedef {ReactNativePromiseRejectionTrackerHealth["lastOutcome"]} TrackerOutcome
 * @typedef {Readonly<{
 *   enable: UnknownFunction,
 *   engine: TrackerEngine,
 *   handlers: LogBrewReactNativePromiseRejectionHandlers,
 *   onDiagnostic: unknown,
 *   tracker: object
 * }>} TrackerOwnershipOptions
 */

/** @type {WeakMap<object, LogBrewReactNativePromiseRejectionTrackerInstallation>} */
const activeTrackerInstallations = new WeakMap();

/**
 * @param {unknown} [options]
 * @returns {LogBrewReactNativePromiseRejectionHandlers}
 */
function createLogBrewReactNativePromiseRejectionHandlers(options = {}) {
  return createPromiseRejectionHandlers(
    options,
    "app_owned_promise_rejection_tracker"
  );
}

/**
 * @param {TrackerOutcome} lastOutcome
 * @param {TrackerEngine} [engine]
 * @param {LogBrewReactNativePromiseRejectionHandlers} [handlers]
 * @returns {LogBrewReactNativePromiseRejectionTrackerInstallation}
 */
function inactiveTrackerInstallation(
  lastOutcome,
  engine = "unavailable",
  handlers = inactiveHandlers()
) {
  const snapshot = Object.freeze({
    active: false,
    available: false,
    engine,
    lastOutcome,
    restoration: "deactivate_only"
  });
  return Object.freeze({
    deactivate: () => false,
    health: () => snapshot,
    rejectionHealth: () => handlers.health()
  });
}

class TrackerOwnership {
  active = true;

  /** @type {TrackerOutcome} */
  lastOutcome = "installed";

  /**
   * @param {TrackerOwnershipOptions} options
   */
  constructor(options) {
    this.options = options;
    const { handlers } = options;
    this.trackerOptions = Object.freeze({
      allRejections: true,
      /**
       * @param {unknown} runtimeRejectionId
       * @returns {void}
       */
      onHandled: (runtimeRejectionId) => {
        if (this.active) {
          handlers.onHandled(runtimeRejectionId);
        }
      },
      /**
       * @param {unknown} runtimeRejectionId
       * @param {unknown} rejection
       * @returns {void}
       */
      onUnhandled: (runtimeRejectionId, rejection) => {
        if (this.active) {
          handlers.onUnhandled(runtimeRejectionId, rejection);
        }
      }
    });
  }

  /**
   * @returns {ReactNativePromiseRejectionTrackerHealth}
   */
  health() {
    return Object.freeze({
      active: this.active,
      available: true,
      engine: this.options.engine,
      lastOutcome: this.lastOutcome,
      restoration: "deactivate_only"
    });
  }

  /**
   * @param {LogBrewReactNativePromiseRejectionTrackerInstallation} installation
   * @returns {boolean}
   */
  deactivate(installation) {
    if (!this.active) {
      return false;
    }
    this.active = false;
    this.lastOutcome = "deactivated";
    const { tracker } = this.options;
    if (activeTrackerInstallations.get(tracker) === installation) {
      activeTrackerInstallations.delete(tracker);
    }
    return true;
  }

  /**
   * @returns {LogBrewReactNativePromiseRejectionTrackerInstallation}
   */
  install() {
    const { enable, engine, handlers, onDiagnostic, tracker } = this.options;
    /** @type {LogBrewReactNativePromiseRejectionTrackerInstallation} */
    const installation = Object.freeze({
      deactivate: () => this.deactivate(installation),
      health: () => this.health(),
      rejectionHealth: () => handlers.health()
    });
    try {
      enable.call(tracker, this.trackerOptions);
    } catch {
      this.active = false;
      this.lastOutcome = "installation_failed";
      emitDiagnostic(onDiagnostic, "promise_rejection_tracker_installation_failed");
      return inactiveTrackerInstallation("installation_failed", engine, handlers);
    }
    activeTrackerInstallations.set(tracker, installation);
    return installation;
  }
}

/**
 * @param {unknown} input
 * @param {unknown} tracker
 * @returns {TrackerEngine}
 */
function trackerEngine(input, tracker) {
  if (safeReadProperty(input, "trackerKind") === "hermes") {
    return "hermes";
  }
  return isObjectLike(tracker) ? "custom" : "unavailable";
}

/**
 * @param {object} input
 * @param {Omit<TrackerOwnershipOptions, "handlers">} ownership
 * @returns {LogBrewReactNativePromiseRejectionTrackerInstallation}
 */
function startTracker(input, ownership) {
  const existing = activeTrackerInstallations.get(ownership.tracker);
  if (existing?.health().active === true) {
    return existing;
  }
  const handlers = createPromiseRejectionHandlers(input, "logbrew_owned_promise_rejection_tracker");
  if (!handlers.health().available) {
    return inactiveTrackerInstallation("handler_unavailable", ownership.engine, handlers);
  }
  return new TrackerOwnership({ ...ownership, handlers }).install();
}

/**
 * @param {object} input
 * @param {UnknownFunction | undefined} onDiagnostic
 * @returns {LogBrewReactNativePromiseRejectionTrackerInstallation}
 */
function installTracker(input, onDiagnostic) {
  const tracker = safeReadProperty(input, "tracker");
  const enable = safeFunction(tracker, "enable");
  const engine = trackerEngine(input, tracker);
  if (!isObjectLike(tracker) || !enable) {
    emitDiagnostic(onDiagnostic, "promise_rejection_tracker_unavailable");
    return inactiveTrackerInstallation("tracker_unavailable", engine);
  }
  return startTracker(input, { enable, engine, onDiagnostic, tracker });
}

/**
 * @param {unknown} [options]
 * @returns {LogBrewReactNativePromiseRejectionTrackerInstallation}
 */
function installLogBrewReactNativePromiseRejectionTracker(options = {}) {
  const input = isObjectLike(options) ? options : {};
  const onDiagnostic = safeFunction(input, "onDiagnostic");
  if (safeReadProperty(input, "takeOwnership") !== true) {
    emitDiagnostic(onDiagnostic, "promise_rejection_tracker_ownership_required");
    return inactiveTrackerInstallation("ownership_required");
  }
  return installTracker(input, onDiagnostic);
}

module.exports = {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativePromiseRejectionTracker
};
