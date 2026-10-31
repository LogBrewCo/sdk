const { isClientReportStore, validateEventStore } = require("./event-store.cjs");
const { MAX_DELIVERY_INTERVAL_MS } = require("./retry-delay.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { cloneTelemetryContext, validateTelemetryContext } = require("./telemetry-context.cjs");
const { isCallable, isRecord, requireNonEmpty, requireNonNegativeInteger, requirePositiveInteger } = require("./validation.cjs");

/**
 * @import { Callable, DeepReadonly } from "./validation.cjs"
 * @import { BatchTransport } from "./batch-sender.cjs"
 * @import { ClientReportStore, EventStore } from "./event-store.cjs"
 * @import { TelemetryContext } from "./index.cjs"
 * @typedef {Readonly<Record<PropertyKey, unknown>>} ClientOptions
 * @typedef {Readonly<{
 *   apiKey: string,
 *   automaticDelivery: boolean,
 *   deliveryIntervalMs: number,
 *   deliveryQueueThreshold: number,
 *   eventStore: EventStore | undefined,
 *   eventQueueFactory: Callable | undefined,
 *   clientReportStore: ClientReportStore | undefined,
 *   eventFilter: Callable | undefined,
 *   maxBatchBytes: number,
 *   maxBatchEvents: number,
 *   maxQueueBytes: number,
 *   maxQueueSize: number,
 *   onEventDropped: Callable | undefined,
 *   context: DeepReadonly<TelemetryContext> | undefined,
 *   contextProvider: Callable | undefined,
 *   breadcrumbProvider: Callable | undefined,
 *   sdk: Readonly<{ name: string, language: string, version: string }>,
 *   maxRetries: number,
 *   transport: BatchTransport | undefined
 * }>} ClientConfig
 * @typedef {Omit<ClientConfig, "clientReportStore" | "context" | "eventQueueFactory" | "eventStore"> & {
 *   context: TelemetryContext | undefined
 * }} ClientSettings
 */

const EVENT_QUEUE_FACTORY = Symbol.for("@logbrew/sdk.eventQueueFactory");
const CLIENT_REPORT_STORE = Symbol.for("@logbrew/sdk.clientReportStore");
const CONTEXT_PROVIDER = Symbol.for("@logbrew/sdk.contextProvider");
const BREADCRUMB_PROVIDER = Symbol.for("@logbrew/sdk.breadcrumbProvider");
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_QUEUE_BYTES = 4_194_304;
const DEFAULT_MAX_BATCH_EVENTS = 100;
const DEFAULT_MAX_BATCH_BYTES = 262_144;
const DEFAULT_DELIVERY_INTERVAL_MS = 1000;
const DEFAULT_DELIVERY_QUEUE_THRESHOLD = 50;

/**
 * @param {unknown} value
 * @param {string} message
 * @returns {Callable | undefined}
 */
function optionalFunction(value, message) {
  if (value === undefined) {
    return undefined;
  }
  if (!isCallable(value)) {
    throw new SdkError("validation_error", message);
  }
  return value;
}

/**
 * @param {unknown} maxQueueSize
 * @returns {number}
 */
function defaultDeliveryQueueThreshold(maxQueueSize) {
  if (typeof maxQueueSize === "bigint") {
    throw new TypeError("Cannot convert a BigInt value to a number");
  }
  return Math.min(DEFAULT_DELIVERY_QUEUE_THRESHOLD, Number(maxQueueSize));
}

/**
 * @param {unknown} transport
 * @returns {transport is BatchTransport}
 */
function isTransport(transport) {
  return isRecord(transport) && typeof transport["send"] === "function";
}

/**
 * @param {unknown} transport
 * @returns {BatchTransport | undefined}
 */
function validateTransport(transport) {
  if (transport === undefined) {
    return undefined;
  }
  if (!isTransport(transport)) {
    throw new SdkError("validation_error", "transport.send must be a function");
  }
  return transport;
}

/**
 * @param {ClientOptions} options
 * @returns {Pick<ClientConfig, "apiKey" | "context" | "contextProvider" | "breadcrumbProvider" | "sdk">}
 */
function validateIdentity(options) {
  const apiKey = requireNonEmpty("apiKey", options["apiKey"]);
  const name = requireNonEmpty("sdkName", options["sdkName"]);
  const version = requireNonEmpty("sdkVersion", options["sdkVersion"]);
  const context = validateTelemetryContext(options["context"], "client telemetry context");
  const contextProvider = optionalFunction(options["contextProvider"], "context provider must be a function");
  const breadcrumbProvider = optionalFunction(options["breadcrumbProvider"], "breadcrumb provider must be a function");
  return {
    apiKey,
    breadcrumbProvider,
    context,
    contextProvider,
    sdk: {
      name,

      language: "javascript",

      version
    }
  };
}

/**
 * @param {ClientOptions} options
 * @returns {Pick<ClientConfig, "maxRetries" | "eventFilter" | "maxQueueSize" | "maxQueueBytes" | "maxBatchEvents" | "maxBatchBytes" | "onEventDropped">}
 */
function validateLimits(options) {
  const maxRetries = requireNonNegativeInteger("maxRetries", options["maxRetries"]);
  const eventFilter = optionalFunction(options["eventFilter"], "eventFilter must be a function");
  const maxQueueSize = requirePositiveInteger("maxQueueSize", options["maxQueueSize"]);
  const maxQueueBytes = requirePositiveInteger("maxQueueBytes", options["maxQueueBytes"]);
  const maxBatchEvents = requirePositiveInteger("maxBatchEvents", options["maxBatchEvents"]);
  const maxBatchBytes = requirePositiveInteger("maxBatchBytes", options["maxBatchBytes"]);
  const onEventDropped = optionalFunction(options["onEventDropped"], "onEventDropped must be a function");
  return { eventFilter, maxBatchBytes, maxBatchEvents, maxQueueBytes, maxQueueSize, maxRetries, onEventDropped };
}

/**
 * @param {ClientOptions} options
 * @returns {Pick<ClientConfig, "eventStore" | "eventQueueFactory" | "clientReportStore">}
 */
function validateStorage(options) {
  const eventStore = validateEventStore(options["eventStore"]);
  const eventQueueFactory = optionalFunction(options["eventQueueFactory"], "event queue factory must be a function");
  if (eventStore !== undefined && eventQueueFactory !== undefined) {
    throw new SdkError("validation_error", "eventStore and event queue factory are mutually exclusive");
  }
  const { clientReportStore } = options;
  if (clientReportStore !== undefined && !isClientReportStore(clientReportStore)) {
    throw new SdkError("validation_error", "client report store must provide loadClientReport and saveClientReport");
  }
  return { clientReportStore, eventQueueFactory, eventStore };
}

/**
 * @param {ClientOptions} options
 * @returns {Pick<ClientConfig, "transport" | "automaticDelivery">}
 */
function validateAutomaticDelivery(options) {
  const transport = validateTransport(options["transport"]);
  const { automaticDelivery } = options;
  if (typeof automaticDelivery !== "boolean") {
    throw new SdkError("validation_error", "automaticDelivery must be a boolean");
  }
  if (automaticDelivery && transport === undefined) {
    throw new SdkError("validation_error", "automaticDelivery requires transport");
  }
  return { automaticDelivery, transport };
}

/**
 * @param {ClientOptions} options
 * @param {number} maxQueueSize
 * @returns {Pick<ClientConfig, "transport" | "automaticDelivery" | "deliveryIntervalMs" | "deliveryQueueThreshold">}
 */
function validateDelivery(options, maxQueueSize) {
  const automatic = validateAutomaticDelivery(options);
  const deliveryIntervalMs = requirePositiveInteger("deliveryIntervalMs", options["deliveryIntervalMs"]);
  if (deliveryIntervalMs > MAX_DELIVERY_INTERVAL_MS) {
    throw new SdkError("validation_error", `deliveryIntervalMs must be at most ${MAX_DELIVERY_INTERVAL_MS}`);
  }
  const deliveryQueueThreshold = requirePositiveInteger("deliveryQueueThreshold", options["deliveryQueueThreshold"]);
  if (deliveryQueueThreshold > maxQueueSize) {
    throw new SdkError("validation_error", "deliveryQueueThreshold must not exceed maxQueueSize");
  }
  return { ...automatic, deliveryIntervalMs, deliveryQueueThreshold };
}

/**
 * @param {ClientOptions} options
 * @returns {ClientConfig}
 */
function clientConfig({
  apiKey,
  sdkName,
  sdkVersion,
  context,
  [CONTEXT_PROVIDER]: contextProvider,
  [BREADCRUMB_PROVIDER]: breadcrumbProvider,
  maxRetries = DEFAULT_MAX_RETRIES,
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
  deliveryQueueThreshold = defaultDeliveryQueueThreshold(maxQueueSize)
}) {
  const options = {
    apiKey,
    automaticDelivery,
    breadcrumbProvider,
    clientReportStore,
    context,
    contextProvider,
    deliveryIntervalMs,
    deliveryQueueThreshold,
    eventFilter,
    eventQueueFactory,
    eventStore,
    maxBatchBytes,
    maxBatchEvents,
    maxQueueBytes,
    maxQueueSize,
    maxRetries,
    onEventDropped,
    sdkName,
    sdkVersion,
    transport
  };
  const identity = validateIdentity(options);
  const limits = validateLimits(options);
  return { ...identity, ...limits, ...validateStorage(options), ...validateDelivery(options, limits.maxQueueSize) };
}

/**
 * @param {ClientConfig} config
 * @returns {ClientSettings}
 */
function publicSettings(config) {
  return {
    apiKey: config.apiKey,

    automaticDelivery: config.automaticDelivery,

    deliveryIntervalMs: config.deliveryIntervalMs,

    deliveryQueueThreshold: config.deliveryQueueThreshold,

    eventFilter: config.eventFilter,

    maxBatchBytes: config.maxBatchBytes,

    maxBatchEvents: config.maxBatchEvents,

    maxQueueBytes: config.maxQueueBytes,

    maxQueueSize: config.maxQueueSize,

    onEventDropped: config.onEventDropped,

    context: cloneTelemetryContext(config.context),

    contextProvider: config.contextProvider,

    breadcrumbProvider: config.breadcrumbProvider,

    transport: config.transport,

    sdk: config.sdk,

    maxRetries: config.maxRetries
  };
}

module.exports = {
  BREADCRUMB_PROVIDER,
  CLIENT_REPORT_STORE,
  CONTEXT_PROVIDER,
  EVENT_QUEUE_FACTORY,
  clientConfig,
  publicSettings,
  validateTransport
};
