"use strict";

const { SdkError } = require("@logbrew/sdk");
const { indexRuntime, isCallable, readField } = require("./instrumentation-values.cjs");

/**
 * @import { LogBrewClient, Metadata, SpanAttributes } from "@logbrew/sdk"
 * @import { ReactNativeSpanEvent } from "./index.cjs"
 * @import { AppStateInput, PlatformInput, TraceInput } from "./instrumentation-values.cjs"
 * @import { LifecycleListenerOptions } from "./instrumentation-runtime.cjs"
 */

/**
 * @typedef {{ readonly fromState: string | undefined, readonly screen: string | undefined, readonly toState: string | undefined }} LifecycleIdContext
 * @typedef {{
 *   readonly appState?: AppStateInput | undefined,
 *   readonly durationMs?: number | undefined,
 *   readonly fromState?: unknown,
 *   readonly id?: string | undefined,
 *   readonly idFactory?: ((context: LifecycleIdContext) => string) | undefined,
 *   readonly metadata?: Readonly<Metadata> | undefined,
 *   readonly name?: string | undefined,
 *   readonly now?: (() => string) | undefined,
 *   readonly platform?: PlatformInput | undefined,
 *   readonly screen?: string | undefined,
 *   readonly sessionId?: string | undefined,
 *   readonly state?: unknown,
 *   readonly status?: SpanAttributes["status"] | undefined,
 *   readonly timestamp?: string | undefined,
 *   readonly toState?: unknown,
 *   readonly trace?: TraceInput | undefined
 * }} LifecycleSpanInput
 * @typedef {{
 *   readonly appState: AppStateInput,
 *   readonly client: LogBrewClient,
 *   readonly options: Readonly<{ metadata: Readonly<Metadata>, now: () => string, nowMs: () => number }> & LifecycleListenerOptions
 * }} LifecycleContext
 * @typedef {{ readonly changedAtMs: number, readonly state: string | undefined }} LifecycleMoment
 */

const MIN_DURATION_MS = 0;

function defaultLifecycleSpanEventId() {
  return `evt_native_lifecycle_${indexRuntime.createReactNativeTraceContext().traceId}`;
}

/**
 * @param {unknown} state
 * @returns {string | undefined}
 */
function normalizeLifecycleState(state) {
  return typeof state === "string" && state.trim() !== "" ? state.trim() : undefined;
}

/**
 * @param {LifecycleSpanInput} [input]
 * @returns {ReactNativeSpanEvent}
 */
function createReactNativeLifecycleSpanEvent({
  durationMs, fromState, id, idFactory = defaultLifecycleSpanEventId, metadata = {}, name,
  now = () => new Date().toISOString(), platform, appState, screen, sessionId, state, status = "ok",
  timestamp, toState, trace
} = {}) {
  const safeFromState = normalizeLifecycleState(fromState);
  const safeToState = normalizeLifecycleState(toState ?? state);
  const transition = [safeFromState, safeToState].filter(knownState => knownState !== undefined).join("->");
  const spanName = name ?? `app_state:${transition === "" ? "change" : transition}`;
  const activeTrace = trace ?? indexRuntime.getActiveLogBrewTrace() ?? indexRuntime.createReactNativeTraceContext();
  const eventId = id ?? idFactory({ fromState: safeFromState, screen, toState: safeToState });
  const eventTimestamp = timestamp ?? now();
  const attributes = indexRuntime.createReactNativeSpanAttributes({
    durationMs,
    metadata: {
      ...indexRuntime.getReactNativeContext({ appState, platform }),
      source: "react-native.lifecycle",

      appState: safeToState,
      durationMs,
      fromAppState: safeFromState,
      screen,
      sessionId,
      toAppState: safeToState,
      ...metadata
    },
    name: spanName,
    status,
    trace: activeTrace
  });
  return {
    id: eventId,
    timestamp: eventTimestamp,

    attributes
  };
}

/**
 * @param {LogBrewClient | null | undefined} client
 * @returns {asserts client is LogBrewClient}
 */
function requireClient(client) {
  if (!client) {
    throw new SdkError("configuration_error", "LogBrew React Native lifecycle helpers require a client");
  }
}

/**
 * @param {LogBrewClient | null | undefined} client
 * @param {LifecycleSpanInput} [input]
 * @returns {ReactNativeSpanEvent}
 */
function captureReactNativeLifecycleSpan(client, input = {}) {
  requireClient(client);
  const event = createReactNativeLifecycleSpanEvent(input);
  client.span(event.id, event.timestamp, event.attributes);
  return event;
}

/**
 * @param {unknown} subscription
 * @returns {() => unknown}
 */
function subscriptionRemover(subscription) {
  if (isCallable(subscription)) {
    return subscription;
  }
  if (isCallable(readField(subscription, "remove"))) {
    return () => {
      const remove = readField(subscription, "remove");
      if (!isCallable(remove)) {
        throw new TypeError("subscription.remove is not a function");
      }
      return Reflect.apply(remove, subscription, []);
    };
  }
  return () => undefined;
}

/**
 * @param {LifecycleContext} context
 * @param {LifecycleMoment} previous
 * @param {LifecycleMoment} next
 * @returns {LifecycleSpanInput}
 */
function lifecycleChangeInput({ appState, options }, previous, next) {
  return {
    appState,
    durationMs: previous.state === undefined ? undefined : Math.max(MIN_DURATION_MS, next.changedAtMs - previous.changedAtMs),
    fromState: previous.state,
    metadata: options.metadata,
    now: options.now,
    platform: options.platform,
    screen: options.screen,
    sessionId: options.sessionId,
    timestamp: options.now(),
    toState: next.state,
    trace: options.trace
  };
}

/**
 * @param {((error: unknown) => void) | undefined} onError
 * @param {unknown} error
 * @returns {void}
 */
function reportLifecycleError(onError, error) {
  if (typeof onError === "function") {
    onError(error);
  } else {
    throw error;
  }
}

/**
 * @param {LifecycleContext} context
 * @param {LifecycleMoment} initial
 * @returns {(nextState: string) => void}
 */
function lifecycleChangeListener(context, initial) {
  let previous = initial;
  return (nextState) => {
    try {
      const safeNextState = normalizeLifecycleState(nextState);
      if (safeNextState === undefined) {
        return;
      }
      const next = { changedAtMs: context.options.nowMs(), state: safeNextState };
      captureReactNativeLifecycleSpan(context.client, lifecycleChangeInput(context, previous, next));
      previous = next;
    } catch (error) {
      reportLifecycleError(context.options.onError, error);
    }
  };
}

/**
 * @param {LogBrewClient | null | undefined} client
 * @param {AppStateInput | null | undefined} appState
 * @param {LifecycleListenerOptions} [options]
 * @returns {() => unknown}
 */
function createAppStateLifecycleSpanListener(client, appState, {
  captureInitialState = false, metadata = {}, now = () => new Date().toISOString(), nowMs = () => Date.now(),
  onError, platform, screen, sessionId, trace
} = {}) {
  requireClient(client);
  if (!appState || typeof appState.addEventListener !== "function") {
    throw new SdkError("configuration_error", "createAppStateLifecycleSpanListener requires AppState.addEventListener");
  }
  const options = { metadata, now, nowMs, onError, platform, screen, sessionId, trace };
  const state = normalizeLifecycleState(appState.currentState);
  const initial = { changedAtMs: nowMs(), state };
  if (captureInitialState && state !== undefined) {
    captureReactNativeLifecycleSpan(client, {
      appState, metadata, now, platform, screen, sessionId, toState: state, trace
    });
  }
  return subscriptionRemover(appState.addEventListener("change", lifecycleChangeListener({ appState, client, options }, initial)));
}

module.exports = {
  captureReactNativeLifecycleSpan,
  createAppStateLifecycleSpanListener,
  createReactNativeLifecycleSpanEvent
};
