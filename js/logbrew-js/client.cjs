const { cloneEvent } = require("./event-clone.cjs");
const {
  EVENT_VALIDATORS,
  validateAction,
  validateEnvironment,
  validateIssue,
  validateLog,
  validateRelease
} = require("./event-validation.cjs");
const { MAX_ISSUE_BREADCRUMBS, validateIssueBreadcrumb } = require("./issue-diagnostics.cjs");
const { validateMetric } = require("./metric-validation.cjs");
const { SdkError, retryAfterMsOrUndefined } = require("./sdk-error.cjs");
const { validateSpan } = require("./span-validation.cjs");
const { cloneTelemetryContext, mergeTelemetryContexts, validateTelemetryContext } = require("./telemetry-context.cjs");
const { TransportError } = require("./transport-error.cjs");
const {
  requireNonEmpty,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireTimestamp
} = require("./validation.cjs");

const EVENT_ADMISSIONS = Object.freeze({
  admitted: Object.freeze({ status: "admitted" }),
  filtered: Object.freeze({ status: "filtered" }),
  unavailable: Object.freeze({ status: "unavailable" }),
  event_too_large: Object.freeze({ status: "dropped", reason: "event_too_large" }),
  queue_overflow: Object.freeze({ status: "dropped", reason: "queue_overflow" }),
  queue_bytes_overflow: Object.freeze({ status: "dropped", reason: "queue_bytes_overflow" })
});
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BATCH_EVENTS = 100;
const DEFAULT_MAX_BATCH_BYTES = 256 * 1024;
// One second matches the OpenTelemetry log processor default, so a lone event becomes readable quickly.
const DEFAULT_DELIVERY_INTERVAL_MS = 1000;
const MAX_DELIVERY_INTERVAL_MS = 60 * 1000;
// A rate-limited batch waits from 1 second to 1 hour, plus up to 10 percent jitter, before it is sent again.
const MIN_RATE_LIMIT_WAIT_MS = 1000;
const MAX_RATE_LIMIT_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_DELIVERY_QUEUE_THRESHOLD = 50;
const MAX_CLIENT_REPORT_REASONS = 16;
const MAX_CLIENT_REPORT_COUNT = 1_000_000_000;
const DELIVERY_HEALTH_SCHEMA_VERSION = 1;
const EVENT_QUEUE_FACTORY = Symbol.for("@logbrew/sdk.eventQueueFactory");
// Runtimes without an event store (browser storage) persist unreported drop counts through this seam.
const CLIENT_REPORT_STORE = Symbol.for("@logbrew/sdk.clientReportStore");
const CLIENT_REPORT_SAVE_INTERVAL_MS = 1_000;
const CLIENT_REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const CLIENT_REPORT_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const CONTEXT_PROVIDER = Symbol.for("@logbrew/sdk.contextProvider");
// Runtime packages supply request-scoped breadcrumbs through this seam; core merges them into issues.
const BREADCRUMB_PROVIDER = Symbol.for("@logbrew/sdk.breadcrumbProvider");

class LogBrewClient {
  static #issueCapture = LogBrewClient.prototype.issue;

  static create({
    apiKey,
    sdkName,
    sdkVersion,
    context,
    [CONTEXT_PROVIDER]: contextProvider,
    [BREADCRUMB_PROVIDER]: breadcrumbProvider,
    maxRetries = 2,
    eventFilter,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES,
    maxBatchEvents = DEFAULT_MAX_BATCH_EVENTS,
    maxBatchBytes = DEFAULT_MAX_BATCH_BYTES,
    onEventDropped,
    eventStore,
    [EVENT_QUEUE_FACTORY]: eventQueueFactory,
    [CLIENT_REPORT_STORE]: clientReportStore,
    transport,
    automaticDelivery = transport !== undefined,
    deliveryIntervalMs = DEFAULT_DELIVERY_INTERVAL_MS,
    deliveryQueueThreshold = Math.min(DEFAULT_DELIVERY_QUEUE_THRESHOLD, maxQueueSize)
  }) {
    requireNonEmpty("apiKey", apiKey);
    requireNonEmpty("sdkName", sdkName);
    requireNonEmpty("sdkVersion", sdkVersion);
    const clientContext = validateTelemetryContext(context, "client telemetry context");
    if (contextProvider !== undefined && typeof contextProvider !== "function") {
      throw new SdkError("validation_error", "context provider must be a function");
    }
    if (breadcrumbProvider !== undefined && typeof breadcrumbProvider !== "function") {
      throw new SdkError("validation_error", "breadcrumb provider must be a function");
    }
    requireNonNegativeInteger("maxRetries", maxRetries);
    if (eventFilter !== undefined && typeof eventFilter !== "function") {
      throw new SdkError("validation_error", "eventFilter must be a function");
    }
    requirePositiveInteger("maxQueueSize", maxQueueSize);
    requirePositiveInteger("maxQueueBytes", maxQueueBytes);
    requirePositiveInteger("maxBatchEvents", maxBatchEvents);
    requirePositiveInteger("maxBatchBytes", maxBatchBytes);
    if (onEventDropped !== undefined && typeof onEventDropped !== "function") {
      throw new SdkError("validation_error", "onEventDropped must be a function");
    }
    validateEventStore(eventStore);
    if (eventQueueFactory !== undefined && typeof eventQueueFactory !== "function") {
      throw new SdkError("validation_error", "event queue factory must be a function");
    }
    if (eventStore !== undefined && eventQueueFactory !== undefined) {
      throw new SdkError("validation_error", "eventStore and event queue factory are mutually exclusive");
    }
    if (clientReportStore !== undefined && !isClientReportStore(clientReportStore)) {
      throw new SdkError("validation_error", "client report store must provide loadClientReport and saveClientReport");
    }
    validateTransport(transport);
    if (typeof automaticDelivery !== "boolean") {
      throw new SdkError("validation_error", "automaticDelivery must be a boolean");
    }
    if (automaticDelivery && transport === undefined) {
      throw new SdkError("validation_error", "automaticDelivery requires transport");
    }
    requirePositiveInteger("deliveryIntervalMs", deliveryIntervalMs);
    if (deliveryIntervalMs > MAX_DELIVERY_INTERVAL_MS) {
      throw new SdkError("validation_error", `deliveryIntervalMs must be at most ${MAX_DELIVERY_INTERVAL_MS}`);
    }
    requirePositiveInteger("deliveryQueueThreshold", deliveryQueueThreshold);
    if (deliveryQueueThreshold > maxQueueSize) {
      throw new SdkError("validation_error", "deliveryQueueThreshold must not exceed maxQueueSize");
    }

    return new LogBrewClient({
      apiKey,
      automaticDelivery,
      deliveryIntervalMs,
      deliveryQueueThreshold,
      eventStore,
      eventQueueFactory,
      clientReportStore,
      eventFilter,
      maxBatchBytes,
      maxBatchEvents,
      maxQueueBytes,
      maxQueueSize,
      onEventDropped,
      context: clientContext,
      contextProvider,
      breadcrumbProvider,
      sdk: {
        name: sdkName,
        language: "javascript",
        version: sdkVersion
      },
      maxRetries,
      transport
    });
  }

  constructor({
    apiKey,
    sdk,
    maxRetries,
    eventFilter,
    maxBatchBytes,
    maxBatchEvents,
    maxQueueBytes,
    maxQueueSize,
    onEventDropped,
    context,
    contextProvider,
    breadcrumbProvider,
    eventStore,
    eventQueueFactory,
    clientReportStore,
    transport,
    automaticDelivery,
    deliveryIntervalMs,
    deliveryQueueThreshold
  }) {
    this.apiKey = apiKey;
    this.automaticDelivery = automaticDelivery;
    this.deliveryIntervalMs = deliveryIntervalMs;
    this.deliveryQueueThreshold = deliveryQueueThreshold;
    this.eventFilter = eventFilter;
    this.maxBatchBytes = maxBatchBytes;
    this.maxBatchEvents = maxBatchEvents;
    this.maxQueueBytes = maxQueueBytes;
    this.maxQueueSize = maxQueueSize;
    this.onEventDropped = onEventDropped;
    this.context = cloneTelemetryContext(context);
    this.contextProvider = contextProvider;
    this.breadcrumbProvider = breadcrumbProvider;
    this.transport = transport;
    this.sdk = sdk;
    this.maxRetries = maxRetries;
    this.batchPrefix = `{"sdk":${JSON.stringify(this.sdk)},"events":[`;
    this.batchPrefixBytes = utf8ByteLength(this.batchPrefix);
    this.batchSuffix = "]}";
    this.batchSuffixBytes = utf8ByteLength(this.batchSuffix);
    const ownsEventStore = eventQueueFactory !== undefined;
    const resolvedEventStore = ownsEventStore
      ? createEventStoreFromQueueFactory(eventQueueFactory, {
          batchPrefixBytes: this.batchPrefixBytes,
          batchSuffixBytes: this.batchSuffixBytes,
          maxBatchBytes,
          maxQueueBytes,
          maxQueueSize
        })
      : eventStore;
    this.eventStore = resolvedEventStore;
    let recovered;
    try {
      recovered = loadStoredEvents(this);
    } catch (error) {
      if (ownsEventStore) {
        try {
          requireSynchronousStoreResult("close", resolvedEventStore.close());
        } catch {
          // Preserve the queue construction or recovery failure.
        }
      }
      throw error;
    }
    this.events = recovered.events;
    this.serializedEvents = recovered.serializedEvents;
    this.serializedEventBytes = recovered.serializedEventBytes;
    this.queuedEventBytes = recovered.queuedEventBytes;
    this.operationTail = Promise.resolve();
    this.pendingOperations = 0;
    this.closing = false;
    this.closed = false;
    this.droppedEventCount = 0;
    this.droppedEventsByReason = {
      event_too_large: 0,
      evicted_for_fatal: 0,
      queue_bytes_overflow: 0,
      queue_overflow: 0
    };
    // A persistent store keeps counts not yet acknowledged by a 2xx across restarts.
    this.clientReportStore = clientReportStore
      ?? (isClientReportStore(resolvedEventStore) ? resolvedEventStore : undefined);
    this.clientReportSavedAtMs = 0;
    const restoredReport = loadClientReport(this.clientReportStore);
    this.unreportedDropsByReason = restoredReport.unreported;
    // Drop counts frozen under one report ID until a 2xx acknowledges a body that carried them.
    this.pendingClientReport = restoredReport.pending;
    this.lastDropReason = "none";
    this.storage = resolvedEventStore ? "persistent" : "memory";
    this.hydratedEventCount = recovered.events.length;
    this.hydratedEventBytes = recovered.queuedEventBytes;
    this.deliveryTimer = undefined;
    this.automaticFlushActive = false;
    this.automaticFlushPending = false;
    this.deliveryInFlight = false;
    this.lastDeliveryOutcome = "idle";
    this.automaticPauseReason = "none";
    this.consecutiveDeliveryFailures = 0;
    this.retryDelayMs = 0;
    this.successfulFlushCount = 0;
    this.failedFlushCount = 0;
    this.deliveryAttemptCount = 0;
    this.acceptedBatchCount = 0;
    this.acceptedEventCount = 0;
    this.lastStatusClass = "none";
    this.lastAttemptAtUnixMs = 0;
    this.lastAcceptedAtUnixMs = 0;
    this.lastDroppedAtUnixMs = 0;
    this.unacknowledgedBatch = undefined;
    this.issueBreadcrumbs = [];
    this.issueBreadcrumbsTruncated = false;
    this.#scheduleAutomaticDelivery();
  }

  pendingEvents() {
    return this.events.length;
  }

  pendingBytes() {
    return this.queuedEventBytes;
  }

  droppedEvents() {
    return this.droppedEventCount;
  }

  deliveryHealth() {
    const droppedByReason = Object.freeze({ ...this.droppedEventsByReason });
    return Object.freeze({
      schemaVersion: DELIVERY_HEALTH_SCHEMA_VERSION,
      automaticDelivery: this.automaticDelivery,
      lifecycle: this.closed ? "closed" : this.closing ? "shutting_down" : "active",
      deliveryState: this.#deliveryState(),
      storage: this.storage,
      queueEvents: this.events.length,
      queueBytes: this.queuedEventBytes,
      hydratedEvents: this.hydratedEventCount,
      hydratedBytes: this.hydratedEventBytes,
      droppedEvents: this.droppedEventCount,
      droppedByReason,
      lastDropReason: this.lastDropReason,
      scheduled: this.deliveryTimer !== undefined,
      inFlight: this.deliveryInFlight,
      coalesced: this.automaticFlushPending,
      pendingOperations: this.pendingOperations,
      lastOutcome: this.lastDeliveryOutcome,
      lastStatusClass: this.lastStatusClass,
      pausedReason: this.automaticPauseReason,
      consecutiveFailures: this.consecutiveDeliveryFailures,
      retryDelayMs: this.retryDelayMs,
      flushes: this.successfulFlushCount,
      failures: this.failedFlushCount,
      attempts: this.deliveryAttemptCount,
      batches: this.acceptedBatchCount,
      acceptedEvents: this.acceptedEventCount,
      lastAttemptAtUnixMs: this.lastAttemptAtUnixMs,
      lastAcceptedAtUnixMs: this.lastAcceptedAtUnixMs,
      lastDroppedAtUnixMs: this.lastDroppedAtUnixMs
    });
  }

  #deliveryState() {
    if (this.deliveryInFlight) {
      return "in_flight";
    }
    if (this.retryDelayMs > 0) {
      return "retrying";
    }
    if (this.automaticPauseReason !== "none") {
      return "paused";
    }
    if (this.events.length > 0) {
      return this.deliveryTimer !== undefined ? "scheduled" : "queued";
    }
    if (this.lastDeliveryOutcome === "accepted") {
      return "accepted";
    }
    if (this.lastDeliveryOutcome === "failed") {
      return "failed";
    }
    if (this.droppedEventCount > 0) {
      return "dropped";
    }
    return "idle";
  }

  previewJson() {
    return JSON.stringify({ sdk: this.sdk, events: this.events }, null, 2);
  }

  purgePendingEvents() {
    if (this.closed) {
      throw new SdkError("shutdown_error", "client is already shut down");
    }
    if (this.closing) {
      throw new SdkError("shutdown_error", "client is shutting down");
    }
    if (this.pendingOperations > 0 || this.automaticFlushActive) {
      throw new SdkError("persistence_error", "cannot purge while a delivery operation is active");
    }
    const purgedEvents = this.events.length;
    if (this.eventStore) {
      requireSynchronousStoreResult("purge", this.eventStore.purge());
    }
    this.#clearDeliveryTimer();
    this.automaticFlushPending = false;
    this.unacknowledgedBatch = undefined;
    this.events.splice(0, this.events.length);
    this.serializedEvents.splice(0, this.serializedEvents.length);
    this.serializedEventBytes.splice(0, this.serializedEventBytes.length);
    this.queuedEventBytes = 0;
    return purgedEvents;
  }

  addBreadcrumb(breadcrumb, timestamp = new Date().toISOString()) {
    if (this.closed) {
      throw new SdkError("shutdown_error", "client is already shut down");
    }
    if (this.closing) {
      throw new SdkError("shutdown_error", "client is shutting down");
    }
    const validated = validateIssueBreadcrumb(breadcrumb, timestamp);
    if (this.issueBreadcrumbs.length === MAX_ISSUE_BREADCRUMBS) {
      this.issueBreadcrumbs.shift();
      this.issueBreadcrumbsTruncated = true;
    }
    this.issueBreadcrumbs.push(validated);
  }

  clearBreadcrumbs() {
    const cleared = this.issueBreadcrumbs.length;
    this.issueBreadcrumbs.splice(0, cleared);
    this.issueBreadcrumbsTruncated = false;
    return cleared;
  }

  release(id, timestamp, attributes) {
    this.#pushEvent("release", id, timestamp, validateRelease(attributes));
  }

  environment(id, timestamp, attributes) {
    this.#pushEvent("environment", id, timestamp, validateEnvironment(attributes));
  }

  issue(id, timestamp, attributes) {
    this.#pushIssue(id, timestamp, attributes);
  }

  issueWithAdmission(id, timestamp, attributes) {
    const issue = this.issue;
    if (issue !== LogBrewClient.#issueCapture) {
      issue.call(this, id, timestamp, attributes);
      return EVENT_ADMISSIONS.unavailable;
    }
    return this.#pushIssue(id, timestamp, attributes);
  }

  log(id, timestamp, attributes) {
    this.#pushEvent("log", id, timestamp, validateLog(attributes));
  }

  span(id, timestamp, attributes) {
    this.#pushEvent("span", id, timestamp, validateSpan(attributes));
  }

  action(id, timestamp, attributes) {
    this.#pushEvent("action", id, timestamp, validateAction(attributes));
  }

  metric(id, timestamp, attributes) {
    this.#pushEvent("metric", id, timestamp, validateMetric(attributes));
  }

  async flush(transport) {
    if (this.closed) {
      throw new SdkError("shutdown_error", "client is already shut down");
    }
    if (this.closing) {
      throw new SdkError("shutdown_error", "client is shutting down");
    }
    const resolvedTransport = this.#resolveTransport(transport);
    const controlsAutomaticDelivery = this.automaticDelivery && resolvedTransport === this.transport;
    this.#clearDeliveryTimer();
    return this.#runSerialized(async () => {
      this.#clearDeliveryTimer();
      try {
        const response = await this.#flushWithHealth(resolvedTransport);
        if (controlsAutomaticDelivery) {
          this.#recordAutomaticSuccess();
        }
        return response;
      } catch (error) {
        if (controlsAutomaticDelivery) {
          this.#recordAutomaticFailure(error);
        }
        throw error;
      } finally {
        if (this.automaticDelivery && !this.closed && !this.closing) {
          this.#resumeAutomaticDelivery();
        }
      }
    });
  }

  async shutdown(transport) {
    if (this.closed) {
      throw new SdkError("shutdown_error", "client is already shut down");
    }
    if (this.closing) {
      throw new SdkError("shutdown_error", "client is shutting down");
    }
    const resolvedTransport = this.#resolveTransport(transport);
    const controlsAutomaticDelivery = this.automaticDelivery && resolvedTransport === this.transport;
    this.#clearDeliveryTimer();
    this.automaticFlushPending = false;
    this.closing = true;
    try {
      const response = await this.#runSerialized(() => this.#flushWithHealth(resolvedTransport));
      if (controlsAutomaticDelivery) {
        this.#recordAutomaticSuccess();
      }
      this.#saveClientReport(true);
      if (this.eventStore) {
        try {
          requireSynchronousStoreResult("close", this.eventStore.close());
        } catch (error) {
          this.closed = true;
          throw error;
        }
      }
      this.closed = true;
      return response;
    } catch (error) {
      if (!this.closed) {
        this.closing = false;
        if (controlsAutomaticDelivery) {
          this.#recordAutomaticFailure(error);
        }
        this.#resumeAutomaticDelivery();
      }
      throw error;
    }
  }

  #pushIssue(id, timestamp, attributes) {
    if (attributes.breadcrumbs !== undefined) {
      return this.#pushEvent("issue", id, timestamp, validateIssue(attributes));
    }
    const provided = this.#providedBreadcrumbs();
    const merged = provided.breadcrumbs.length === 0
      ? this.issueBreadcrumbs
      : [...this.issueBreadcrumbs, ...provided.breadcrumbs]
        .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    const breadcrumbs = merged.slice(-MAX_ISSUE_BREADCRUMBS);
    const truncated = attributes.breadcrumbsTruncated === true || this.issueBreadcrumbsTruncated
      || provided.truncated || merged.length > breadcrumbs.length;
    const withBreadcrumbs = breadcrumbs.length === 0
      ? attributes
      : { ...attributes, breadcrumbs, ...(truncated ? { breadcrumbsTruncated: true } : {}) };
    return this.#pushEvent("issue", id, timestamp, validateIssue(withBreadcrumbs));
  }

  // Provider failures and invalid entries never cost the issue itself.
  #providedBreadcrumbs() {
    let provided;
    try {
      provided = this.breadcrumbProvider?.();
    } catch {
      return { breadcrumbs: [], truncated: false };
    }
    if (!provided || !Array.isArray(provided.breadcrumbs)) {
      return { breadcrumbs: [], truncated: false };
    }
    const breadcrumbs = [];
    let truncated = provided.truncated === true || provided.breadcrumbs.length > MAX_ISSUE_BREADCRUMBS;
    for (const breadcrumb of provided.breadcrumbs.slice(-MAX_ISSUE_BREADCRUMBS)) {
      try {
        breadcrumbs.push(validateIssueBreadcrumb(breadcrumb));
      } catch {
        truncated = true;
      }
    }
    return { breadcrumbs, truncated };
  }

  #pushEvent(eventType, id, timestamp, attributes) {
    if (this.closed) {
      throw new SdkError("shutdown_error", "client is already shut down");
    }
    if (this.closing) {
      throw new SdkError("shutdown_error", "client is shutting down");
    }
    requireNonEmpty("event id", id);
    requireTimestamp(timestamp);
    const context = mergeTelemetryContexts(
      mergeTelemetryContexts(this.context, this.contextProvider?.()),
      attributes.context
    );
    const eventAttributes = context === undefined
      ? attributes
      : { ...attributes, context };
    const event = { type: eventType, id, timestamp, attributes: eventAttributes };
    if (this.eventFilter && this.eventFilter(cloneEvent(event)) === false) {
      return EVENT_ADMISSIONS.filtered;
    }
    const serializedEvent = JSON.stringify(event);
    const eventBytes = utf8ByteLength(serializedEvent);
    if (this.batchPrefixBytes + eventBytes + this.batchSuffixBytes > this.maxBatchBytes) {
      this.#recordDroppedEvent(event, "event_too_large");
      return EVENT_ADMISSIONS.event_too_large;
    }
    const fatal = isFatalEvent(event);
    if (fatal) {
      this.#synchronizeEventStore();
    }
    const overflow = this.#overflowReason(this.events.length, this.queuedEventBytes + eventBytes);
    const evicted = overflow && fatal ? this.#evictForFatal(eventBytes) : [];
    if (overflow && evicted.length === 0) {
      this.#recordDroppedEvent(event, overflow);
      return EVENT_ADMISSIONS[overflow];
    }
    try {
      if (this.eventStore) {
        requireSynchronousStoreResult("append", this.eventStore.append({
          event: cloneEvent(event),
          eventBytes,
          serializedEvent
        }));
      }
      this.events.push(event);
      this.serializedEvents.push(serializedEvent);
      this.serializedEventBytes.push(eventBytes);
      this.queuedEventBytes += eventBytes;
    } finally {
      // Report evictions only after admission so drop callbacks cannot refill the freed room.
      for (const evictedEvent of evicted) {
        this.#recordDroppedEvent(evictedEvent, "evicted_for_fatal");
      }
    }
    this.#scheduleAutomaticDelivery();
    return EVENT_ADMISSIONS.admitted;
  }

  #overflowReason(count, bytes) {
    if (count >= this.maxQueueSize) {
      return "queue_overflow";
    }
    return bytes > this.maxQueueBytes ? "queue_bytes_overflow" : undefined;
  }

  // Evicts the oldest non-fatal events outside the unacknowledged batch, only when that makes room.
  #evictForFatal(eventBytes) {
    if (this.eventStore && typeof this.eventStore.remove !== "function") {
      return [];
    }
    const indexes = [];
    let count = this.events.length;
    let bytes = this.queuedEventBytes + eventBytes;
    for (
      let index = this.unacknowledgedBatch?.eventsCount ?? 0;
      index < this.events.length && this.#overflowReason(count, bytes);
      index += 1
    ) {
      if (!isFatalEvent(this.events[index])) {
        indexes.push(index);
        count -= 1;
        bytes -= this.serializedEventBytes[index];
      }
    }
    if (this.#overflowReason(count, bytes)) {
      return [];
    }
    if (this.eventStore) {
      requireSynchronousStoreResult("remove", this.eventStore.remove(indexes));
    }
    const evicted = indexes.map((index) => this.events[index]);
    for (let position = indexes.length - 1; position >= 0; position -= 1) {
      const index = indexes[position];
      this.events.splice(index, 1);
      this.serializedEvents.splice(index, 1);
      this.queuedEventBytes -= this.serializedEventBytes.splice(index, 1)[0];
    }
    return evicted;
  }

  #recordDroppedEvent(event, reason) {
    this.droppedEventCount = incrementBounded(this.droppedEventCount);
    this.droppedEventsByReason[reason] = incrementBounded(this.droppedEventsByReason[reason]);
    const firstOfReason = this.unreportedDropsByReason[reason] === undefined;
    this.unreportedDropsByReason[reason] = Math.min(MAX_CLIENT_REPORT_COUNT, (this.unreportedDropsByReason[reason] ?? 0) + 1);
    this.#saveClientReport(firstOfReason);
    this.lastDropReason = reason;
    this.lastDroppedAtUnixMs = nextBoundedTimestamp(this.lastDroppedAtUnixMs);
    if (!this.onEventDropped) {
      return;
    }
    try {
      this.onEventDropped({
        droppedEvents: this.droppedEventCount,
        eventId: event.id,
        eventType: event.type,
        reason
      });
    } catch {
      // Drop callbacks are advisory and must not interrupt application logging.
    }
  }

  #runSerialized(operation) {
    this.pendingOperations = incrementBounded(this.pendingOperations);
    const result = this.operationTail.then(operation).finally(() => {
      this.pendingOperations = Math.max(0, this.pendingOperations - 1);
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #resolveTransport(transport) {
    const resolved = transport ?? this.transport;
    if (resolved === undefined) {
      throw new SdkError("validation_error", "flush and shutdown require transport");
    }
    validateTransport(resolved);
    return resolved;
  }

  async #flushWithHealth(transport) {
    this.deliveryInFlight = true;
    try {
      const response = await this.#flushSnapshot(transport);
      this.successfulFlushCount = incrementBounded(this.successfulFlushCount);
      this.lastDeliveryOutcome = response.batches === 0 ? "empty" : "accepted";
      return response;
    } catch (error) {
      this.failedFlushCount = incrementBounded(this.failedFlushCount);
      this.lastDeliveryOutcome = "failed";
      throw error;
    } finally {
      this.deliveryInFlight = false;
    }
  }

  #scheduleAutomaticDelivery() {
    if (!this.automaticDelivery || this.closed || this.closing || this.events.length === 0 || this.automaticPauseReason !== "none") {
      return;
    }
    if (this.automaticFlushActive) {
      this.automaticFlushPending = true;
      return;
    }
    if (this.retryDelayMs > 0) {
      this.#armAutomaticDeliveryTimer(this.retryDelayMs);
      return;
    }
    if (this.events.length >= this.deliveryQueueThreshold) {
      this.#requestAutomaticFlush();
      return;
    }
    this.#armAutomaticDeliveryTimer();
  }

  #armAutomaticDeliveryTimer(delayMs = this.deliveryIntervalMs) {
    if (!this.automaticDelivery || this.closed || this.closing || this.events.length === 0 || this.automaticPauseReason !== "none") {
      return;
    }
    if (this.deliveryTimer !== undefined) {
      return;
    }
    const timer = setTimeout(() => {
      if (this.deliveryTimer !== timer) {
        return;
      }
      this.deliveryTimer = undefined;
      this.retryDelayMs = 0;
      this.#requestAutomaticFlush();
    }, delayMs);
    this.deliveryTimer = timer;
    if (timer && typeof timer === "object" && typeof timer.unref === "function") {
      timer.unref();
    }
  }

  #clearDeliveryTimer() {
    if (this.deliveryTimer === undefined) {
      return;
    }
    globalThis.clearTimeout(this.deliveryTimer);
    this.deliveryTimer = undefined;
  }

  #requestAutomaticFlush() {
    if (!this.automaticDelivery || this.closed || this.closing || this.events.length === 0 || this.automaticPauseReason !== "none") {
      return;
    }
    this.#clearDeliveryTimer();
    if (this.automaticFlushActive) {
      this.automaticFlushPending = true;
      return;
    }
    this.automaticFlushActive = true;
    void Promise.resolve().then(() => this.#runAutomaticFlush());
  }

  async #runAutomaticFlush() {
    if (this.closed || this.closing) {
      this.automaticFlushActive = false;
      this.automaticFlushPending = false;
      return;
    }
    let succeeded = false;
    try {
      await this.#runSerialized(() => this.#flushWithHealth(this.transport));
      this.#recordAutomaticSuccess();
      succeeded = true;
    } catch (error) {
      this.#recordAutomaticFailure(error);
    } finally {
      this.automaticFlushActive = false;
      if (this.closed || this.closing) {
        this.automaticFlushPending = false;
      } else {
        const drainCoalesced = succeeded && this.automaticFlushPending && this.events.length > 0;
        this.automaticFlushPending = false;
        if (drainCoalesced) {
          this.#requestAutomaticFlush();
        } else if (!succeeded) {
          this.#resumeAutomaticDelivery();
        } else {
          this.#scheduleAutomaticDelivery();
        }
      }
    }
  }

  async #flushSnapshot(transport) {
    this.#synchronizeEventStore();
    let remainingEvents = this.events.length;
    if (remainingEvents === 0) {
      return { statusCode: 204, attempts: 0, batches: 0 };
    }

    let attempts = 0;
    let batches = 0;
    let statusCode = 204;
    while (remainingEvents > 0) {
      // Eviction for a fatal event can shrink the snapshot while a batch is in flight.
      this.unacknowledgedBatch ??= Object.freeze(
        this.#nextBatch(Math.min(remainingEvents, this.events.length, this.maxBatchEvents))
      );
      const batch = this.unacknowledgedBatch;
      const response = await this.#sendBatch(transport, batch.body);
      this.unacknowledgedBatch = undefined;
      // Drops recorded while this body was in flight stay pending under a new report ID.
      if (batch.carriesClientReport) {
        this.pendingClientReport = undefined;
        this.#saveClientReport(true);
      }
      this.#acknowledge(batch.eventsCount);
      this.acceptedBatchCount = incrementBounded(this.acceptedBatchCount);
      remainingEvents -= batch.eventsCount;
      attempts += response.attempts;
      batches += 1;
      statusCode = response.statusCode;
    }

    return { statusCode, attempts, batches };
  }

  #synchronizeEventStore() {
    if (!this.eventStore) {
      return;
    }
    const recovered = loadStoredEvents(this);
    if (!isOrderedSubsequence(this.serializedEvents, recovered.serializedEvents)) {
      throw new SdkError("persistence_error", "event store lost a queued record");
    }
    this.events = recovered.events;
    this.serializedEvents = recovered.serializedEvents;
    this.serializedEventBytes = recovered.serializedEventBytes;
    this.queuedEventBytes = recovered.queuedEventBytes;
  }

  #nextBatch(maxEvents) {
    const report = this.#pendingClientReport();
    const reportSuffix = report && `],"client_report":${JSON.stringify(report)}}`;
    const reportedEvents = reportSuffix ? this.#batchEventCount(maxEvents, utf8ByteLength(reportSuffix)) : 0;
    const eventsCount = reportedEvents || this.#batchEventCount(maxEvents, this.batchSuffixBytes);
    if (eventsCount === 0) {
      throw new SdkError("transport_error", "queued event cannot fit the configured batch byte limit");
    }
    return {
      body: `${this.batchPrefix}${this.serializedEvents.slice(0, eventsCount).join(",")}${reportedEvents ? reportSuffix : this.batchSuffix}`,
      carriesClientReport: reportedEvents > 0,
      eventsCount
    };
  }

  // Freezes unreported drops under one stable ID, so every resend of them is counted once.
  #pendingClientReport() {
    if (this.pendingClientReport === undefined) {
      const reported = Object.entries(this.unreportedDropsByReason).filter(([, count]) => count > 0);
      if (reported.length === 0) {
        return undefined;
      }
      const droppedEvents = Object.fromEntries(reported.slice(0, MAX_CLIENT_REPORT_REASONS));
      for (const reason of Object.keys(droppedEvents)) {
        delete this.unreportedDropsByReason[reason];
      }
      this.pendingClientReport = Object.freeze({ report_id: randomHex(16), dropped_events: droppedEvents });
      this.#saveClientReport(true);
    }
    return this.pendingClientReport;
  }

  // Saves at once for a new report or reason, and at most once a second during a drop burst.
  #saveClientReport(immediately) {
    const now = Date.now();
    if (!this.clientReportStore || (!immediately && now - this.clientReportSavedAtMs < CLIENT_REPORT_SAVE_INTERVAL_MS)) {
      return;
    }
    this.clientReportSavedAtMs = now;
    try {
      requireSynchronousStoreResult("saveClientReport", this.clientReportStore.saveClientReport({
        pending: this.pendingClientReport ?? null,
        unreported: { ...this.unreportedDropsByReason }
      }));
    } catch {
      // Drop counts are advisory: a failed save keeps them in memory and never blocks capture.
    }
  }

  #batchEventCount(maxEvents, suffixBytes) {
    let bodyBytes = this.batchPrefixBytes + suffixBytes;
    let eventsCount = 0;
    const eventIds = new Set();
    for (let index = 0; index < maxEvents; index += 1) {
      if (eventIds.has(this.events[index].id)) {
        break;
      }
      const separatorBytes = eventsCount === 0 ? 0 : 1;
      const nextBodyBytes = bodyBytes + separatorBytes + this.serializedEventBytes[index];
      if (nextBodyBytes > this.maxBatchBytes) {
        break;
      }
      eventIds.add(this.events[index].id);
      bodyBytes = nextBodyBytes;
      eventsCount += 1;
    }
    return eventsCount;
  }

  #acknowledge(eventsCount) {
    if (this.eventStore) {
      requireSynchronousStoreResult("acknowledge", this.eventStore.acknowledge(eventsCount));
    }
    let acknowledgedBytes = 0;
    for (let index = 0; index < eventsCount; index += 1) {
      acknowledgedBytes += this.serializedEventBytes[index];
    }
    this.events.splice(0, eventsCount);
    this.serializedEvents.splice(0, eventsCount);
    this.serializedEventBytes.splice(0, eventsCount);
    this.queuedEventBytes -= acknowledgedBytes;
    this.acceptedEventCount = addBounded(this.acceptedEventCount, eventsCount);
    this.lastAcceptedAtUnixMs = nextBoundedTimestamp(Math.max(
      this.lastAcceptedAtUnixMs,
      this.lastAttemptAtUnixMs
    ));
  }

  #recordAutomaticSuccess() {
    this.automaticPauseReason = "none";
    this.consecutiveDeliveryFailures = 0;
    this.retryDelayMs = 0;
  }

  #recordAutomaticFailure(error) {
    this.consecutiveDeliveryFailures = incrementBounded(this.consecutiveDeliveryFailures);
    this.retryDelayMs = 0;
    if (error instanceof SdkError && error.code === "unauthenticated") {
      this.automaticPauseReason = "authentication";
      return;
    }
    if (error instanceof SdkError && error.code === "rate_limited") {
      if (error.retryable === true) {
        this.automaticPauseReason = "none";
        this.retryDelayMs = rateLimitWaitMs(
          error.retryAfterMs ?? automaticRetryDelayMs(this.deliveryIntervalMs, this.consecutiveDeliveryFailures)
        );
        return;
      }
      this.automaticPauseReason = "rate_limit";
      return;
    }
    if (error instanceof SdkError && error.retryable === true) {
      this.automaticPauseReason = "none";
      this.retryDelayMs = automaticRetryDelayMs(this.deliveryIntervalMs, this.consecutiveDeliveryFailures);
      return;
    }
    this.automaticPauseReason = "non_retryable";
  }

  #resumeAutomaticDelivery() {
    if (this.automaticPauseReason !== "none") {
      return;
    }
    if (this.retryDelayMs > 0) {
      this.#armAutomaticDeliveryTimer(this.retryDelayMs);
      return;
    }
    this.#scheduleAutomaticDelivery();
  }

  async #sendBatch(transport, body) {
    const maxAttempts = this.maxRetries + 1;
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts += 1;
      this.deliveryAttemptCount = incrementBounded(this.deliveryAttemptCount);
      this.lastAttemptAtUnixMs = nextBoundedTimestamp(this.lastAttemptAtUnixMs);
      this.lastStatusClass = "transport_error";
      try {
        const response = await transport.send(this.apiKey, body);
        if (
          !response
          || Array.isArray(response)
          || typeof response !== "object"
          || !Number.isSafeInteger(response.statusCode)
          || response.statusCode < 100
          || response.statusCode > 599
        ) {
          this.lastStatusClass = "invalid_response";
          throw new SdkError("transport_error", "invalid transport response");
        }
        this.lastStatusClass = statusClass(response.statusCode);
        if (response.statusCode === 401) {
          throw new SdkError("unauthenticated", "transport rejected the API key");
        }
        if (response.statusCode === 429) {
          throw new SdkError("rate_limited", "transport rate limited the batch", {
            retryAfterMs: response.retryAfterMs,
            retryable: response.errorCode !== "usage_limit_exceeded"
              && (retryAfterMsOrUndefined(response.retryAfterMs) !== undefined || response.errorCode === "rate_limited")
          });
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          return { statusCode: response.statusCode, attempts };
        }
        const retryableStatus = response.statusCode === 408 || response.statusCode >= 500;
        if (retryableStatus && attempts < maxAttempts) {
          continue;
        }
        throw new SdkError("transport_error", `unexpected transport status ${response.statusCode}`, {
          retryable: retryableStatus
        });
      } catch (error) {
        if (error instanceof SdkError) {
          throw error;
        }
        if (error instanceof TransportError && error.retryable && attempts < maxAttempts) {
          this.lastStatusClass = "network_error";
          continue;
        }
        if (error instanceof TransportError) {
          this.lastStatusClass = "network_error";
          throw new SdkError(error.code, error.message, { retryable: error.retryable });
        }
        throw error;
      }
    }

    throw new SdkError("transport_error", "exhausted retries");
  }
}

function automaticRetryDelayMs(deliveryIntervalMs, consecutiveFailures) {
  const exponent = Math.min(consecutiveFailures - 1, 30);
  const maximumDelay = Math.min(MAX_DELIVERY_INTERVAL_MS, deliveryIntervalMs * (2 ** exponent));
  const minimumDelay = Math.ceil(maximumDelay / 2);
  return minimumDelay + Math.floor(Math.random() * (maximumDelay - minimumDelay + 1));
}

function rateLimitWaitMs(delayMs) {
  const bounded = Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(MIN_RATE_LIMIT_WAIT_MS, delayMs));
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, bounded + Math.floor(Math.random() * (Math.floor(bounded / 10) + 1)));
}

function statusClass(statusCode) {
  if (statusCode >= 200 && statusCode < 300) {
    return "success";
  }
  if (statusCode >= 400 && statusCode < 500) {
    return "client_error";
  }
  if (statusCode >= 500) {
    return "server_error";
  }
  return "other_status";
}

function nextBoundedTimestamp(previous) {
  const now = Date.now();
  if (!Number.isFinite(now)) {
    return previous;
  }
  const bounded = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(now)));
  return Math.max(previous, bounded);
}

function addBounded(current, increment) {
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// Fatal input severity is stored as critical; a critical issue is a crash report.
function isFatalEvent(event) {
  return event.type === "issue" && event.attributes.level === "critical";
}

// Report IDs only need uniqueness, so runtimes without Web Crypto fall back to Math.random.
function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isClientReportStore(store) {
  return typeof store?.loadClientReport === "function" && typeof store.saveClientReport === "function";
}

// Restores saved drop counts; anything unreadable or out of bounds is ignored, never fatal.
function loadClientReport(store) {
  let state;
  try {
    state = store ? requireSynchronousStoreResult("loadClientReport", store.loadClientReport()) : undefined;
  } catch {
    state = undefined;
  }
  const pending = state?.pending;
  const pendingCounts = validClientReportCounts(pending?.dropped_events);
  return {
    pending: CLIENT_REPORT_ID_PATTERN.test(pending?.report_id ?? "") && Object.keys(pendingCounts).length > 0
      ? Object.freeze({ report_id: pending.report_id, dropped_events: pendingCounts })
      : undefined,
    unreported: validClientReportCounts(state?.unreported)
  };
}

function validClientReportCounts(counts) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    return {};
  }
  return Object.fromEntries(Object.entries(counts).filter(([reason, count]) => (
    CLIENT_REPORT_REASON_PATTERN.test(reason) && Number.isSafeInteger(count) && count >= 1 && count <= MAX_CLIENT_REPORT_COUNT
  )).slice(0, MAX_CLIENT_REPORT_REASONS));
}

function incrementBounded(value) {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function validateTransport(transport) {
  if (transport === undefined) {
    return;
  }
  if (!transport || Array.isArray(transport) || typeof transport !== "object" || typeof transport.send !== "function") {
    throw new SdkError("validation_error", "transport.send must be a function");
  }
}

function validateEventStore(eventStore) {
  if (eventStore === undefined) {
    return;
  }
  if (!eventStore || Array.isArray(eventStore) || typeof eventStore !== "object") {
    throw new SdkError("validation_error", "eventStore must be an object");
  }
  for (const method of ["load", "append", "acknowledge", "purge", "close"]) {
    if (typeof eventStore[method] !== "function") {
      throw new SdkError("validation_error", `eventStore.${method} must be a function`);
    }
  }
}

function createEventStoreFromQueueFactory(eventQueueFactory, config) {
  const queue = eventQueueFactory({
    ...config,
    restoreEvent: restoreStoredEvent
  });
  validateEventQueue(queue);
  const eventStore = {
    load() {
      const events = queue.events();
      const count = queue.length();
      if (!Array.isArray(events) || events.length !== count) {
        throw invalidStoredRecord();
      }
      return events.map((event, index) => ({
        event,
        eventBytes: queue.eventBytesAt(index),
        serializedEvent: queue.serializedAt(index)
      }));
    },
    append(record) {
      return queue.append({
        event: record.event,
        byteCount: record.eventBytes,
        serialized: record.serializedEvent
      });
    },
    acknowledge(count) {
      return queue.acknowledge(count);
    },
    purge() {
      return queue.acknowledge(queue.length());
    },
    close() {
      return queue.close();
    }
  };
  if (typeof queue.remove === "function") {
    eventStore.remove = (indexes) => queue.remove(indexes);
  }
  if (isClientReportStore(queue)) {
    eventStore.loadClientReport = () => queue.loadClientReport();
    eventStore.saveClientReport = (state) => queue.saveClientReport(state);
  }
  return eventStore;
}

function validateEventQueue(queue) {
  const methods = [
    "acknowledge",
    "append",
    "byteCount",
    "close",
    "eventBytesAt",
    "events",
    "length",
    "serializedAt"
  ];
  if (!queue || Array.isArray(queue) || typeof queue !== "object" || methods.some((method) => typeof queue[method] !== "function")) {
    throw new SdkError("validation_error", "event queue factory returned an invalid queue");
  }
}

function restoreStoredEvent(serializedEvent) {
  if (typeof serializedEvent !== "string" || serializedEvent === "") {
    throw invalidStoredRecord();
  }
  let event;
  try {
    event = JSON.parse(serializedEvent);
  } catch {
    throw invalidStoredRecord();
  }
  return normalizeStoredRecord({
    event,
    eventBytes: utf8ByteLength(serializedEvent),
    serializedEvent
  }).event;
}

function requireSynchronousStoreResult(operation, result) {
  if (result && typeof result.then === "function") {
    throw new SdkError("persistence_error", `eventStore.${operation} must complete synchronously`);
  }
  return result;
}

function loadStoredEvents({
  batchPrefixBytes,
  batchSuffixBytes,
  eventStore,
  maxBatchBytes,
  maxQueueBytes,
  maxQueueSize
}) {
  if (!eventStore) {
    return {
      events: [],
      queuedEventBytes: 0,
      serializedEventBytes: [],
      serializedEvents: []
    };
  }

  const records = requireSynchronousStoreResult("load", eventStore.load());
  if (!Array.isArray(records)) {
    throw invalidStoredRecord();
  }
  if (records.length > maxQueueSize) {
    throw new SdkError("persistence_error", "recovered event count exceeds maxQueueSize");
  }

  const events = [];
  const serializedEvents = [];
  const serializedEventBytes = [];
  let queuedEventBytes = 0;
  for (const record of records) {
    const normalized = normalizeStoredRecord(record);
    if (batchPrefixBytes + normalized.eventBytes + batchSuffixBytes > maxBatchBytes) {
      throw new SdkError("persistence_error", "recovered event exceeds maxBatchBytes");
    }
    queuedEventBytes += normalized.eventBytes;
    if (queuedEventBytes > maxQueueBytes) {
      throw new SdkError("persistence_error", "recovered event bytes exceed maxQueueBytes");
    }
    events.push(normalized.event);
    serializedEvents.push(normalized.serializedEvent);
    serializedEventBytes.push(normalized.eventBytes);
  }
  return { events, queuedEventBytes, serializedEventBytes, serializedEvents };
}

function isOrderedSubsequence(expected, actual) {
  let index = 0;
  for (const value of actual) {
    index += value === expected[index] ? 1 : 0;
  }
  return index === expected.length;
}

function structuralJson(value) {
  return JSON.stringify(value, (_, entry) => entry && !Array.isArray(entry) && typeof entry === "object"
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry);
}

function normalizeStoredRecord(record) {
  try {
    if (!record || Array.isArray(record) || typeof record !== "object") {
      throw invalidStoredRecord();
    }
    const { event, eventBytes, serializedEvent } = record;
    if (!event || Array.isArray(event) || typeof event !== "object") {
      throw invalidStoredRecord();
    }
    const validator = EVENT_VALIDATORS.get(event.type);
    if (!validator || !Number.isSafeInteger(eventBytes) || eventBytes <= 0 || typeof serializedEvent !== "string") {
      throw invalidStoredRecord();
    }
    requireNonEmpty("event id", event.id);
    requireTimestamp(event.timestamp);
    if (!event.attributes || Array.isArray(event.attributes) || typeof event.attributes !== "object") {
      throw invalidStoredRecord();
    }
    if (JSON.stringify(event) !== serializedEvent || utf8ByteLength(serializedEvent) !== eventBytes) {
      throw invalidStoredRecord();
    }
    const recoveredAttributes = event.type === "issue" && event.attributes.level === "fatal"
      ? { ...event.attributes, level: "critical" }
      : event.attributes;
    const context = recoveredAttributes.context;
    const recoveredEvent = context && !Array.isArray(context) && typeof context === "object"
      && context.schemaVersion === undefined
      ? { ...event, attributes: { ...recoveredAttributes, context: { schemaVersion: 1, ...context } } }
      : { ...event, attributes: recoveredAttributes };
    const normalizedEvent = {
      type: recoveredEvent.type,
      id: recoveredEvent.id,
      timestamp: recoveredEvent.timestamp,
      attributes: validator(recoveredEvent.attributes)
    };
    const normalizedSerializedEvent = JSON.stringify(normalizedEvent);
    if (structuralJson(normalizedEvent) !== structuralJson(recoveredEvent)) {
      throw invalidStoredRecord();
    }
    return {
      event: cloneEvent(normalizedEvent),
      eventBytes: utf8ByteLength(normalizedSerializedEvent),
      serializedEvent: normalizedSerializedEvent
    };
  } catch (error) {
    if (error instanceof SdkError && error.code === "persistence_error") {
      throw error;
    }
    throw invalidStoredRecord();
  }
}

function invalidStoredRecord() {
  return new SdkError("persistence_error", "event store returned an invalid record");
}


module.exports = { LogBrewClient };
