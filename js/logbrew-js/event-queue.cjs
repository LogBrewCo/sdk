const { cloneEvent } = require("./event-clone.cjs");
const { createEventStoreFromQueueFactory, loadStoredEvents } = require("./event-store.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { isOrderedSubsequence, requireSynchronousStoreResult } = require("./stored-events.cjs");
const { utf8ByteLength } = require("./utf8.cjs");

/**
 * @import { ClientReport } from "./client-report.cjs"
 * @import { SdkEvent } from "./event-validation.cjs"
 * @import { EventStore, StoreLimits } from "./event-store.cjs"
 * @typedef {ReturnType<typeof loadStoredEvents>} RecoveredEvents
 * @import { Callable, DeepReadonly } from "./validation.cjs"
 * @typedef {Readonly<{ body: string, carriesClientReport: boolean, eventsCount: number }>} Batch
 * @typedef {"queue_overflow" | "queue_bytes_overflow"} OverflowReason
 * @typedef {Readonly<{
 *   eventStore: EventStore | undefined,
 *   eventQueueFactory: Callable | undefined,
 *   sdk: Readonly<{ name: string, language: string, version: string }>,
 *   maxBatchBytes: number,
 *   maxQueueBytes: number,
 *   maxQueueSize: number
 * }>} EventQueueConfig
 */

const BATCH_SUFFIX = "]}";
const BATCH_SUFFIX_BYTES = 2;
const PREVIEW_INDENT = 2;
const FIRST_INDEX = 0;
const SEPARATOR_BYTES = 1;
const NO_BYTES = 0;
const NO_EVENTS = 0;
const SINGLE = 1;
const PREVIOUS = 1;

/**
 * @param {DeepReadonly<SdkEvent> | undefined} event
 * @returns {boolean}
 */
function isFatalEvent(event) {
  return event?.type === "issue" && event.attributes["level"] === "critical";
}

/**
 * @param {EventStore} store
 * @returns {boolean}
 */
function closeOwnedStore(store) {
  try {
    requireSynchronousStoreResult("close", store.close());
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {EventQueueConfig} config
 * @param {StoreLimits} limits
 * @returns {Readonly<{ contents: RecoveredEvents, eventStore: EventStore | undefined }>}
 */
function openEventStore(config, limits) {
  const { eventQueueFactory } = config;
  const eventStore = eventQueueFactory === undefined
    ? config.eventStore
    : createEventStoreFromQueueFactory(eventQueueFactory, limits);
  try {
    return { contents: loadStoredEvents(eventStore, limits), eventStore };
  } catch (error) {
    if (eventQueueFactory !== undefined && eventStore !== undefined) {
      closeOwnedStore(eventStore);
    }
    throw error;
  }
}

class EventQueue {
  /**
   * @param {EventQueueConfig} config
   */
  constructor(config) {
    this.sdk = config.sdk;
    this.batchPrefix = `{"sdk":${JSON.stringify(config.sdk)},"events":[`;
    /** @type {StoreLimits} */
    this.limits = Object.freeze({
      batchPrefixBytes: utf8ByteLength(this.batchPrefix),
      batchSuffixBytes: BATCH_SUFFIX_BYTES,
      maxBatchBytes: config.maxBatchBytes,
      maxQueueBytes: config.maxQueueBytes,
      maxQueueSize: config.maxQueueSize
    });
    const { contents, eventStore } = openEventStore(config, this.limits);
    this.eventStore = eventStore;
    this.contents = contents;
    this.hydrated = Object.freeze({ bytes: contents.queuedEventBytes, events: contents.events.length });
    /** @type {Batch | undefined} */
    this.unacknowledgedBatch = undefined;
  }

  /**
   * @returns {DeepReadonly<SdkEvent>[]}
   */
  get events() {
    return this.contents.events;
  }

  /**
   * @returns {number}
   */
  get queuedEventBytes() {
    return this.contents.queuedEventBytes;
  }

  /**
   * @returns {void}
   */
  synchronize() {
    if (this.eventStore === undefined) {
      return;
    }
    const recovered = loadStoredEvents(this.eventStore, this.limits);
    if (!isOrderedSubsequence(this.contents.serializedEvents, recovered.serializedEvents)) {
      throw new SdkError("persistence_error", "event store lost a queued record");
    }
    this.contents = recovered;
  }

  /**
   * @param {number} count
   * @param {number} bytes
   * @returns {OverflowReason | undefined}
   */
  overflowReason(count, bytes) {
    if (count >= this.limits.maxQueueSize) {
      return "queue_overflow";
    }
    return bytes > this.limits.maxQueueBytes ? "queue_bytes_overflow" : undefined;
  }

  /**
   * @param {number} eventBytes
   * @returns {number[] | undefined}
   */
  evictionIndexes(eventBytes) {
    const indexes = [];
    const { events, serializedEventBytes } = this.contents;
    let count = events.length;
    let bytes = this.contents.queuedEventBytes + eventBytes;
    for (
      let index = this.unacknowledgedBatch?.eventsCount ?? FIRST_INDEX;
      index < events.length && this.overflowReason(count, bytes) !== undefined;
      index += SINGLE
    ) {
      if (!isFatalEvent(events[index])) {
        indexes.push(index);
        count -= SINGLE;
        bytes -= serializedEventBytes[index] ?? NO_BYTES;
      }
    }
    return this.overflowReason(count, bytes) === undefined ? indexes : undefined;
  }

  /**
   * @param {number} eventBytes
   * @returns {DeepReadonly<SdkEvent>[]}
   */
  evictForFatal(eventBytes) {
    const { eventStore } = this;
    if (eventStore !== undefined && typeof eventStore.remove !== "function") {
      return [];
    }
    const indexes = this.evictionIndexes(eventBytes);
    if (indexes === undefined) {
      return [];
    }
    if (eventStore !== undefined) {
      requireSynchronousStoreResult("remove", eventStore.remove?.(indexes));
    }
    return this.removeIndexes(indexes);
  }

  /**
   * @param {readonly number[]} indexes
   * @returns {DeepReadonly<SdkEvent>[]}
   */
  removeIndexes(indexes) {
    const evicted = indexes.map((index) => this.contents.events[index]).filter((event) => event !== undefined);
    for (let position = indexes.length - PREVIOUS; position >= FIRST_INDEX; position -= SINGLE) {
      this.removeAt(indexes[position] ?? FIRST_INDEX);
    }
    return evicted;
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  removeAt(index) {
    const { contents } = this;
    contents.events.splice(index, SINGLE);
    contents.serializedEvents.splice(index, SINGLE);
    contents.queuedEventBytes -= contents.serializedEventBytes.splice(index, SINGLE)[FIRST_INDEX] ?? NO_BYTES;
  }

  /**
   * @param {DeepReadonly<SdkEvent>} event
   * @param {string} serializedEvent
   * @param {number} eventBytes
   * @returns {void}
   */
  append(event, serializedEvent, eventBytes) {
    if (this.eventStore !== undefined) {
      requireSynchronousStoreResult("append", this.eventStore.append({ event: cloneEvent(event), eventBytes, serializedEvent }));
    }
    const { contents } = this;
    contents.events.push(event);
    contents.serializedEvents.push(serializedEvent);
    contents.serializedEventBytes.push(eventBytes);
    contents.queuedEventBytes += eventBytes;
  }

  /**
   * @param {number} eventsCount
   * @returns {void}
   */
  acknowledge(eventsCount) {
    if (this.eventStore !== undefined) {
      requireSynchronousStoreResult("acknowledge", this.eventStore.acknowledge(eventsCount));
    }
    const { contents } = this;
    const acknowledgedBytes = contents.serializedEventBytes.slice(FIRST_INDEX, eventsCount).reduce((sum, bytes) => sum + bytes, NO_BYTES);
    contents.events.splice(FIRST_INDEX, eventsCount);
    contents.serializedEvents.splice(FIRST_INDEX, eventsCount);
    contents.serializedEventBytes.splice(FIRST_INDEX, eventsCount);
    contents.queuedEventBytes -= acknowledgedBytes;
  }

  /**
   * @returns {number}
   */
  purge() {
    const { contents } = this;
    const purgedEvents = contents.events.length;
    if (this.eventStore !== undefined) {
      requireSynchronousStoreResult("purge", this.eventStore.purge());
    }
    this.unacknowledgedBatch = undefined;
    contents.events.splice(FIRST_INDEX);
    contents.serializedEvents.splice(FIRST_INDEX);
    contents.serializedEventBytes.splice(FIRST_INDEX);
    contents.queuedEventBytes = 0;
    return purgedEvents;
  }

  /**
   * @returns {string}
   */
  previewJson() {
    return JSON.stringify({
      sdk: this.sdk,

      events: this.contents.events
    }, undefined, PREVIEW_INDENT);
  }

  /**
   * @param {number} maxEvents
   * @param {ClientReport | undefined} report
   * @returns {Batch}
   */
  nextBatch(maxEvents, report) {
    const reportSuffix = report === undefined ? undefined : `],"client_report":${JSON.stringify(report)}}`;
    const reportedEvents = reportSuffix === undefined ? NO_EVENTS : this.batchEventCount(maxEvents, utf8ByteLength(reportSuffix));
    const eventsCount = reportedEvents === NO_EVENTS ? this.batchEventCount(maxEvents, BATCH_SUFFIX_BYTES) : reportedEvents;
    if (eventsCount === NO_EVENTS) {
      throw new SdkError("transport_error", "queued event cannot fit the configured batch byte limit");
    }
    const suffix = reportedEvents === NO_EVENTS ? BATCH_SUFFIX : reportSuffix ?? BATCH_SUFFIX;
    return {
      body: `${this.batchPrefix}${this.contents.serializedEvents.slice(FIRST_INDEX, eventsCount).join(",")}${suffix}`,
      carriesClientReport: reportedEvents > NO_EVENTS,
      eventsCount
    };
  }

  /**
   * @param {number} maxEvents
   * @param {number} suffixBytes
   * @returns {number}
   */
  batchEventCount(maxEvents, suffixBytes) {
    const { events, serializedEventBytes } = this.contents;
    let bodyBytes = this.limits.batchPrefixBytes + suffixBytes;
    const eventIds = new Set();
    for (let index = FIRST_INDEX; index < maxEvents; index += SINGLE) {
      const event = events[index];
      bodyBytes += (index === FIRST_INDEX ? NO_BYTES : SEPARATOR_BYTES) + (serializedEventBytes[index] ?? NO_BYTES);
      if (event === undefined || eventIds.has(event.id) || bodyBytes > this.limits.maxBatchBytes) {
        return index;
      }
      eventIds.add(event.id);
    }
    return maxEvents;
  }
}

module.exports = { EventQueue, isFatalEvent };
