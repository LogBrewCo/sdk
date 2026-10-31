"use strict";

const { LogBrewClient, SdkError } = require("@logbrew/sdk");
const { attempt, callMethod, isTruthy, readMember, readOptionalMember } = require("./internal.cjs");
const { addEnvironmentResourceContext, addNodeRuntimeContext } = require("./runtime-context.cjs");
const { createBreadcrumbProvider, installAutomaticBreadcrumbs } = require("./breadcrumbs.cjs");
const { buildNodePersistentEventStore } = require("./persistent-event-store.cjs");
const { createPersistentEventQueue, purgePersistentEventQueue } = require("./persistent-queue.cjs");
const {
  createLogBrewQueueTraceHeaders: createQueueTraceHeaders,
  createLogBrewQueueTraceLinks
} = require("./trace-context.cjs");
const {
  activeTraceTelemetryContext,
  createLogBrewTraceContext,
  enterWithLogBrewTrace,
  getActiveLogBrewTrace,
  runWithLogBrewTrace,
  setLogBrewUser
} = require("./active-trace.cjs");
const { defaultFetch, fetchWithLogBrewSpan } = require("./fetch-span.cjs");
const { installLogBrewFetchInstrumentation } = require("./fetch-instrumentation.cjs");
const { axiosRequestWithLogBrewSpan } = require("./axios-span.cjs");
const { instrumentLogBrewAxiosInstance } = require("./axios-instrumentation.cjs");
const { installLogBrewHttpClientInstrumentation } = require("./http-client-instrumentation.cjs");
const {
  cacheOperationWithLogBrewSpan,
  databaseOperationWithLogBrewSpan,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
} = require("./operation-span.cjs");
const { createHttpErrorEvent, createHttpRequestEvent } = require("./http-events.cjs");
const { captureHttpError, createHttpHandler, createLogBrewNodeContext } = require("./http-handler.cjs");
const {
  addLogBrewBreadcrumb,
  installLogBrewPinoInstrumentation,
  installLogBrewProcessErrorCapture,
  installLogBrewUndiciInstrumentation,
  instrumentLogBrewMongoCollection,
  instrumentLogBrewMongooseModel,
  instrumentLogBrewPgClient,
  instrumentLogBrewRedisClient
} = require("./integrations.cjs");
const { flushOnExit } = require("./exit-flush.cjs");
const { abortableFetch, createFetchTransport } = require("./node-transport.cjs");

/**
 * @import { TelemetryContext, Transport } from "@logbrew/sdk"
 * @import { CreateLogBrewNodeClientConfig, LogBrewNodeOptions, LogBrewTraceContext } from "./index.cjs"
 * @import { PersistentQueueConfig } from "./persistent-storage.cjs"
 */

/**
 * @typedef {Readonly<{
 *   maxBatchBytes: number,
 *   maxBatchEvents: number,
 *   maxQueueBytes: number,
 *   maxQueueSize: number
 * }>} ClientLimits
 * @typedef {Readonly<{
 *   maxBatchBytes: number | undefined,
 *   maxBatchEvents: number | undefined,
 *   maxQueueBytes: number | undefined,
 *   maxQueueSize: number | undefined
 * }>} ClientLimitInput
 * @typedef {{
 *   authKey: string,
 *   automaticDelivery: boolean | undefined,
 *   breadcrumbs: boolean,
 *   captureRuntimeContext: boolean,
 *   context: TelemetryContext | undefined,
 *   deliveryIntervalMs: number | undefined,
 *   deliveryQueueThreshold: number | undefined,
 *   endpoint: string | undefined,
 *   fetchImpl: unknown,
 *   headers: Readonly<Record<string, string>> | undefined,
 *   limits: ClientLimits,
 *   maxRetries: number,
 *   onEventDropped: CreateLogBrewNodeClientConfig["onEventDropped"],
 *   persistentQueue: CreateLogBrewNodeClientConfig["persistentQueue"],
 *   persistentQueuePath: string | undefined,
 *   sdkName: string,
 *   sdkVersion: string,
 *   transport: Transport | undefined
 * }} NodeClientSettings
 * @typedef {Readonly<{
 *   endpoint?: unknown,
 *   fetchImpl?: unknown,
 *   headers?: Readonly<Record<string, string>> | undefined
 * }>} NodeFetchTransportInput
 */

const DEFAULT_ENDPOINT = "https://api.logbrew.co/v1/events";
const BYTES_PER_KIB = 1024;
const QUEUE_MIB = 4;
const BATCH_KIB = 256;
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_QUEUE_BYTES = QUEUE_MIB * BYTES_PER_KIB * BYTES_PER_KIB;
const DEFAULT_MAX_BATCH_EVENTS = 100;
const DEFAULT_MAX_BATCH_BYTES = BATCH_KIB * BYTES_PER_KIB;
const DEFAULT_MAX_RETRIES = 2;
const EVENT_QUEUE_FACTORY = Symbol.for("@logbrew/sdk.eventQueueFactory");
const CONTEXT_PROVIDER = Symbol.for("@logbrew/sdk.contextProvider");
const BREADCRUMB_PROVIDER = Symbol.for("@logbrew/sdk.breadcrumbProvider");
const breadcrumbProvider = createBreadcrumbProvider(getActiveLogBrewTrace);

/**
 * @param {string} name
 * @returns {string | undefined}
 */
function readEnvKey(name) {
  const value = readOptionalMember(readOptionalMember(readMember(globalThis, "process"), "env"), name);
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {NodeFetchTransportInput} [config]
 * @returns {Transport}
 */
function createNodeFetchTransport({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = defaultFetch(),
  headers = {}
} = {}) {
  return createFetchTransport({ endpoint, fetchImpl, headers });
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isBoolean(value) {
  return typeof value === "boolean";
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainConfig(value) {
  return isTruthy(value) && !Array.isArray(value) && typeof value === "object";
}

/**
 * @param {unknown} persistentQueue
 * @param {unknown} persistentQueuePath
 * @returns {void}
 */
function validatePersistentQueue(persistentQueue, persistentQueuePath) {
  if (persistentQueue !== undefined && persistentQueuePath !== undefined) {
    throw new SdkError("configuration_error", "persistentQueue and persistentQueuePath are mutually exclusive");
  }
  if (persistentQueue !== undefined && !isPlainConfig(persistentQueue)) {
    throw new SdkError("configuration_error", "persistentQueue must be an object");
  }
}

/**
 * @param {Readonly<{ breadcrumbs: unknown, captureRuntimeContext: unknown, persistentQueue: unknown, persistentQueuePath: unknown }>} config
 * @param {string | undefined} authKey
 * @returns {string}
 */
function validateClientConfig({ breadcrumbs, captureRuntimeContext, persistentQueue, persistentQueuePath }, authKey) {
  if (!isTruthy(authKey) || authKey === undefined) {
    throw new SdkError(
      "configuration_error",
      "createLogBrewNodeClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
    );
  }
  if (!isBoolean(captureRuntimeContext)) {
    throw new SdkError("configuration_error", "captureRuntimeContext must be a boolean");
  }
  if (!isBoolean(breadcrumbs)) {
    throw new SdkError("configuration_error", "breadcrumbs must be a boolean");
  }
  validatePersistentQueue(persistentQueue, persistentQueuePath);
  return authKey;
}

/**
 * @param {ClientLimitInput} limits
 * @returns {ClientLimits}
 */
function clientLimits({ maxBatchBytes, maxBatchEvents, maxQueueBytes, maxQueueSize }) {
  return {
    maxBatchBytes: maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES,
    maxBatchEvents: maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS,
    maxQueueBytes: maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES,
    maxQueueSize: maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
  };
}

/**
 * @param {NodeClientSettings} settings
 * @returns {ReturnType<typeof buildNodePersistentEventStore> | undefined}
 */
function buildEventStore({ limits, persistentQueue, sdkName }) {
  if (persistentQueue === undefined) {
    return undefined;
  }
  return buildNodePersistentEventStore({
    SdkError,
    directory: persistentQueue.directory,
    encryptionKey: persistentQueue.encryptionKey,
    limits,
    onWarning: persistentQueue.onWarning,
    sdkName
  });
}

/**
 * @param {string | undefined} persistentQueuePath
 * @returns {Readonly<Record<symbol, unknown>>}
 */
function eventQueueFactory(persistentQueuePath) {
  if (persistentQueuePath === undefined) {
    return {};
  }
  /**
   * @param {Omit<PersistentQueueConfig, "persistentQueuePath">} queueConfig
   * @returns {ReturnType<typeof createPersistentEventQueue>}
   */
  function createQueue(queueConfig) {
    return createPersistentEventQueue({ ...queueConfig, persistentQueuePath });
  }
  return { [EVENT_QUEUE_FACTORY]: createQueue };
}

/**
 * @param {Readonly<Record<PropertyKey, unknown>>} config
 * @returns {LogBrewClient}
 */
function createSdkClient(config) {
  const client = callMethod(LogBrewClient, "create", [config]);
  if (!(client instanceof LogBrewClient)) {
    throw new TypeError("LogBrewClient.create must return a LogBrewClient");
  }
  return client;
}

/**
 * @param {NodeClientSettings} settings
 * @param {Readonly<{ eventStore: unknown, transport: Transport }>} owned
 * @returns {LogBrewClient}
 */
function createOwnedClient(settings, { eventStore, transport }) {
  const environmentContext = addEnvironmentResourceContext(settings.context);
  return createSdkClient({
    apiKey: settings.authKey,
    automaticDelivery: settings.automaticDelivery,
    context: settings.captureRuntimeContext ? addNodeRuntimeContext(environmentContext) : environmentContext,
    deliveryIntervalMs: settings.deliveryIntervalMs,
    deliveryQueueThreshold: settings.deliveryQueueThreshold,
    eventStore,

    [CONTEXT_PROVIDER]: activeTraceTelemetryContext,

    [BREADCRUMB_PROVIDER]: breadcrumbProvider,
    ...eventQueueFactory(settings.persistentQueuePath),
    sdkName: settings.sdkName,

    sdkVersion: settings.sdkVersion,

    maxRetries: settings.maxRetries,
    transport,
    ...settings.limits,
    ...(settings.onEventDropped === undefined ? {} : { onEventDropped: settings.onEventDropped })
  });
}

/**
 * @param {NodeClientSettings} settings
 * @returns {Readonly<{ exitAbort: AbortController | undefined, transport: Transport }>}
 */
function prepareDelivery(settings) {
  const exitAbort = settings.transport === undefined ? new AbortController() : undefined;
  const transport = settings.transport ?? createNodeFetchTransport({
    endpoint: settings.endpoint,
    fetchImpl: abortableFetch(settings.fetchImpl ?? defaultFetch(), exitAbort),
    headers: settings.headers
  });
  if (settings.breadcrumbs) {
    installAutomaticBreadcrumbs(getActiveLogBrewTrace);
  }
  return { exitAbort, transport };
}

/**
 * @param {NodeClientSettings} settings
 * @returns {LogBrewClient}
 */
function buildClient(settings) {
  const eventStore = buildEventStore(settings);
  const { exitAbort, transport } = prepareDelivery(settings);
  try {
    const client = createOwnedClient(settings, { eventStore, transport });
    if (isTruthy(readMember(client, "automaticDelivery"))) {
      flushOnExit(client, exitAbort === undefined ? undefined : () => {
        exitAbort.abort();
      });
    }
    return client;
  } catch (error) {
    attempt(() => eventStore?.close());
    throw error;
  }
}

/**
 * @param {CreateLogBrewNodeClientConfig} [config]
 * @returns {LogBrewClient}
 */
function createLogBrewNodeClient({
  serverApiKey,
  apiKey,
  automaticDelivery,
  breadcrumbs = true,
  captureRuntimeContext = true,
  context,
  deliveryIntervalMs,
  deliveryQueueThreshold,
  endpoint,
  fetchImpl,
  headers,
  sdkName = "logbrew-node",
  sdkVersion = "0.1.23",
  maxBatchBytes,
  maxBatchEvents,
  maxRetries = DEFAULT_MAX_RETRIES,
  maxQueueBytes,
  maxQueueSize,
  onEventDropped,
  persistentQueue,
  persistentQueuePath,
  transport
} = {}) {
  const authKey = validateClientConfig(
    { breadcrumbs, captureRuntimeContext, persistentQueue, persistentQueuePath },
    serverApiKey ?? apiKey ?? readEnvKey("LOGBREW_SERVER_API_KEY") ?? readEnvKey("LOGBREW_API_KEY")
  );
  const limits = clientLimits({ maxBatchBytes, maxBatchEvents, maxQueueBytes, maxQueueSize });
  return buildClient({
    authKey, automaticDelivery, breadcrumbs, captureRuntimeContext, context, deliveryIntervalMs, deliveryQueueThreshold, endpoint, fetchImpl, headers,
    limits, maxRetries, onEventDropped, persistentQueue, persistentQueuePath, sdkName, sdkVersion, transport
  });
}

/**
 * @param {Readonly<{ persistentQueuePath?: unknown }>} [options]
 * @returns {boolean}
 */
function purgeLogBrewNodePersistentQueue({ persistentQueuePath } = {}) {
  return purgePersistentEventQueue({ persistentQueuePath });
}

/**
 * @param {unknown} handler
 * @param {LogBrewNodeOptions} [options]
 * @returns {ReturnType<typeof createHttpHandler>}
 */
function withLogBrewHttpHandler(handler, options = {}) {
  return createHttpHandler(handler, options, createLogBrewNodeClient);
}

/**
 * @param {LogBrewTraceContext} [trace]
 * @returns {unknown}
 */
function createLogBrewQueueTraceHeaders(trace = getActiveLogBrewTrace()) {
  return createQueueTraceHeaders(trace);
}

const exported = {
  addLogBrewBreadcrumb,
  axiosRequestWithLogBrewSpan,
  cacheOperationWithLogBrewSpan,
  captureHttpError,
  createNodeFetchTransport,

  createHttpErrorEvent,
  createHttpRequestEvent,
  createLogBrewNodeClient,
  createLogBrewNodeContext,
  createLogBrewTraceContext,

  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  databaseOperationWithLogBrewSpan,
  fetchWithLogBrewSpan,

  enterWithLogBrewTrace,
  getActiveLogBrewTrace,
  installLogBrewFetchInstrumentation,
  installLogBrewHttpClientInstrumentation,
  installLogBrewPinoInstrumentation,
  installLogBrewProcessErrorCapture,
  installLogBrewUndiciInstrumentation,
  instrumentLogBrewAxiosInstance,
  instrumentLogBrewMongoCollection,
  instrumentLogBrewMongooseModel,
  instrumentLogBrewPgClient,
  instrumentLogBrewRedisClient,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan,

  purgeLogBrewNodePersistentQueue,
  runWithLogBrewTrace,
  setLogBrewUser,
  withLogBrewHttpHandler
};

module.exports = { ...exported, default: exported };
