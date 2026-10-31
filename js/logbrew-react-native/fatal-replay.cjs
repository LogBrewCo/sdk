"use strict";

const { emitDiagnostic, incrementBounded, safeReadProperty } = require("./global-errors-support.cjs");
const { boundedResultCounter, createFatalRecord, resultStatus, validatedFatalRecord } = require("./fatal-record.cjs");
const {
  attempt,
  captureIssueWithAdmission,
  fatalStoreMethods,
  rememberAdmittedFatalId,
  wasAdmittedInRuntime
} = require("./fatal-admission.cjs");

/**
 * @import { UnknownFunction } from "./global-errors-support.cjs"
 * @import { FatalEventInput, FatalRecord } from "./fatal-record.cjs"
 * @import { ReactNativeFatalReplayHealth } from "./global-errors.cjs"
 * @import { Admission, FatalStoreMethods } from "./fatal-admission.cjs"
 * @typedef {ReactNativeFatalReplayHealth["lastOutcome"]} FatalOutcome
 * @typedef {Readonly<{
 *   client: unknown,
 *   createEvent: (error: unknown) => FatalEventInput,
 *   eventMessage: string,
 *   fatalStore: unknown,
 *   isErrorName: (value: unknown) => boolean,
 *   issue: UnknownFunction,
 *   onDiagnostic: unknown
 * }>} FatalControllerOptions
 * @typedef {Readonly<{
 *   available: boolean,
 *   discard: () => boolean,
 *   health: () => ReactNativeFatalReplayHealth,
 *   replay: () => void,
 *   store: (error: unknown) => boolean
 * }>} FatalController
 */

const DURABLE_QUEUE = Symbol.for("co.logbrew.react-native.durable-event-queue");
const NO_COUNT = 0;

/**
 * @param {FatalRecord} record
 * @param {string} eventMessage
 * @returns {Readonly<Record<string, unknown>>}
 */
function fatalEventAttributes(record, eventMessage) {
  return Object.freeze({
    exception: Object.freeze({
      type: record.errorName,

      mechanism: Object.freeze({
        type: "react_native_error_utils",

        handled: false
      })
    }),
    level: "fatal",
    message: eventMessage,
    metadata: Object.freeze({
      automatic: true,
      fatal: true,
      handled: false,
      mechanism: "react_native_error_utils",
      nativeCorruptRecords: record.corruptRecords,
      nativeDroppedRecords: record.droppedRecords,
      replayed: true,
      source: "react-native.global_error"
    }),
    ...(record.stackFrames.length === NO_COUNT
      ? {}
      : { stackFrames: record.stackFrames.map((frame) => Object.freeze({ ...frame })) }),
    title: eventMessage
  });
}

class FatalReplay {
  /**
   * @param {FatalControllerOptions} options
   */
  constructor(options) {
    this.options = options;
    this.methods = fatalStoreMethods(options.fatalStore);
    this.directAdmission = !this.methods && safeReadProperty(options.client, DURABLE_QUEUE) === true;
    this.acknowledgedRecords = NO_COUNT;
    this.available = this.methods !== undefined || this.directAdmission;
    this.corruptRecords = NO_COUNT;
    this.droppedRecords = NO_COUNT;
    /** @type {FatalOutcome} */
    this.lastOutcome = this.methods || this.directAdmission ? "idle" : "unavailable";
    this.replayedRecords = NO_COUNT;
    this.storedRecords = NO_COUNT;
  }

  /**
   * @returns {ReactNativeFatalReplayHealth}
   */
  health() {
    return Object.freeze({
      acknowledgedRecords: this.acknowledgedRecords,
      available: this.available,
      corruptRecords: this.corruptRecords,
      droppedRecords: this.droppedRecords,
      lastOutcome: this.lastOutcome,
      replayedRecords: this.replayedRecords,
      storedRecords: this.storedRecords
    });
  }

  /**
   * @param {FatalOutcome} outcome
   * @param {string} code
   * @returns {false}
   */
  fail(outcome, code) {
    this.lastOutcome = outcome;
    emitDiagnostic(this.options.onDiagnostic, code);
    return false;
  }

  /**
   * @param {unknown} error
   * @returns {Admission | undefined}
   */
  admission(error) {
    const { client, createEvent, issue } = this.options;
    try {
      const event = createEvent(error);
      return captureIssueWithAdmission(client, issue, event.id, event.timestamp, event.attributes);
    } catch {
      return undefined;
    }
  }

  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  admit(error) {
    const admission = this.admission(error);
    if (admission === "unavailable") {
      return this.fail("admission_unavailable", "fatal_admission_unavailable");
    }
    if (admission !== "admitted") {
      return this.fail("storage_error", "fatal_store_failed");
    }
    this.storedRecords = incrementBounded(this.storedRecords);
    this.lastOutcome = "stored";
    return true;
  }

  /**
   * @returns {boolean}
   */
  discard() {
    const { methods } = this;
    if (!methods) {
      return false;
    }
    return this.recordDiscardResult(attempt(() => methods.discard.call(this.options.fatalStore)));
  }

  /**
   * @param {unknown} result
   * @returns {boolean}
   */
  recordDiscardResult(result) {
    if (resultStatus(result) === "discarded") {
      this.lastOutcome = "discarded";
      return true;
    }
    if (resultStatus(result) === "empty") {
      this.lastOutcome = "empty";
      return false;
    }
    return this.fail("discard_failed", "fatal_discard_failed");
  }

  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  store(error) {
    const { methods } = this;
    if (!methods) {
      return this.directAdmission ? this.admit(error) : false;
    }
    const { createEvent, fatalStore } = this.options;
    return this.recordStoreResult(attempt(() => methods.write.call(fatalStore, createFatalRecord(createEvent(error)))));
  }

  /**
   * @param {unknown} result
   * @returns {boolean}
   */
  recordStoreResult(result) {
    const status = resultStatus(result);
    if (status === "stored" || status === "stored_after_corruption") {
      this.storedRecords = incrementBounded(this.storedRecords);
      this.corruptRecords = boundedResultCounter(result, "corruptRecords", this.corruptRecords);
      this.lastOutcome = status;
      return true;
    }
    if (status === "dropped_pending") {
      this.droppedRecords = boundedResultCounter(result, "droppedRecords", incrementBounded(this.droppedRecords));
      return this.fail(status, "fatal_record_dropped");
    }
    return this.fail("storage_error", "fatal_store_failed");
  }

  /**
   * @param {FatalStoreMethods} methods
   * @param {string} recordId
   * @returns {void}
   */
  acknowledge(methods, recordId) {
    const result = attempt(() => methods.acknowledge.call(this.options.fatalStore, recordId));
    if (resultStatus(result) === "acknowledged"
      && safeReadProperty(result, "recordId") === recordId) {
      this.acknowledgedRecords = incrementBounded(this.acknowledgedRecords);
      this.lastOutcome = "acknowledged";
      return;
    }
    this.fail("acknowledge_failed", "fatal_acknowledge_failed");
  }

  /**
   * @param {FatalRecord} record
   * @returns {Admission | undefined}
   */
  replayAdmission(record) {
    const { client, eventMessage, issue } = this.options;
    try {
      return captureIssueWithAdmission(client, issue, record.id, record.timestamp, fatalEventAttributes(record, eventMessage));
    } catch {
      return undefined;
    }
  }

  /**
   * @param {FatalStoreMethods} methods
   * @param {FatalRecord} record
   * @returns {void}
   */
  replayRecord(methods, record) {
    this.corruptRecords = Math.max(this.corruptRecords, record.corruptRecords);
    this.droppedRecords = Math.max(this.droppedRecords, record.droppedRecords);
    if (wasAdmittedInRuntime(this.options.client, record.id)) {
      this.acknowledge(methods, record.id);
      return;
    }
    this.recordReplayAdmission(methods, record, this.replayAdmission(record));
  }

  /**
   * @param {FatalStoreMethods} methods
   * @param {FatalRecord} record
   * @param {Admission | undefined} admission
   * @returns {void}
   */
  recordReplayAdmission(methods, record, admission) {
    if (admission === undefined) {
      this.fail("replay_failed", "fatal_replay_failed");
    } else if (admission === "unavailable") {
      this.fail("admission_unavailable", "fatal_replay_admission_unavailable");
    } else if (admission === "admitted") {
      rememberAdmittedFatalId(this.options.client, record.id);
      this.replayedRecords = incrementBounded(this.replayedRecords);
      this.acknowledge(methods, record.id);
    } else {
      this.fail("replay_not_admitted", "fatal_replay_not_admitted");
    }
  }

  /**
   * @returns {void}
   */
  replay() {
    const { methods } = this;
    if (!methods) {
      return;
    }
    this.recordReadResult(methods, attempt(() => methods.read.call(this.options.fatalStore)));
  }

  /**
   * @param {FatalStoreMethods} methods
   * @param {unknown} result
   * @returns {void}
   */
  recordReadResult(methods, result) {
    const status = resultStatus(result);
    if (status === "empty") {
      this.lastOutcome = "empty";
      return;
    }
    if (status === "corrupt_discarded") {
      this.corruptRecords = boundedResultCounter(result, "corruptRecords", incrementBounded(this.corruptRecords));
      this.fail(status, "fatal_corrupt_record_discarded");
      return;
    }
    this.replayResult(methods, status === "pending"
      ? validatedFatalRecord(safeReadProperty(result, "record"), this.options.isErrorName)
      : undefined);
  }

  /**
   * @param {FatalStoreMethods} methods
   * @param {FatalRecord | undefined} record
   * @returns {void}
   */
  replayResult(methods, record) {
    if (record) {
      this.replayRecord(methods, record);
    } else {
      this.fail("replay_failed", "fatal_replay_failed");
    }
  }
}

/**
 * @param {FatalControllerOptions} options
 * @returns {FatalController}
 */
function createFatalController({
  client,
  createEvent,
  eventMessage,
  fatalStore,
  isErrorName,
  issue,
  onDiagnostic
}) {
  const fatal = new FatalReplay({ client, createEvent, eventMessage, fatalStore, isErrorName, issue, onDiagnostic });
  return {
    available: fatal.available,
    discard() {
      return fatal.discard();
    },
    health() {
      return fatal.health();
    },
    replay() {
      fatal.replay();
    },
    store(error) {
      return fatal.store(error);
    }
  };
}

module.exports = { captureIssueWithAdmission, createFatalController };
