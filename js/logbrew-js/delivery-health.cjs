/**
 * @import { PauseReason } from "./automatic-delivery.cjs"
 * @import { StatusClass } from "./batch-sender.cjs"
 * @import { DropReason } from "./client-report.cjs"
 * @import { DeliveryOutcome } from "./event-pipeline.cjs"
 * @typedef {Readonly<{
 *   automaticDelivery: boolean,
 *   lifecycle: "active" | "shutting_down" | "closed",
 *   storage: "persistent" | "memory",
 *   queueEvents: number,
 *   queueBytes: number,
 *   hydratedEvents: number,
 *   hydratedBytes: number,
 *   droppedEvents: number,
 *   droppedByReason: Readonly<Record<DropReason, number>>,
 *   lastDropReason: DropReason | "none",
 *   scheduled: boolean,
 *   inFlight: boolean,
 *   coalesced: boolean,
 *   pendingOperations: number,
 *   lastOutcome: DeliveryOutcome,
 *   lastStatusClass: StatusClass,
 *   pausedReason: PauseReason,
 *   consecutiveFailures: number,
 *   retryDelayMs: number,
 *   flushes: number,
 *   failures: number,
 *   attempts: number,
 *   batches: number,
 *   acceptedEvents: number,
 *   lastAttemptAtUnixMs: number,
 *   lastAcceptedAtUnixMs: number,
 *   lastDroppedAtUnixMs: number
 * }>} HealthState
 */

const DELIVERY_HEALTH_SCHEMA_VERSION = 1;
const NONE = 0;
const HEALTH_KEYS = Object.freeze([
  "schemaVersion",
  "automaticDelivery",
  "lifecycle",
  "deliveryState",
  "storage",
  "queueEvents",
  "queueBytes",
  "hydratedEvents",
  "hydratedBytes",
  "droppedEvents",
  "droppedByReason",
  "lastDropReason",
  "scheduled",
  "inFlight",
  "coalesced",
  "pendingOperations",
  "lastOutcome",
  "lastStatusClass",
  "pausedReason",
  "consecutiveFailures",
  "retryDelayMs",
  "flushes",
  "failures",
  "attempts",
  "batches",
  "acceptedEvents",
  "lastAttemptAtUnixMs",
  "lastAcceptedAtUnixMs",
  "lastDroppedAtUnixMs"
]);

/**
 * @param {boolean} closed
 * @param {boolean} closing
 * @returns {HealthState["lifecycle"]}
 */
function lifecycleOf(closed, closing) {
  if (closed) {
    return "closed";
  }
  return closing ? "shutting_down" : "active";
}

/**
 * @param {HealthState} state
 * @returns {string | undefined}
 */
function activeState(state) {
  if (state.inFlight) {
    return "in_flight";
  }
  if (state.retryDelayMs > NONE) {
    return "retrying";
  }
  if (state.pausedReason !== "none") {
    return "paused";
  }
  if (state.queueEvents > NONE) {
    return state.scheduled ? "scheduled" : "queued";
  }
  return undefined;
}

/**
 * @param {HealthState} state
 * @returns {string}
 */
function deliveryState(state) {
  const active = activeState(state);
  if (active !== undefined) {
    return active;
  }
  if (state.lastOutcome === "accepted" || state.lastOutcome === "failed") {
    return state.lastOutcome;
  }
  return state.droppedEvents > NONE ? "dropped" : "idle";
}

/**
 * @param {HealthState} state
 * @returns {Readonly<Record<string, unknown>>}
 */
function deliveryHealthSnapshot(state) {
  /** @type {Readonly<Record<string, unknown>>} */
  const values = {
    ...state,
    deliveryState: deliveryState(state),
    droppedByReason: Object.freeze({ ...state.droppedByReason }),
    schemaVersion: DELIVERY_HEALTH_SCHEMA_VERSION
  };
  return Object.freeze(Object.fromEntries(HEALTH_KEYS.map((key) => [key, values[key]])));
}

module.exports = { deliveryHealthSnapshot, lifecycleOf };
