"use strict";

/**
 * @import { LogBrewClient, Metadata } from "@logbrew/sdk"
 * @import { TracePropagationTarget } from "./index.cjs"
 * @import { AppStateInput, Callable, PlatformInput, RandomValues, TraceInput } from "./instrumentation-values.cjs"
 * @import { NativeBridgeScopeInput } from "./native-bridge-scope.cjs"
 */

/**
 * @typedef {{
 *   readonly captureInitialState?: boolean | undefined,
 *   readonly metadata?: Readonly<Metadata> | undefined,
 *   readonly now?: (() => string) | undefined,
 *   readonly nowMs?: (() => number) | undefined,
 *   readonly onError?: ((error: unknown) => void) | undefined,
 *   readonly platform?: PlatformInput | undefined,
 *   readonly screen?: string | undefined,
 *   readonly sessionId?: string | undefined,
 *   readonly trace?: TraceInput | undefined
 * }} LifecycleListenerOptions
 * @typedef {{
 *   readonly appState?: AppStateInput | undefined,
 *   readonly fetchImpl?: unknown,
 *   readonly measureResponseBodySize?: boolean | undefined,
 *   readonly metadata?: Readonly<Metadata> | undefined,
 *   readonly metadataFactory?: unknown,
 *   readonly now?: (() => string) | undefined,
 *   readonly nowMs?: (() => number) | undefined,
 *   readonly platform?: PlatformInput | undefined,
 *   readonly randomValues?: RandomValues | undefined,
 *   readonly routeTemplate?: string | undefined,
 *   readonly routeTemplateFactory?: unknown,
 *   readonly screen?: string | undefined,
 *   readonly sessionId?: string | undefined,
 *   readonly trace?: TraceInput | undefined,
 *   readonly traceFlags?: string | undefined,
 *   readonly tracePropagationTargets?: readonly TracePropagationTarget[] | undefined
 * }} ResourceFetchOptions
 * @typedef {{
 *   createAppStateLifecycleSpanListener(client: LogBrewClient, appState: AppStateInput | null | undefined, options?: LifecycleListenerOptions): () => unknown
 * }} LifecycleRuntime
 * @typedef {{
 *   clearLogBrewNativeBridgeScope(nativeBridge: unknown): void,
 *   syncLogBrewNativeBridgeScope(nativeBridge: unknown, options?: NativeBridgeScopeInput): unknown,
 *   withLogBrewNativeBridgeScope(nativeBridge: unknown, options: NativeBridgeScopeInput | Callable | null | undefined, work?: unknown): unknown
 * }} NativeBridgeRuntime
 * @typedef {(input: unknown, init?: unknown) => PromiseLike<unknown>} ResourceFetch
 * @typedef {{
 *   createReactNativeResourceFetch(client: LogBrewClient, options?: ResourceFetchOptions): ResourceFetch
 * }} ResourceFetchRuntime
 */

/** @type {LifecycleRuntime} */
const lifecycleRuntime = require("./lifecycle.cjs");
/** @type {NativeBridgeRuntime} */
const nativeBridgeRuntime = require("./native-bridge.cjs");
/** @type {ResourceFetchRuntime} */
const resourceFetchRuntime = require("./resource-fetch.cjs");

module.exports = {
  lifecycleRuntime,
  nativeBridgeRuntime,
  resourceFetchRuntime
};
