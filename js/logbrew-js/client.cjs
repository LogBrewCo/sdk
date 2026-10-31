const { AutomaticDelivery } = require("./automatic-delivery.cjs");
const { clientConfig, publicSettings, validateTransport } = require("./client-options.cjs");
const { deliveryHealthSnapshot, lifecycleOf } = require("./delivery-health.cjs");
const { propertyOf } = require("./error-details.cjs");
const { EVENT_ADMISSIONS, EventPipeline } = require("./event-pipeline.cjs");
const { validateAction, validateEnvironment, validateIssue, validateLog, validateRelease } = require("./event-validation.cjs");
const { MAX_ISSUE_BREADCRUMBS, validateIssueBreadcrumb } = require("./issue-diagnostics.cjs");
const { validateMetric } = require("./metric-validation.cjs");
const { providedBreadcrumbs, withIssueBreadcrumbs } = require("./provided-breadcrumbs.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { validateSpan } = require("./span-validation.cjs");
const { requireSynchronousStoreResult } = require("./stored-events.cjs");
const { mergeTelemetryContexts } = require("./telemetry-context.cjs");
const { isCallable, requireNonEmpty, requireTimestamp } = require("./validation.cjs");

/**
 * @import { Callable, DeepReadonly } from "./validation.cjs"
 * @import { BatchTransport } from "./batch-sender.cjs"
 * @import { ClientConfig, ClientOptions } from "./client-options.cjs"
 * @import { EventAdmission, FlushResult } from "./event-pipeline.cjs"
 * @import { EventAttributes, EventType } from "./event-validation.cjs"
 * @import { IssueBreadcrumb, TelemetryContext } from "./index.cjs"
 * @typedef {Readonly<Record<string, unknown>>} Attributes
 * @typedef {Readonly<{ type: EventType, id: unknown, timestamp: unknown }>} EventHead
 * @typedef {Readonly<{ controls: boolean, transport: BatchTransport }>} FlushPlan
 */

const NO_EVENTS = 0;
const NO_OPERATIONS = 0;

class LogBrewClient {
  /** @readonly */
  static #issueCapture = propertyOf(LogBrewClient.prototype, "issue");

  apiKey = "";

  automaticDelivery = false;

  /** @type {Callable | undefined} */
  eventFilter;

  /** @type {Callable | undefined} */
  onEventDropped;

  /** @type {TelemetryContext | undefined} */
  context;

  /** @type {Callable | undefined} */
  contextProvider;

  /** @type {Callable | undefined} */
  breadcrumbProvider;

  /** @type {BatchTransport | undefined} */
  transport;

  closing = false;

  closed = false;

  /** @type {IssueBreadcrumb[]} */
  issueBreadcrumbs = [];

  issueBreadcrumbsTruncated = false;

  /**
   * @readonly
   * @type {InstanceType<typeof EventPipeline>}
   */
  #pipeline;

  /**
   * @readonly
   * @type {InstanceType<typeof AutomaticDelivery>}
   */
  #delivery;

  /**
   * @param {ClientOptions} options
   * @returns {LogBrewClient}
   */
  static create(options) {
    return new LogBrewClient(clientConfig(options));
  }

  /**
   * @param {ClientConfig} config
   */
  constructor(config) {
    Object.assign(this, publicSettings(config));
    this.#pipeline = new EventPipeline({
      ...config,
      apiKey: () => this.apiKey,
      hooks: { eventFilter: () => this.eventFilter, onEventDropped: () => this.onEventDropped, receiver: this }
    });
    this.#delivery = new AutomaticDelivery({
      canDeliver: () => this.automaticDelivery && !this.closed && !this.closing && this.#pipeline.queue.events.length > NO_EVENTS,
      deliveryIntervalMs: config.deliveryIntervalMs,
      deliveryQueueThreshold: config.deliveryQueueThreshold,
      flush: async () => this.#pipeline.flushWithHealth(this.#automaticTransport()),
      isOpen: () => !this.closed && !this.closing,
      queueLength: () => this.#pipeline.queue.events.length,
      serialize: async (operation) => this.#pipeline.runSerialized(operation)
    });
    this.#delivery.schedule();
  }

  /**
   * @returns {number}
   */
  pendingEvents() {
    return this.#pipeline.queue.events.length;
  }

  /**
   * @returns {number}
   */
  pendingBytes() {
    return this.#pipeline.queue.queuedEventBytes;
  }

  /**
   * @returns {number}
   */
  droppedEvents() {
    return this.#pipeline.ledger.droppedEventCount;
  }

  /**
   * @returns {Readonly<Record<string, unknown>>}
   */
  deliveryHealth() {
    return deliveryHealthSnapshot({
      ...this.#pipeline.health(),
      ...this.#delivery.health(),
      automaticDelivery: this.automaticDelivery,
      lifecycle: lifecycleOf(this.closed, this.closing)
    });
  }

  /**
   * @returns {string}
   */
  previewJson() {
    return this.#pipeline.queue.previewJson();
  }

  /**
   * @returns {number}
   */
  purgePendingEvents() {
    this.#requireOpen();
    if (this.#pipeline.pendingOperations > NO_OPERATIONS || this.#delivery.automaticFlushActive) {
      throw new SdkError("persistence_error", "cannot purge while a delivery operation is active");
    }
    const purgedEvents = this.#pipeline.queue.purge();
    this.#delivery.clearTimer();
    this.#delivery.automaticFlushPending = false;
    return purgedEvents;
  }

  /**
   * @param {unknown} breadcrumb
   * @param {unknown} [timestamp]
   * @returns {void}
   */
  addBreadcrumb(breadcrumb, timestamp = new Date().toISOString()) {
    this.#requireOpen();
    const validated = validateIssueBreadcrumb(breadcrumb, timestamp);
    if (this.issueBreadcrumbs.length === MAX_ISSUE_BREADCRUMBS) {
      this.issueBreadcrumbs.shift();
      this.issueBreadcrumbsTruncated = true;
    }
    this.issueBreadcrumbs.push(validated);
  }

  /**
   * @returns {number}
   */
  clearBreadcrumbs() {
    const cleared = this.issueBreadcrumbs.length;
    this.issueBreadcrumbs.splice(NO_EVENTS, cleared);
    this.issueBreadcrumbsTruncated = false;
    return cleared;
  }

  /**
   * @param {unknown} id
   * @param {unknown} timestamp
   * @param {Attributes} attributes
   * @returns {void}
   */
  release(id, timestamp, attributes) {
    this.#admit({ id, timestamp, type: "release" }, validateRelease(attributes));
  }

  /**
   * @param {unknown} id
   * @param {unknown} timestamp
   * @param {Attributes} attributes
   * @returns {void}
   */
  environment(id, timestamp, attributes) {
    this.#admit({ id, timestamp, type: "environment" }, validateEnvironment(attributes));
  }

  /**
   * @param {unknown} id
   * @param {unknown} timestamp
   * @param {Attributes} attributes
   * @returns {void}
   */
  issue(id, timestamp, attributes) {
    this.#pushIssue({ id, timestamp, type: "issue" }, attributes);
  }

  /**
   * @param {unknown} id
   * @param {unknown} timestamp
   * @param {Attributes} attributes
   * @returns {EventAdmission}
   */
  issueWithAdmission(id, timestamp, attributes) {
    const issue = propertyOf(this, "issue");
    if (issue !== LogBrewClient.#issueCapture) {
      if (!isCallable(issue)) {
        throw new TypeError("issue is not a function");
      }
      Reflect.apply(issue, this, [id, timestamp, attributes]);
      return EVENT_ADMISSIONS.unavailable;
    }
    return this.#pushIssue({ id, timestamp, type: "issue" }, attributes);
  }

  /**
   * @param {unknown} id
   * @param {unknown} timestamp
   * @param {Attributes} attributes
   * @returns {void}
   */
  log(id, timestamp, attributes) {
    this.#admit({ id, timestamp, type: "log" }, validateLog(attributes));
  }

  /**
   * @param {unknown} id
   * @param {unknown} timestamp
   * @param {Attributes} attributes
   * @returns {void}
   */
  span(id, timestamp, attributes) {
    this.#admit({ id, timestamp, type: "span" }, validateSpan(attributes));
  }

  /**
   * @param {unknown} id
   * @param {unknown} timestamp
   * @param {Attributes} attributes
   * @returns {void}
   */
  action(id, timestamp, attributes) {
    this.#admit({ id, timestamp, type: "action" }, validateAction(attributes));
  }

  /**
   * @param {unknown} id
   * @param {unknown} timestamp
   * @param {Attributes} attributes
   * @returns {void}
   */
  metric(id, timestamp, attributes) {
    this.#admit({ id, timestamp, type: "metric" }, validateMetric(attributes));
  }

  /**
   * @param {unknown} [transport]
   * @returns {Promise<FlushResult>}
   */
  async flush(transport) {
    const plan = this.#planFlush(transport);
    return this.#pipeline.runSerialized(async () => {
      this.#delivery.clearTimer();
      try {
        const response = await this.#pipeline.flushWithHealth(plan.transport);
        this.#recordControlledSuccess(plan.controls);
        return response;
      } catch (error) {
        if (plan.controls) {
          this.#delivery.recordFailure(error);
        }
        throw error;
      } finally {
        if (this.automaticDelivery && !this.closed && !this.closing) {
          this.#delivery.resume();
        }
      }
    });
  }

  /**
   * @param {unknown} [transport]
   * @returns {Promise<FlushResult>}
   */
  async shutdown(transport) {
    const plan = this.#planFlush(transport);
    this.#delivery.automaticFlushPending = false;
    this.closing = true;
    try {
      const response = await this.#pipeline.runSerialized(this.#pipeline.flushWithHealth.bind(this.#pipeline, plan.transport));
      this.#finishShutdown(plan.controls);
      return response;
    } catch (error) {
      this.#abortShutdown(error, plan.controls);
      throw error;
    }
  }

  /**
   * @param {boolean} controls
   * @returns {void}
   */
  #recordControlledSuccess(controls) {
    if (controls) {
      this.#delivery.recordSuccess();
    }
  }

  /**
   * @param {boolean} controls
   * @returns {void}
   */
  #finishShutdown(controls) {
    this.#recordControlledSuccess(controls);
    this.#pipeline.ledger.save(true);
    const { eventStore } = this.#pipeline.queue;
    try {
      if (eventStore !== undefined) {
        requireSynchronousStoreResult("close", eventStore.close());
      }
    } finally {
      this.closed = true;
    }
  }

  /**
   * @param {unknown} reason
   * @param {boolean} controls
   * @returns {void}
   */
  #abortShutdown(reason, controls) {
    if (this.closed) {
      return;
    }
    this.closing = false;
    if (controls) {
      this.#delivery.recordFailure(reason);
    }
    this.#delivery.resume();
  }

  /**
   * @param {unknown} transport
   * @returns {FlushPlan}
   */
  #planFlush(transport) {
    this.#requireOpen();
    const validated = validateTransport(transport ?? this.transport);
    if (validated === undefined) {
      throw new SdkError("validation_error", "flush and shutdown require transport");
    }
    const controls = this.automaticDelivery && validated === this.transport;
    this.#delivery.clearTimer();
    return { controls, transport: validated };
  }

  /**
   * @returns {BatchTransport}
   */
  #automaticTransport() {
    if (this.transport === undefined) {
      throw new SdkError("validation_error", "flush and shutdown require transport");
    }
    return this.transport;
  }

  /**
   * @returns {void}
   */
  #requireOpen() {
    if (this.closed) {
      throw new SdkError("shutdown_error", "client is already shut down");
    }
    if (this.closing) {
      throw new SdkError("shutdown_error", "client is shutting down");
    }
  }

  /**
   * @param {EventHead} head
   * @param {Attributes} attributes
   * @returns {EventAdmission}
   */
  #pushIssue(head, attributes) {
    if (attributes["breadcrumbs"] !== undefined) {
      return this.#admit(head, validateIssue(attributes));
    }
    const provided = providedBreadcrumbs(this.breadcrumbProvider, this);
    const local = { breadcrumbs: this.issueBreadcrumbs, truncated: this.issueBreadcrumbsTruncated };
    return this.#admit(head, validateIssue(withIssueBreadcrumbs(attributes, local, provided)));
  }

  /**
   * @returns {TelemetryContext | undefined}
   */
  #providedContext() {
    const provider = this.contextProvider;
    return mergeTelemetryContexts(this.context, isCallable(provider) ? Reflect.apply(provider, this, []) : undefined);
  }

  /**
   * @param {EventHead} head
   * @param {DeepReadonly<EventAttributes>} attributes
   * @returns {EventAdmission}
   */
  #admit(head, attributes) {
    this.#requireOpen();
    const id = requireNonEmpty("event id", head.id);
    const timestamp = requireTimestamp(head.timestamp);
    const context = mergeTelemetryContexts(this.#providedContext(), attributes.context);
    const event = {
      type: head.type,

      id,

      timestamp,

      attributes: context === undefined ? attributes : { ...attributes, context }
    };
    const admission = this.#pipeline.admit(event);
    if (admission === EVENT_ADMISSIONS.admitted) {
      this.#delivery.schedule();
    }
    return admission;
  }
}

module.exports = { LogBrewClient };
