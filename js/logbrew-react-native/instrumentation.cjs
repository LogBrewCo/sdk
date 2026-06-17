"use strict";

const { SdkError } = require("@logbrew/sdk");
const {
  createReactNavigationSpanListener,
  createReactNativeTraceContext,
  getActiveLogBrewTrace
} = require("./index.cjs");
const { createAppStateLifecycleSpanListener } = require("./lifecycle.cjs");
const {
  clearLogBrewNativeBridgeScope,
  syncLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScope
} = require("./native-bridge.cjs");
const { createReactNativeResourceFetch } = require("./resource-fetch.cjs");

function createLogBrewReactNativeInstrumentation(client, {
  appState,
  captureInitialLifecycleState = false,
  captureInitialNavigationRoute = false,
  fetchImpl,
  includeRouteKey = false,
  logger,
  metadata = {},
  nativeBridge,
  navigation,
  navigationContainer,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  onError,
  platform,
  randomValues,
  routeTemplate,
  routeTemplateFactory,
  screen,
  sessionId,
  trace,
  traceFlags = "01",
  tracePropagationTargets = []
} = {}) {
  requireClient(client);
  const activeTrace = resolveInstrumentationTrace({ randomValues, trace, traceFlags });
  const removers = [];
  const resolvedNavigation = navigationContainer ?? navigation;

  if (appState?.addEventListener) {
    removers.push(createAppStateLifecycleSpanListener(client, appState, {
      captureInitialState: captureInitialLifecycleState,
      metadata,
      now,
      nowMs,
      onError,
      platform,
      screen,
      sessionId,
      trace: activeTrace
    }));
  }

  if (resolvedNavigation) {
    removers.push(createReactNavigationSpanListener(client, resolvedNavigation, {
      appState,
      captureInitialRoute: captureInitialNavigationRoute,
      includeRouteKey,
      metadata,
      now,
      nowMs,
      onError,
      platform,
      trace: activeTrace
    }));
  }

  if (nativeBridge) {
    syncLogBrewNativeBridgeScope(nativeBridge, {
      logger,
      metadata,
      screen,
      sessionId,
      source: "react-native.instrumentation",
      trace: activeTrace
    });
  }

  const resourceFetch = createReactNativeResourceFetch(client, {
    appState,
    fetchImpl,
    metadata,
    now,
    nowMs,
    platform,
    randomValues,
    routeTemplate,
    routeTemplateFactory,
    screen,
    sessionId,
    trace: activeTrace,
    traceFlags,
    tracePropagationTargets
  });

  let removed = false;
  const remove = () => {
    if (removed) {
      return;
    }
    removed = true;
    if (nativeBridge) {
      clearLogBrewNativeBridgeScope(nativeBridge);
    }
    for (const removeListener of removers.splice(0).reverse()) {
      removeListener();
    }
  };

  const handle = {
    remove,
    resourceFetch,
    stop: remove,
    syncNativeBridgeScope(options = {}) {
      if (!nativeBridge) {
        return undefined;
      }
      return syncLogBrewNativeBridgeScope(nativeBridge, {
        logger,
        metadata,
        screen,
        sessionId,
        source: "react-native.instrumentation",
        trace: activeTrace,
        ...options
      });
    },
    trace: activeTrace,
    withNativeBridgeScope(callbackOrOptions, maybeCallback) {
      if (!nativeBridge) {
        throw new SdkError("configuration_error", "withNativeBridgeScope requires nativeBridge");
      }
      if (typeof callbackOrOptions === "function") {
        return withLogBrewNativeBridgeScope(nativeBridge, {
          logger,
          metadata,
          screen,
          sessionId,
          source: "react-native.instrumentation",
          trace: activeTrace
        }, callbackOrOptions);
      }
      return withLogBrewNativeBridgeScope(nativeBridge, {
        logger,
        metadata,
        screen,
        sessionId,
        source: "react-native.instrumentation",
        trace: activeTrace,
        ...(callbackOrOptions ?? {})
      }, maybeCallback);
    }
  };
  return Object.freeze(handle);
}

function resolveInstrumentationTrace({ randomValues, trace, traceFlags }) {
  if (typeof trace === "string") {
    return createReactNativeTraceContext({ randomValues, traceFlags, traceparent: trace });
  }
  return trace ?? getActiveLogBrewTrace() ?? createReactNativeTraceContext({ randomValues, traceFlags });
}

function requireClient(client) {
  if (!client) {
    throw new SdkError("configuration_error", "createLogBrewReactNativeInstrumentation requires a client");
  }
}

module.exports = {
  createLogBrewReactNativeInstrumentation,
  default: {
    createLogBrewReactNativeInstrumentation
  }
};
