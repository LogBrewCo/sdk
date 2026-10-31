const { incrementBounded, nextBoundedTimestamp } = require("./bounded-number.cjs");
const { propertyOf } = require("./error-details.cjs");
const { NULL_VALUE } = require("./null-value.cjs");
const { randomHex } = require("./random-hex.cjs");
const { requireSynchronousStoreResult } = require("./stored-events.cjs");
const { isRecord } = require("./validation.cjs");

/**
 * @import { ClientReportStore } from "./event-store.cjs"
 * @typedef {"event_too_large" | "evicted_for_fatal" | "queue_bytes_overflow" | "queue_overflow"} DropReason
 * @typedef {Readonly<{ report_id: unknown, dropped_events: Readonly<Record<string, number>> }>} ClientReport
 * @typedef {{ pending: ClientReport | undefined, unreported: Record<string, number> }} RestoredReport
 */

const MAX_CLIENT_REPORT_REASONS = 16;
const MAX_CLIENT_REPORT_COUNT = 1_000_000_000;
const MIN_CLIENT_REPORT_COUNT = 1;
const CLIENT_REPORT_SAVE_INTERVAL_MS = 1000;
const CLIENT_REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const CLIENT_REPORT_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const REPORT_ID_BYTES = 16;
const NO_COUNT = 0;
const STEP = 1;

/**
 * @param {string} reason
 * @param {unknown} count
 * @returns {count is number}
 */
function isReportCount(reason, count) {
  return CLIENT_REPORT_REASON_PATTERN.test(reason) && typeof count === "number" && Number.isSafeInteger(count)
    && count >= MIN_CLIENT_REPORT_COUNT && count <= MAX_CLIENT_REPORT_COUNT;
}

/**
 * @param {unknown} counts
 * @returns {Record<string, number>}
 */
function validClientReportCounts(counts) {
  /** @type {Record<string, number>} */
  const valid = {};
  if (!isRecord(counts)) {
    return valid;
  }
  for (const [reason, count] of Object.entries(counts)) {
    if (Object.keys(valid).length < MAX_CLIENT_REPORT_REASONS && isReportCount(reason, count)) {
      valid[reason] = count;
    }
  }
  return valid;
}

/**
 * @param {Readonly<Record<string, number>>} counts
 * @returns {Record<string, number>}
 */
function reportableCounts(counts) {
  /** @type {Record<string, number>} */
  const reportable = {};
  for (const [reason, count] of Object.entries(counts)) {
    if (Object.keys(reportable).length < MAX_CLIENT_REPORT_REASONS && count > NO_COUNT) {
      reportable[reason] = count;
    }
  }
  return reportable;
}

/**
 * @param {Readonly<Record<string, number>>} counts
 * @param {Readonly<Record<string, number>>} reported
 * @returns {Record<string, number>}
 */
function withoutReported(counts, reported) {
  const reportedReasons = new Set(Object.keys(reported));
  /** @type {Record<string, number>} */
  const remaining = {};
  for (const [reason, count] of Object.entries(counts)) {
    if (!reportedReasons.has(reason)) {
      remaining[reason] = count;
    }
  }
  return remaining;
}

/**
 * @param {unknown} reportId
 * @returns {boolean}
 */
function isReportId(reportId) {
  if (typeof reportId === "number") {
    return CLIENT_REPORT_ID_PATTERN.test(String(reportId));
  }
  return typeof reportId === "string" && CLIENT_REPORT_ID_PATTERN.test(reportId);
}

/**
 * @param {ClientReportStore | undefined} store
 * @returns {unknown}
 */
function loadClientReportState(store) {
  try {
    return store === undefined ? undefined : requireSynchronousStoreResult("loadClientReport", store.loadClientReport());
  } catch {
    return undefined;
  }
}

/**
 * @param {ClientReportStore | undefined} store
 * @returns {RestoredReport}
 */
function loadClientReport(store) {
  const state = loadClientReportState(store);
  const pending = propertyOf(state, "pending");
  const pendingCounts = validClientReportCounts(propertyOf(pending, "dropped_events"));
  const reportId = propertyOf(pending, "report_id");
  return {
    pending: isReportId(reportId) && Object.keys(pendingCounts).length > NO_COUNT
      ? Object.freeze({
        report_id: reportId,

        dropped_events: pendingCounts
      })
      : undefined,
    unreported: validClientReportCounts(propertyOf(state, "unreported"))
  };
}

/**
 * @param {ClientReportStore} store
 * @param {unknown} state
 * @returns {boolean}
 */
function saveClientReportState(store, state) {
  try {
    requireSynchronousStoreResult("saveClientReport", store.saveClientReport(state));
    return true;
  } catch {
    return false;
  }
}

class DropLedger {
  droppedEventCount = NO_COUNT;

  /** @type {Record<DropReason, number>} */
  droppedEventsByReason = {
    event_too_large: NO_COUNT,
    evicted_for_fatal: NO_COUNT,
    queue_bytes_overflow: NO_COUNT,
    queue_overflow: NO_COUNT
  };

  clientReportSavedAtMs = NO_COUNT;

  /** @type {DropReason | "none"} */
  lastDropReason = "none";

  lastDroppedAtUnixMs = NO_COUNT;

  /**
   * @param {ClientReportStore | undefined} store
   */
  constructor(store) {
    this.clientReportStore = store;
    const restoredReport = loadClientReport(store);
    this.unreportedDropsByReason = restoredReport.unreported;
    this.pendingClientReport = restoredReport.pending;
  }

  /**
   * @param {DropReason} reason
   * @returns {void}
   */
  record(reason) {
    this.droppedEventCount = incrementBounded(this.droppedEventCount);
    this.droppedEventsByReason[reason] = incrementBounded(this.droppedEventsByReason[reason]);
    const previous = this.unreportedDropsByReason[reason];
    this.unreportedDropsByReason[reason] = Math.min(MAX_CLIENT_REPORT_COUNT, (previous ?? NO_COUNT) + STEP);
    this.save(previous === undefined);
    this.lastDropReason = reason;
    this.lastDroppedAtUnixMs = nextBoundedTimestamp(this.lastDroppedAtUnixMs);
  }

  /**
   * @returns {ClientReport | undefined}
   */
  pendingReport() {
    if (this.pendingClientReport !== undefined) {
      return this.pendingClientReport;
    }
    const droppedEvents = reportableCounts(this.unreportedDropsByReason);
    if (Object.keys(droppedEvents).length === NO_COUNT) {
      return undefined;
    }
    this.unreportedDropsByReason = withoutReported(this.unreportedDropsByReason, droppedEvents);
    this.pendingClientReport = Object.freeze({
      report_id: randomHex(REPORT_ID_BYTES),

      dropped_events: droppedEvents
    });
    this.save(true);
    return this.pendingClientReport;
  }

  /**
   * @returns {void}
   */
  acknowledgeReport() {
    this.pendingClientReport = undefined;
    this.save(true);
  }

  /**
   * @param {boolean} immediately
   * @returns {void}
   */
  save(immediately) {
    const now = Date.now();
    const store = this.clientReportStore;
    if (store === undefined || (!immediately && now - this.clientReportSavedAtMs < CLIENT_REPORT_SAVE_INTERVAL_MS)) {
      return;
    }
    this.clientReportSavedAtMs = now;
    saveClientReportState(store, {
      pending: this.pendingClientReport ?? NULL_VALUE,
      unreported: { ...this.unreportedDropsByReason }
    });
  }
}

module.exports = { DropLedger };
