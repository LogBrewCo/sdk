"use strict";

const { SdkError } = require("@logbrew/sdk");
const { createInstrumentationTeardown } = require("./instrumentation-teardown.cjs");
const { installInstrumentation, nativeScopeOptions } = require("./instrumentation-install.cjs");
const { nativeBridgeRuntime } = require("./instrumentation-runtime.cjs");
const { indexRuntime, isCallable, isObjectLike } = require("./instrumentation-values.cjs");

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import { InstrumentationTeardown } from "./instrumentation-teardown.cjs"
 * @import {
 *   ActiveSettings,
 *   InstalledHooks,
 *   InstrumentationOptions,
 *   InstrumentationSettings
 * } from "./instrumentation-install.cjs"
 * @import { ResourceFetch } from "./instrumentation-runtime.cjs"
 * @import { TraceInput } from "./instrumentation-values.cjs"
 */

/**
 * @typedef {{
 *   readonly globalFetch: InstalledHooks["globalFetch"],
 *   readonly globalXMLHttpRequest: InstalledHooks["globalXMLHttpRequest"],
 *   readonly remove: () => void,
 *   readonly resourceFetch: ResourceFetch,
 *   readonly stop: () => void,
 *   syncNativeBridgeScope(options?: unknown): unknown,
 *   readonly trace: TraceInput,
 *   withNativeBridgeScope(callbackOrOptions: unknown, maybeCallback?: unknown): unknown
 * }} InstrumentationHandle
 */

/**
 * @param {InstrumentationOptions} [options]
 * @returns {InstrumentationSettings}
 */
function instrumentationSettings({
  appState,
  captureInitialLifecycleState = false,
  captureInitialNavigationRoute = false,
  fetchImpl,
  globalObject = globalThis,
  includeRouteKey = false,
  instrumentGlobalFetch = false,
  instrumentGlobalXMLHttpRequest = false,
  logger,
  measureFetchResponseBodySize = false,
  measureXhrResponseBodySize = false,
  metadata = {},
  metadataFactory,
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
  return {
    appState, captureInitialLifecycleState, captureInitialNavigationRoute, fetchImpl, globalObject, includeRouteKey,
    instrumentGlobalFetch, instrumentGlobalXMLHttpRequest, logger, measureFetchResponseBodySize, measureXhrResponseBodySize,
    metadata, metadataFactory, nativeBridge, navigation, navigationContainer, now, nowMs, onError, platform, randomValues,
    routeTemplate, routeTemplateFactory, screen, sessionId, trace, traceFlags, tracePropagationTargets
  };
}

/**
 * @param {InstrumentationSettings} settings
 * @returns {TraceInput}
 */
function resolveInstrumentationTrace({ randomValues, trace, traceFlags }) {
  if (typeof trace === "string") {
    return indexRuntime.createReactNativeTraceContext({ randomValues, traceFlags, traceparent: trace });
  }
  return trace ?? indexRuntime.getActiveLogBrewTrace() ?? indexRuntime.createReactNativeTraceContext({ randomValues, traceFlags });
}

/**
 * @param {LogBrewClient | null | undefined} client
 * @returns {asserts client is LogBrewClient}
 */
function requireClient(client) {
  if (!client) {
    throw new SdkError("configuration_error", "createLogBrewReactNativeInstrumentation requires a client");
  }
}

/**
 * @param {unknown} options
 * @returns {{ readonly [key: string]: unknown }}
 */
function scopeOverrides(options) {
  return isObjectLike(options) ? options : {};
}

/**
 * @param {ActiveSettings} settings
 * @param {InstrumentationTeardown} teardown
 * @param {InstalledHooks} installed
 * @returns {Readonly<InstrumentationHandle>}
 */
function instrumentationHandle(settings, teardown, installed) {
  const { nativeBridge } = settings;
  let removed = false;
  const { remove } = {
    remove: () => {
      if (removed) {
        return;
      }
      teardown.removeAll(nativeBridge);
      removed = true;
    }
  };
  /** @type {InstrumentationHandle} */
  const handle = {
    globalFetch: installed.globalFetch,
    globalXMLHttpRequest: installed.globalXMLHttpRequest,
    remove,
    resourceFetch: installed.resourceFetch,
    stop: remove,
    syncNativeBridgeScope(options = {}) {
      const hasNativeBridge = Boolean(nativeBridge);
      if (!hasNativeBridge) {
        return undefined;
      }
      return nativeBridgeRuntime.syncLogBrewNativeBridgeScope(nativeBridge, { ...nativeScopeOptions(settings), ...scopeOverrides(options) });
    },
    trace: settings.trace,
    withNativeBridgeScope(callbackOrOptions, maybeCallback) {
      const hasNativeBridge = Boolean(nativeBridge);
      if (!hasNativeBridge) {
        throw new SdkError("configuration_error", "withNativeBridgeScope requires nativeBridge");
      }
      if (isCallable(callbackOrOptions)) {
        return nativeBridgeRuntime.withLogBrewNativeBridgeScope(nativeBridge, nativeScopeOptions(settings), callbackOrOptions);
      }
      return nativeBridgeRuntime.withLogBrewNativeBridgeScope(nativeBridge, {
        ...nativeScopeOptions(settings),
        ...scopeOverrides(callbackOrOptions)
      }, maybeCallback);
    }
  };
  return Object.freeze(handle);
}

/**
 * @param {LogBrewClient | null | undefined} client
 * @param {InstrumentationOptions} [options]
 * @returns {Readonly<InstrumentationHandle>}
 */
function createLogBrewReactNativeInstrumentation(client, options = {}) {
  const settings = instrumentationSettings(options);
  requireClient(client);
  const context = { client, settings: { ...settings, trace: resolveInstrumentationTrace(settings) } };
  const teardown = createInstrumentationTeardown();
  const installed = installInstrumentation(context, teardown);
  return instrumentationHandle(context.settings, teardown, installed);
}

module.exports = {
  createLogBrewReactNativeInstrumentation,
  default: {
    createLogBrewReactNativeInstrumentation
  }
};
