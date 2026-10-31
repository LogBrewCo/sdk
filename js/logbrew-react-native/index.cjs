const { LogBrewClient, SdkError } = require("@logbrew/sdk");
const { createReactNativeErrorEvent, captureReactNativeError } = require("./index-errors.cjs");
const {
  captureAppStateChange,
  captureReactNativeAction,
  captureReactNativeNetwork,
  captureScreenView,
  createAppStateListener,
  createReactNativeActionEvent,
  createReactNativeNetworkEvent
} = require("./index-events.cjs");
const { createReactNavigationSpanListener } = require("./index-navigation.cjs");
const { LogBrewNativeProvider, useLogBrewNative, useLogBrewNativeActions } = require("./index-react.cjs");
const {
  captureReactNativeNavigationSpan,
  captureReactNativeResourceSpan,
  createReactNativeNavigationSpanEvent,
  createReactNativeResourceSpanEvent
} = require("./index-spans.cjs");
const { createTraceparentFetch, shouldPropagateTraceparent } = require("./index-trace-fetch.cjs");
const {
  bindLogBrewTrace,
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  createReactNativeTraceHeaders,
  createReactNativeTraceparent,
  getActiveLogBrewTrace,
  getReactNativeTraceMetadata,
  withLogBrewTrace
} = require("./index-trace.cjs");
const { createReactNativeFetchTransport } = require("./index-transport.cjs");
const { getReactNativeContext } = require("./index-values.cjs");

/**
 * @import { CreateLogBrewReactNativeClientConfig } from "./index.cjs"
 */

const DEFAULT_SDK_NAME = "logbrew-react-native";
const DEFAULT_SDK_VERSION = "0.1.39";
const DEFAULT_REACT_NATIVE_DELIVERY_INTERVAL_MS = 5000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * @param {string | undefined} key
 * @returns {key is string}
 */
function isPresentKey(key) {
  return key !== undefined && Boolean(key);
}

/**
 * @param {CreateLogBrewReactNativeClientConfig} options
 * @returns {LogBrewClient}
 */
function createLogBrewReactNativeClient({
  automaticDelivery,
  apiKey,
  clientKey,
  context,
  deliveryIntervalMs,
  deliveryQueueThreshold,
  eventStore,
  maxBatchBytes,
  maxBatchEvents,
  maxQueueBytes,
  maxQueueSize,
  onEventDropped,
  sdkName = DEFAULT_SDK_NAME,
  sdkVersion = DEFAULT_SDK_VERSION,
  maxRetries = DEFAULT_MAX_RETRIES,
  transport
}) {
  const authKey = clientKey ?? apiKey;
  if (!isPresentKey(authKey)) {
    throw new SdkError("configuration_error", "createLogBrewReactNativeClient requires clientKey or apiKey");
  }
  return LogBrewClient.create({
    apiKey: authKey,
    deliveryIntervalMs: deliveryIntervalMs ?? DEFAULT_REACT_NATIVE_DELIVERY_INTERVAL_MS,
    maxRetries,
    sdkName,
    sdkVersion,
    ...(automaticDelivery === undefined ? {} : { automaticDelivery }),
    ...(context === undefined ? {} : { context }),
    ...(deliveryQueueThreshold === undefined ? {} : { deliveryQueueThreshold }),
    ...(eventStore === undefined ? {} : { eventStore }),
    ...(maxBatchBytes === undefined ? {} : { maxBatchBytes }),
    ...(maxBatchEvents === undefined ? {} : { maxBatchEvents }),
    ...(maxQueueBytes === undefined ? {} : { maxQueueBytes }),
    ...(maxQueueSize === undefined ? {} : { maxQueueSize }),
    ...(onEventDropped === undefined ? {} : { onEventDropped }),
    ...(transport === undefined ? {} : { transport })
  });
}

const defaultExport = {
  LogBrewNativeProvider,
  captureAppStateChange,
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNetwork,

  captureReactNativeNavigationSpan,
  captureReactNativeResourceSpan,
  captureScreenView,

  bindLogBrewTrace,
  createAppStateListener,
  createLogBrewReactNativeClient,
  createReactNavigationSpanListener,

  createReactNativeFetchTransport,
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  createReactNativeTraceHeaders,

  createReactNativeActionEvent,
  createReactNativeErrorEvent,
  createReactNativeNetworkEvent,

  createReactNativeNavigationSpanEvent,
  createReactNativeResourceSpanEvent,
  createReactNativeTraceparent,
  createTraceparentFetch,
  getActiveLogBrewTrace,
  getReactNativeContext,
  getReactNativeTraceMetadata,
  shouldPropagateTraceparent,
  useLogBrewNative,
  useLogBrewNativeActions,
  withLogBrewTrace
};

module.exports = { ...defaultExport, default: defaultExport };
