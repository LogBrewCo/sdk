const React = require("react");
const { SdkError } = require("@logbrew/sdk");
const { NULL_VALUE } = require("./null-value.cjs");
const { captureReactNativeError } = require("./index-errors.cjs");
const {
  captureAppStateChange,
  captureReactNativeAction,
  captureReactNativeNetwork,
  captureScreenView
} = require("./index-events.cjs");
const { captureReactNativeNavigationSpan, captureReactNativeResourceSpan } = require("./index-spans.cjs");
const { getActiveLogBrewTrace, getReactNativeTraceMetadata, resolveTraceContext } = require("./index-trace.cjs");
const { compactMetadata, readField, requireClient } = require("./index-values.cjs");

/**
 * @import { ReactNode } from "react"
 * @import { ActionEvent, ActionInput, CaptureAppStateChangeOptions, CaptureScreenViewOptions, NetworkInput } from "./index-events.cjs"
 * @import { ErrorEvent, ErrorEventOptions } from "./index-errors.cjs"
 * @import { NavigationSpanInput, ResourceSpanInput, SpanEvent } from "./index-spans.cjs"
 * @import { AppStateLike, ClientEventMethod, ClientLike, LooseRecord, PlatformLike, TraceContext } from "./index-values.cjs"
 * @typedef {{
 *   readonly client: ClientLike,
 *   readonly platform: PlatformLike | null | undefined,
 *   readonly appState: AppStateLike | null | undefined,
 *   readonly trace: TraceContext | undefined
 * }} NativeContextValue
 * @typedef {{
 *   readonly client: ClientLike,
 *   readonly platform?: PlatformLike | null | undefined,
 *   readonly appState?: AppStateLike | null | undefined,
 *   readonly trace?: unknown,
 *   readonly children?: ReactNode
 * }} ProviderProps
 * @typedef {{
 *   readonly release: ClientEventMethod,
 *   readonly environment: ClientEventMethod,
 *   readonly issue: ClientEventMethod,
 *   readonly log: ClientEventMethod,
 *   readonly span: ClientEventMethod,
 *   readonly action: ClientEventMethod,
 *   readonly flush: () => Promise<unknown>,
 *   readonly shutdown: () => Promise<unknown>,
 *   readonly deliveryHealth: () => unknown,
 *   readonly droppedEvents: () => unknown,
 *   readonly pendingBytes: () => unknown,
 *   readonly previewJson: () => unknown,
 *   readonly pendingEvents: () => unknown,
 *   readonly trace: TraceContext | undefined,
 *   readonly captureScreenView: (screenName: unknown, options?: CaptureScreenViewOptions) => void,
 *   readonly captureAppStateChange: (state: unknown, options?: CaptureAppStateChangeOptions) => void,
 *   readonly captureReactNativeAction: (input?: ActionInput) => ActionEvent,
 *   readonly captureReactNativeNetwork: (input?: NetworkInput) => ActionEvent,
 *   readonly captureReactNativeNavigationSpan: (input?: NavigationSpanInput) => SpanEvent,
 *   readonly captureReactNativeResourceSpan: (input?: ResourceSpanInput) => SpanEvent,
 *   readonly captureReactNativeError: (error: unknown, options?: ErrorEventOptions) => ErrorEvent
 * }} NativeActions
 */

/**
 * @returns {NativeContextValue | null}
 */
function emptyNativeContext() {
  return NULL_VALUE;
}

const LogBrewNativeContext = React.createContext(emptyNativeContext());

/**
 * @param {unknown} value
 * @returns {value is NativeContextValue}
 */
function hasNativeClient(value) {
  return Boolean(readField(value, "client"));
}

/**
 * @param {unknown} value
 * @returns {object | undefined}
 */
function metadataSource(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function" ? value : undefined;
}

/**
 * @param {LooseRecord} attributes
 * @param {TraceContext | undefined} trace
 * @returns {LooseRecord}
 */
function attributesWithTrace(attributes, trace) {
  const context = resolveTraceContext(trace) ?? getActiveLogBrewTrace();
  if (!context) {
    return attributes;
  }
  return {
    ...attributes,
    metadata: compactMetadata({
      ...metadataSource(readField(attributes, "metadata")),
      ...getReactNativeTraceMetadata(context)
    })
  };
}

/**
 * @template {object} T
 * @param {NativeContextValue} context
 * @param {T} options
 * @returns {T & Omit<NativeContextValue, "client">}
 */
function scoped({ platform, appState, trace }, options) {
  return {
    platform,

    appState,
    trace,
    ...options
  };
}

/**
 * @param {ProviderProps} props
 * @returns {ReactNode}
 */
function LogBrewNativeProvider({ client, platform, appState, trace, children }) {
  requireClient(client);
  const value = React.useMemo(() => ({
    client,
    platform,

    appState,
    trace: resolveTraceContext(trace)
  }), [appState, client, platform, trace]);
  return React.createElement(LogBrewNativeContext.Provider, { value }, children);
}

/**
 * @returns {NativeContextValue}
 */
function useLogBrewNative() {
  const value = React.useContext(LogBrewNativeContext);
  if (!hasNativeClient(value)) {
    throw new SdkError("configuration_error", "useLogBrewNative must be used inside LogBrewNativeProvider");
  }
  return value;
}

/**
 * @returns {NativeActions}
 */
function useLogBrewNativeActions() {
  const context = useLogBrewNative();
  const { client, trace } = context;
  return {
    release: client.release.bind(client),

    environment: client.environment.bind(client),
    issue: (id, timestamp, attributes) => client.issue(id, timestamp, attributesWithTrace(attributes, trace)),
    log: (id, timestamp, attributes) => client.log(id, timestamp, attributesWithTrace(attributes, trace)),
    span: client.span.bind(client),

    action: (id, timestamp, attributes) => client.action(id, timestamp, attributesWithTrace(attributes, trace)),
    flush: client.flush.bind(client),
    shutdown: client.shutdown.bind(client),

    deliveryHealth: client.deliveryHealth.bind(client),
    droppedEvents: client.droppedEvents.bind(client),
    pendingBytes: client.pendingBytes.bind(client),
    previewJson: client.previewJson.bind(client),

    pendingEvents: client.pendingEvents.bind(client),
    trace,

    captureScreenView: (screenName, options = {}) => {
      captureScreenView(client, screenName, scoped(context, options));
    },

    captureAppStateChange: (state, options = {}) => {
      captureAppStateChange(client, state, scoped(context, options));
    },
    captureReactNativeAction: (input = {}) => captureReactNativeAction(client, scoped(context, input)),
    captureReactNativeNetwork: (input = {}) => captureReactNativeNetwork(client, scoped(context, input)),

    captureReactNativeNavigationSpan: (input = {}) => captureReactNativeNavigationSpan(client, scoped(context, input)),
    captureReactNativeResourceSpan: (input = {}) => captureReactNativeResourceSpan(client, scoped(context, input)),

    captureReactNativeError: (error, options = {}) => captureReactNativeError(client, error, scoped(context, options))
  };
}

module.exports = { LogBrewNativeProvider, useLogBrewNative, useLogBrewNativeActions };
