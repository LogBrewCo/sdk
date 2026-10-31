"use strict";

const { installGlobalFetchInstrumentation } = require("./instrumentation-fetch.cjs");
const { lifecycleRuntime, nativeBridgeRuntime, resourceFetchRuntime } = require("./instrumentation-runtime.cjs");
const { indexRuntime } = require("./instrumentation-values.cjs");
const { installGlobalXMLHttpRequestInstrumentation } = require("./instrumentation-xhr.cjs");

/**
 * @import { LogBrewClient, Metadata } from "@logbrew/sdk"
 * @import { TracePropagationTarget } from "./index.cjs"
 * @import { InstrumentationTeardown } from "./instrumentation-teardown.cjs"
 * @import { ResourceFetch, ResourceFetchOptions } from "./instrumentation-runtime.cjs"
 * @import { AppStateInput, PlatformInput, RandomValues, TraceInput } from "./instrumentation-values.cjs"
 * @import { XhrInstallOptions } from "./instrumentation-xhr.cjs"
 * @import { NativeBridgeScopeInput } from "./native-bridge-scope.cjs"
 */

/**
 * @typedef {{
 *   readonly appState?: AppStateInput | undefined,
 *   readonly captureInitialLifecycleState?: boolean | undefined,
 *   readonly captureInitialNavigationRoute?: boolean | undefined,
 *   readonly fetchImpl?: unknown,
 *   readonly globalObject?: unknown,
 *   readonly includeRouteKey?: boolean | undefined,
 *   readonly instrumentGlobalFetch?: boolean | undefined,
 *   readonly instrumentGlobalXMLHttpRequest?: boolean | undefined,
 *   readonly logger?: string | undefined,
 *   readonly measureFetchResponseBodySize?: boolean | undefined,
 *   readonly measureXhrResponseBodySize?: boolean | undefined,
 *   readonly metadata?: Readonly<Metadata> | undefined,
 *   readonly metadataFactory?: unknown,
 *   readonly nativeBridge?: unknown,
 *   readonly navigation?: unknown,
 *   readonly navigationContainer?: unknown,
 *   readonly now?: (() => string) | undefined,
 *   readonly nowMs?: (() => number) | undefined,
 *   readonly onError?: ((error: unknown) => void) | undefined,
 *   readonly platform?: PlatformInput | undefined,
 *   readonly randomValues?: RandomValues | undefined,
 *   readonly routeTemplate?: string | undefined,
 *   readonly routeTemplateFactory?: unknown,
 *   readonly screen?: string | undefined,
 *   readonly sessionId?: string | undefined,
 *   readonly trace?: TraceInput | undefined,
 *   readonly traceFlags?: string | undefined,
 *   readonly tracePropagationTargets?: readonly TracePropagationTarget[] | undefined
 * }} InstrumentationOptions
 * @typedef {{
 *   readonly appState: AppStateInput | undefined,
 *   readonly captureInitialLifecycleState: boolean,
 *   readonly captureInitialNavigationRoute: boolean,
 *   readonly fetchImpl: unknown,
 *   readonly globalObject: unknown,
 *   readonly includeRouteKey: boolean,
 *   readonly instrumentGlobalFetch: boolean,
 *   readonly instrumentGlobalXMLHttpRequest: boolean,
 *   readonly logger: string | undefined,
 *   readonly measureFetchResponseBodySize: boolean,
 *   readonly measureXhrResponseBodySize: boolean,
 *   readonly metadata: Readonly<Metadata>,
 *   readonly metadataFactory: unknown,
 *   readonly nativeBridge: unknown,
 *   readonly navigation: unknown,
 *   readonly navigationContainer: unknown,
 *   readonly now: () => string,
 *   readonly nowMs: () => number,
 *   readonly onError: ((error: unknown) => void) | undefined,
 *   readonly platform: PlatformInput | undefined,
 *   readonly randomValues: RandomValues | undefined,
 *   readonly routeTemplate: string | undefined,
 *   readonly routeTemplateFactory: unknown,
 *   readonly screen: string | undefined,
 *   readonly sessionId: string | undefined,
 *   readonly trace: TraceInput | undefined,
 *   readonly traceFlags: string,
 *   readonly tracePropagationTargets: readonly TracePropagationTarget[]
 * }} InstrumentationSettings
 * @typedef {Readonly<Omit<InstrumentationSettings, "trace"> & { trace: TraceInput }>} ActiveSettings
 * @typedef {{ readonly client: LogBrewClient, readonly settings: ActiveSettings }} InstrumentationContext
 * @typedef {{
 *   readonly globalFetch: Readonly<{ fetch: ResourceFetch, remove: () => void, stop: () => void }> | undefined,
 *   readonly globalXMLHttpRequest: Readonly<{ remove: () => void, stop: () => void }> | undefined,
 *   readonly resourceFetch: ResourceFetch
 * }} InstalledHooks
 */

const SCOPE_SOURCE = "react-native.instrumentation";

/**
 * @param {ActiveSettings} settings
 * @returns {NativeBridgeScopeInput}
 */
function nativeScopeOptions({ logger, metadata, screen, sessionId, trace }) {
  return { logger, metadata, screen, sessionId, source: SCOPE_SOURCE, trace };
}

/**
 * @param {ActiveSettings} settings
 * @returns {ResourceFetchOptions}
 */
function resourceOptions(settings) {
  return {
    appState: settings.appState,
    metadata: settings.metadata,
    metadataFactory: settings.metadataFactory,
    now: settings.now,
    nowMs: settings.nowMs,
    platform: settings.platform,
    randomValues: settings.randomValues,
    routeTemplate: settings.routeTemplate,
    routeTemplateFactory: settings.routeTemplateFactory,
    screen: settings.screen,
    sessionId: settings.sessionId,
    trace: settings.trace,
    traceFlags: settings.traceFlags,
    tracePropagationTargets: settings.tracePropagationTargets
  };
}

/**
 * @param {ActiveSettings} settings
 * @returns {XhrInstallOptions}
 */
function xhrOptions(settings) {
  return {
    appState: settings.appState,
    globalObject: settings.globalObject,
    measureXhrResponseBodySize: settings.measureXhrResponseBodySize,
    metadata: settings.metadata,
    metadataFactory: settings.metadataFactory,
    now: settings.now,
    nowMs: settings.nowMs,
    platform: settings.platform,
    routeTemplate: settings.routeTemplate,
    routeTemplateFactory: settings.routeTemplateFactory,
    screen: settings.screen,
    sessionId: settings.sessionId,
    trace: settings.trace,
    tracePropagationTargets: settings.tracePropagationTargets
  };
}

/**
 * @param {InstrumentationContext} context
 * @param {InstrumentationTeardown} teardown
 * @returns {void}
 */
function installListeners({ client, settings }, teardown) {
  const hasAppStateListener = Boolean(settings.appState?.addEventListener);
  if (hasAppStateListener) {
    teardown.add(lifecycleRuntime.createAppStateLifecycleSpanListener(client, settings.appState, {
      captureInitialState: settings.captureInitialLifecycleState,
      metadata: settings.metadata,
      now: settings.now,
      nowMs: settings.nowMs,
      onError: settings.onError,
      platform: settings.platform,
      screen: settings.screen,
      sessionId: settings.sessionId,
      trace: settings.trace
    }));
  }
  const resolvedNavigation = settings.navigationContainer ?? settings.navigation;
  const hasNavigation = Boolean(resolvedNavigation);
  if (hasNavigation) {
    teardown.add(indexRuntime.createReactNavigationSpanListener(client, resolvedNavigation, {
      appState: settings.appState,
      captureInitialRoute: settings.captureInitialNavigationRoute,
      includeRouteKey: settings.includeRouteKey,
      metadata: settings.metadata,
      now: settings.now,
      nowMs: settings.nowMs,
      onError: settings.onError,
      platform: settings.platform,
      trace: settings.trace
    }));
  }
}

/**
 * @param {InstrumentationContext} context
 * @param {InstrumentationTeardown} teardown
 * @returns {void}
 */
function syncInitialNativeScope({ settings }, teardown) {
  const hasNativeBridge = Boolean(settings.nativeBridge);
  if (hasNativeBridge) {
    nativeBridgeRuntime.syncLogBrewNativeBridgeScope(settings.nativeBridge, nativeScopeOptions(settings));
    teardown.markNativeScopeApplied();
  }
}

/**
 * @param {InstrumentationContext} context
 * @param {InstrumentationTeardown} teardown
 * @returns {InstalledHooks}
 */
function installFetchHooks({ client, settings }, teardown) {
  const resourceFetch = resourceFetchRuntime.createReactNativeResourceFetch(client, {
    ...resourceOptions(settings),
    fetchImpl: settings.fetchImpl,
    measureResponseBodySize: settings.measureFetchResponseBodySize
  });
  const globalFetch = settings.instrumentGlobalFetch ? installGlobalFetchInstrumentation(client, {
    globalObject: settings.globalObject,
    measureResponseBodySize: settings.measureFetchResponseBodySize,
    resourceOptions: resourceOptions(settings)
  }) : undefined;
  if (globalFetch !== undefined) {
    teardown.add(globalFetch.remove);
  }
  const globalXMLHttpRequest = settings.instrumentGlobalXMLHttpRequest
    ? installGlobalXMLHttpRequestInstrumentation(client, xhrOptions(settings))
    : undefined;
  if (globalXMLHttpRequest !== undefined) {
    teardown.add(globalXMLHttpRequest.remove);
  }
  return { globalFetch, globalXMLHttpRequest, resourceFetch };
}

/**
 * @param {InstrumentationContext} context
 * @param {InstrumentationTeardown} teardown
 * @returns {InstalledHooks}
 */
function installInstrumentation(context, teardown) {
  try {
    installListeners(context, teardown);
    syncInitialNativeScope(context, teardown);
    return installFetchHooks(context, teardown);
  } catch (error) {
    teardown.removeAfterSetupFailure(context.settings.nativeBridge);
    throw error;
  }
}

module.exports = {
  installInstrumentation,
  nativeScopeOptions
};
