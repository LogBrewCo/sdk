"use strict";

const { SdkError } = require("@logbrew/sdk");
const {
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  getActiveLogBrewTrace,
  getReactNativeContext
} = require("./index.cjs");

function createReactNativeLifecycleSpanEvent({
  durationMs, fromState, id, idFactory = defaultLifecycleSpanEventId, metadata = {}, name,
  now = () => new Date().toISOString(), platform, appState, screen, sessionId, state, status = "ok",
  timestamp, toState, trace
} = {}) {
  const safeFromState = normalizeLifecycleState(fromState);
  const safeToState = normalizeLifecycleState(toState ?? state);
  const transition = [safeFromState, safeToState].filter(Boolean).join("->");
  const spanName = name ?? `app_state:${transition || safeToState || safeFromState || "change"}`;
  const activeTrace = trace ?? getActiveLogBrewTrace() ?? createReactNativeTraceContext();
  return {
    id: id ?? idFactory({ fromState: safeFromState, screen, toState: safeToState }),
    timestamp: timestamp ?? now(),
    attributes: createReactNativeSpanAttributes({
      name: spanName,
      status,
      durationMs,
      trace: activeTrace,
      metadata: {
        ...getReactNativeContext({ platform, appState }),
        source: "react-native.lifecycle",
        appState: safeToState,
        durationMs,
        fromAppState: safeFromState,
        screen,
        sessionId,
        toAppState: safeToState,
        ...metadata
      }
    })
  };
}

function captureReactNativeLifecycleSpan(client, input = {}) {
  requireClient(client);
  const event = createReactNativeLifecycleSpanEvent(input);
  client.span(event.id, event.timestamp, event.attributes);
  return event;
}

function createAppStateLifecycleSpanListener(client, appState, {
  captureInitialState = false, metadata = {}, now = () => new Date().toISOString(), nowMs = () => Date.now(),
  onError, platform, screen, sessionId, trace
} = {}) {
  requireClient(client);
  if (!appState || typeof appState.addEventListener !== "function") {
    throw new SdkError("configuration_error", "createAppStateLifecycleSpanListener requires AppState.addEventListener");
  }

  let previousState = normalizeLifecycleState(appState.currentState);
  let previousChangedAtMs = nowMs();
  if (captureInitialState && previousState !== undefined) {
    captureReactNativeLifecycleSpan(client, {
      appState, metadata, now, platform, screen, sessionId, toState: previousState, trace
    });
  }

  const subscription = appState.addEventListener("change", (nextState) => {
    try {
      const safeNextState = normalizeLifecycleState(nextState);
      if (safeNextState === undefined) {
        return;
      }
      const changedAtMs = nowMs();
      const durationMs = previousState === undefined ? undefined : Math.max(0, changedAtMs - previousChangedAtMs);
      captureReactNativeLifecycleSpan(client, {
        appState, durationMs, fromState: previousState, metadata, now, platform, screen, sessionId,
        timestamp: now(), toState: safeNextState, trace
      });
      previousState = safeNextState;
      previousChangedAtMs = changedAtMs;
    } catch (error) {
      if (typeof onError === "function") {
        onError(error);
      } else {
        throw error;
      }
    }
  });

  return subscriptionRemover(subscription);
}

function requireClient(client) {
  if (!client) {
    throw new SdkError("configuration_error", "LogBrew React Native lifecycle helpers require a client");
  }
}

function defaultLifecycleSpanEventId() {
  return `evt_native_lifecycle_${createReactNativeTraceContext().traceId}`;
}

function normalizeLifecycleState(state) {
  return typeof state === "string" && state.trim() !== "" ? state.trim() : undefined;
}

function subscriptionRemover(subscription) {
  if (typeof subscription === "function") {
    return subscription;
  }
  if (subscription && typeof subscription.remove === "function") {
    return () => subscription.remove();
  }
  return () => {};
}

module.exports = {
  captureReactNativeLifecycleSpan,
  createAppStateLifecycleSpanListener,
  createReactNativeLifecycleSpanEvent
};
