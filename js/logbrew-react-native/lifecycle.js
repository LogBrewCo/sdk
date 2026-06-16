import { SdkError } from "@logbrew/sdk";
import {
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  getActiveLogBrewTrace,
  getReactNativeContext
} from "./index.js";

export function createReactNativeLifecycleSpanEvent({
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

export function captureReactNativeLifecycleSpan(client, input = {}) {
  requireClient(client);
  const event = createReactNativeLifecycleSpanEvent(input);
  client.span(event.id, event.timestamp, event.attributes);
  return event;
}

export function createAppStateLifecycleSpanListener(client, appState, {
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

function defaultLifecycleSpanEventId({ fromState, screen, toState }) {
  return `evt_native_lifecycle_${slugify([screen, fromState, toState].filter(Boolean).join("_") || "app_state")}`;
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

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}
