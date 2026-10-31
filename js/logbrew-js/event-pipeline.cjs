const { BatchSender } = require("./batch-sender.cjs");
const { addBounded, incrementBounded, nextBoundedTimestamp } = require("./bounded-number.cjs");
const { DropLedger } = require("./client-report.cjs");
const { cloneEvent } = require("./event-clone.cjs");
const { EventQueue, isFatalEvent } = require("./event-queue.cjs");
const { isClientReportStore } = require("./event-store.cjs");
const { utf8ByteLength } = require("./utf8.cjs");
const { isCallable } = require("./validation.cjs");

/**
 * @import { BatchTransport } from "./batch-sender.cjs"
 * @import { DropReason } from "./client-report.cjs"
 * @import { SdkEvent } from "./event-validation.cjs"
 * @import { Batch, EventQueueConfig, OverflowReason } from "./event-queue.cjs"
 * @import { ClientReportStore } from "./event-store.cjs"
 * @import { HealthState } from "./delivery-health.cjs"
 * @import { Callable, DeepReadonly } from "./validation.cjs"
 * @typedef {Readonly<{ status: string, reason?: DropReason }>} EventAdmission
 * @typedef {Readonly<{ eventFilter: () => unknown, onEventDropped: () => unknown, receiver: unknown }>} PipelineHooks
 * @typedef {Readonly<{ statusCode: number, attempts: number, batches: number }>} FlushResult
 * @typedef {"idle" | "empty" | "accepted" | "failed"} DeliveryOutcome
 * @typedef {EventQueueConfig & Readonly<{
 *   apiKey: () => string,
 *   clientReportStore: ClientReportStore | undefined,
 *   maxBatchEvents: number,
 *   maxRetries: number,
 *   hooks: PipelineHooks
 * }>} PipelineConfig
 */

/**
 * @param {DropReason} reason
 * @returns {EventAdmission}
 */
function droppedAdmission(reason) {
  return Object.freeze({
    status: "dropped",

    reason
  });
}

const EVENT_ADMISSIONS = Object.freeze({
  admitted: Object.freeze({ status: "admitted" }),

  filtered: Object.freeze({ status: "filtered" }),

  unavailable: Object.freeze({ status: "unavailable" }),

  event_too_large: droppedAdmission("event_too_large"),

  queue_overflow: droppedAdmission("queue_overflow"),

  queue_bytes_overflow: droppedAdmission("queue_bytes_overflow")
});
const NO_CONTENT = 204;
const NO_EVENTS = 0;
const NO_OPERATIONS = 0;
const STEP = 1;

/**
 * @param {Readonly<Promise<unknown>>} operation
 * @returns {Promise<boolean>}
 */
async function settled(operation) {
  try {
    await operation;
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Callable} callback
 * @param {unknown} receiver
 * @param {unknown} argument
 * @returns {boolean}
 */
function notify(callback, receiver, argument) {
  try {
    Reflect.apply(callback, receiver, [argument]);
    return true;
  } catch {
    return false;
  }
}

class EventPipeline {
  /** @type {Promise<boolean>} */
  operationTail = Promise.resolve(true);

  pendingOperations = NO_OPERATIONS;

  deliveryInFlight = false;

  stats = {
    acceptedBatchCount: NO_EVENTS,
    acceptedEventCount: NO_EVENTS,
    failedFlushCount: NO_EVENTS,
    lastAcceptedAtUnixMs: NO_EVENTS,
    successfulFlushCount: NO_EVENTS
  };

  /** @type {DeliveryOutcome} */
  lastDeliveryOutcome = "idle";

  /**
   * @param {PipelineConfig} config
   */
  constructor(config) {
    this.hooks = config.hooks;
    this.maxBatchEvents = config.maxBatchEvents;
    this.queue = new EventQueue(config);
    const { eventStore } = this.queue;
    this.ledger = new DropLedger(config.clientReportStore ?? (isClientReportStore(eventStore) ? eventStore : undefined));
    this.sender = new BatchSender(config);
  }

  /**
   * @returns {Omit<HealthState, "automaticDelivery" | "lifecycle" | "scheduled" | "coalesced" | "pausedReason" | "consecutiveFailures" | "retryDelayMs">}
   */
  health() {
    const { ledger, queue, sender, stats } = this;
    return {
      acceptedEvents: stats.acceptedEventCount,
      attempts: sender.deliveryAttemptCount,
      batches: stats.acceptedBatchCount,
      droppedByReason: ledger.droppedEventsByReason,
      droppedEvents: ledger.droppedEventCount,
      failures: stats.failedFlushCount,
      flushes: stats.successfulFlushCount,
      hydratedBytes: queue.hydrated.bytes,
      hydratedEvents: queue.hydrated.events,
      inFlight: this.deliveryInFlight,
      lastAcceptedAtUnixMs: stats.lastAcceptedAtUnixMs,
      lastAttemptAtUnixMs: sender.lastAttemptAtUnixMs,
      lastDropReason: ledger.lastDropReason,
      lastDroppedAtUnixMs: ledger.lastDroppedAtUnixMs,
      lastOutcome: this.lastDeliveryOutcome,
      lastStatusClass: sender.lastStatusClass,
      pendingOperations: this.pendingOperations,
      queueBytes: queue.queuedEventBytes,
      queueEvents: queue.events.length,
      storage: queue.eventStore === undefined ? "memory" : "persistent"
    };
  }

  /**
   * @param {DeepReadonly<SdkEvent>} event
   * @returns {EventAdmission}
   */
  admit(event) {
    const eventFilter = this.hooks.eventFilter();
    if (isCallable(eventFilter) && Reflect.apply(eventFilter, this.hooks.receiver, [cloneEvent(event)]) === false) {
      return EVENT_ADMISSIONS.filtered;
    }
    const serializedEvent = JSON.stringify(event);
    const eventBytes = utf8ByteLength(serializedEvent);
    const { queue } = this;
    if (queue.limits.batchPrefixBytes + eventBytes + queue.limits.batchSuffixBytes > queue.limits.maxBatchBytes) {
      this.recordDroppedEvent(event, "event_too_large");
      return EVENT_ADMISSIONS.event_too_large;
    }
    return this.enqueue(event, serializedEvent, eventBytes);
  }

  /**
   * @param {DeepReadonly<SdkEvent>} event
   * @param {number} eventBytes
   * @returns {Readonly<{ evicted: DeepReadonly<SdkEvent>[], overflow: OverflowReason | undefined }>}
   */
  makeRoom(event, eventBytes) {
    const { queue } = this;
    const fatal = isFatalEvent(event);
    if (fatal) {
      queue.synchronize();
    }
    const overflow = queue.overflowReason(queue.events.length, queue.queuedEventBytes + eventBytes);
    return { evicted: overflow !== undefined && fatal ? queue.evictForFatal(eventBytes) : [], overflow };
  }

  /**
   * @param {DeepReadonly<SdkEvent>} event
   * @param {string} serializedEvent
   * @param {number} eventBytes
   * @returns {EventAdmission}
   */
  enqueue(event, serializedEvent, eventBytes) {
    const { evicted, overflow } = this.makeRoom(event, eventBytes);
    if (overflow !== undefined && evicted.length === NO_EVENTS) {
      this.recordDroppedEvent(event, overflow);
      return EVENT_ADMISSIONS[overflow];
    }
    try {
      this.queue.append(event, serializedEvent, eventBytes);
    } finally {
      for (const evictedEvent of evicted) {
        this.recordDroppedEvent(evictedEvent, "evicted_for_fatal");
      }
    }
    return EVENT_ADMISSIONS.admitted;
  }

  /**
   * @param {DeepReadonly<SdkEvent>} event
   * @param {DropReason} reason
   * @returns {boolean}
   */
  recordDroppedEvent(event, reason) {
    this.ledger.record(reason);
    const onEventDropped = this.hooks.onEventDropped();
    return isCallable(onEventDropped) && notify(onEventDropped, this.hooks.receiver, {
      droppedEvents: this.ledger.droppedEventCount,
      eventId: event.id,
      eventType: event.type,
      reason
    });
  }

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async runSerialized(operation) {
    this.pendingOperations = incrementBounded(this.pendingOperations);
    const result = this.afterTail(operation);
    this.operationTail = settled(result);
    return result;
  }

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async afterTail(operation) {
    await this.operationTail;
    try {
      return await operation();
    } finally {
      this.pendingOperations = Math.max(NO_OPERATIONS, this.pendingOperations - STEP);
    }
  }

  /**
   * @param {BatchTransport} transport
   * @returns {Promise<FlushResult>}
   */
  async flushWithHealth(transport) {
    this.deliveryInFlight = true;
    try {
      const response = await this.flushSnapshot(transport);
      this.stats.successfulFlushCount = incrementBounded(this.stats.successfulFlushCount);
      this.lastDeliveryOutcome = response.batches === NO_EVENTS ? "empty" : "accepted";
      return response;
    } catch (error) {
      this.stats.failedFlushCount = incrementBounded(this.stats.failedFlushCount);
      this.lastDeliveryOutcome = "failed";
      throw error;
    } finally {
      this.deliveryInFlight = false;
    }
  }

  /**
   * @param {BatchTransport} transport
   * @returns {Promise<FlushResult>}
   */
  async flushSnapshot(transport) {
    this.queue.synchronize();
    const totals = {
      statusCode: NO_CONTENT,

      attempts: 0,

      batches: 0
    };
    for (let remainingEvents = this.queue.events.length; remainingEvents > NO_EVENTS;) {
      const batch = this.currentBatch(remainingEvents);
      const response = await this.sender.send(transport, batch.body);
      remainingEvents -= this.settleBatch(batch);
      totals.attempts += response.attempts;
      totals.batches += STEP;
      totals.statusCode = response.statusCode;
    }
    return totals;
  }

  /**
   * @param {number} remainingEvents
   * @returns {Batch}
   */
  currentBatch(remainingEvents) {
    const { queue } = this;
    const batch = queue.unacknowledgedBatch ?? Object.freeze(queue.nextBatch(
      Math.min(remainingEvents, queue.events.length, this.maxBatchEvents),
      this.ledger.pendingReport()
    ));
    queue.unacknowledgedBatch = batch;
    return batch;
  }

  /**
   * @param {Batch} batch
   * @returns {number}
   */
  settleBatch(batch) {
    this.queue.unacknowledgedBatch = undefined;
    if (batch.carriesClientReport) {
      this.ledger.acknowledgeReport();
    }
    this.queue.acknowledge(batch.eventsCount);
    this.stats.acceptedEventCount = addBounded(this.stats.acceptedEventCount, batch.eventsCount);
    this.stats.lastAcceptedAtUnixMs = nextBoundedTimestamp(Math.max(
      this.stats.lastAcceptedAtUnixMs,
      this.sender.lastAttemptAtUnixMs
    ));
    this.stats.acceptedBatchCount = incrementBounded(this.stats.acceptedBatchCount);
    return batch.eventsCount;
  }
}

module.exports = { EVENT_ADMISSIONS, EventPipeline };
