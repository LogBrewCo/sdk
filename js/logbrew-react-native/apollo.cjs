"use strict";

const { SdkError } = require("@logbrew/sdk");
const {
  captureReactNativeResourceSpan, createReactNativeTraceContext, createReactNativeTraceHeaders, getActiveLogBrewTrace
} = require("./index.cjs");
const { safeReactNativeMetadataFactoryResult } = require("./metadata.cjs");

/**
 * @import { LogBrewClient, Metadata } from "@logbrew/sdk"
 * @import {
 *   ReactNativeTraceContext,
 *   ReactNativeTraceContextConfig
 * } from "./index.cjs"
 * @typedef {(length: number) => Uint8Array} RandomValues
 * @typedef {{
 *   readonly OS?: string,
 *   readonly Version?: string | number,
 *   readonly isPad?: boolean,
 *   readonly constants?: { readonly isTesting?: boolean, readonly [key: string]: unknown }
 * }} PlatformLike
 * @typedef {{
 *   readonly currentState?: string | null,
 *   readonly addEventListener?: (type: "change", listener: (state: string) => void) => { readonly remove: () => void } | (() => void)
 * }} AppStateLike
 * @typedef {{ readonly operationName: string | undefined, readonly operationType: string | undefined }} ApolloOperationDetails
 * @typedef {"ok" | "error"} ApolloSpanStatus
 * @typedef {(this: unknown, ...args: readonly unknown[]) => unknown} Callable
 * @typedef {{
 *   readonly durationMs: number | undefined,
 *   readonly error: unknown,
 *   readonly operationName: string | undefined,
 *   readonly operationType: string | undefined,
 *   readonly screen: string | undefined,
 *   readonly status: ApolloSpanStatus
 * }} ApolloMetadataContext
 * @typedef {{
 *   readonly ApolloLink?: unknown,
 *   readonly appState?: AppStateLike | undefined,
 *   readonly metadata?: Readonly<Metadata> | undefined,
 *   readonly metadataFactory?: unknown,
 *   readonly now?: (() => string) | undefined,
 *   readonly nowMs?: (() => number) | undefined,
 *   readonly platform?: PlatformLike | undefined,
 *   readonly propagateTraceparent?: boolean | undefined,
 *   readonly randomValues?: RandomValues | undefined,
 *   readonly screen?: string | undefined,
 *   readonly sessionId?: string | undefined,
 *   readonly trace?: Readonly<ReactNativeTraceContext> | string | undefined,
 *   readonly traceFlags?: string | undefined
 * }} ApolloLinkOptions
 * @typedef {{
 *   readonly activeTrace: Readonly<ReactNativeTraceContext>,
 *   readonly appState: AppStateLike | undefined,
 *   readonly client: LogBrewClient,
 *   readonly details: ApolloOperationDetails,
 *   readonly metadata: Readonly<Metadata>,
 *   readonly metadataFactory: Callable | undefined,
 *   readonly now: () => string,
 *   readonly nowMs: () => number,
 *   readonly platform: PlatformLike | undefined,
 *   readonly screen: string | undefined,
 *   readonly sessionId: string | undefined,
 *   readonly startedAtMs: number,
 *   readonly timestamp: string
 * }} ApolloSpanOptions
 * @typedef {Omit<ApolloSpanOptions, "activeTrace" | "details" | "startedAtMs" | "timestamp"> & {
 *   readonly propagateTraceparent: boolean,
 *   readonly randomValues: RandomValues | undefined,
 *   readonly trace: Readonly<ReactNativeTraceContext> | string | undefined,
 *   readonly traceFlags: string
 * }} ApolloLinkSettings
 * @typedef {{ readonly durationMs: number | undefined, readonly error?: unknown, readonly graphqlErrorCount?: number, readonly status: ApolloSpanStatus }} ApolloSpanOutcome
 */

const MAX_GRAPHQL_OPERATION_NAME_CHARS = 128;
const GRAPHQL_OPERATION_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/u;
/** @type {ReadonlySet<unknown>} */
const GRAPHQL_OPERATION_TYPES = new Set(["query", "mutation", "subscription"]);
const EMPTY_LENGTH = 0;
const NO_ERRORS = 0;
const MIN_DURATION_MS = 0;

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
  return (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} value
 * @returns {value is Callable}
 */
function isCallable(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function safeGraphqlOperationName(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const name = value.trim();
  if (
    name.length === EMPTY_LENGTH ||
    name.length > MAX_GRAPHQL_OPERATION_NAME_CHARS ||
    !GRAPHQL_OPERATION_NAME_RE.test(name)
  ) {
    return undefined;
  }
  return name;
}

/**
 * @param {number} startedAtMs
 * @param {() => number} nowMs
 * @returns {number | undefined}
 */
function elapsedMs(startedAtMs, nowMs) {
  const durationMs = nowMs() - startedAtMs;
  return Number.isFinite(durationMs) ? Math.max(MIN_DURATION_MS, durationMs) : undefined;
}

/**
 * @param {unknown} error
 * @returns {string | undefined}
 */
function errorName(error) {
  if (error instanceof Error && typeof error.name === "string" && error.name.trim() !== "") {
    return error.name;
  }
  const name = field(error, "name");
  if (typeof name === "string" && name.trim() !== "") {
    return name;
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function graphqlErrorCountFromResult(value) {
  const errors = field(value, "errors");
  return Array.isArray(errors) ? errors.length : NO_ERRORS;
}

/**
 * @param {unknown} candidate
 * @returns {boolean}
 */
function isOperationDefinition(candidate) {
  return field(candidate, "kind") === "OperationDefinition" && GRAPHQL_OPERATION_TYPES.has(field(candidate, "operation"));
}

/**
 * @param {unknown} definitions
 * @returns {unknown}
 */
function findOperationDefinition(definitions) {
  const find = field(definitions, "find");
  if (isCallable(find)) {
    return find.call(
      definitions,
      /**
       * @param {unknown} candidate
       * @returns {boolean}
       */
      (candidate) => isOperationDefinition(candidate)
    );
  }
  if (find !== undefined && find !== null) {
    throw new TypeError("operation?.query?.definitions?.find is not a function");
  }
  return undefined;
}

/**
 * @param {unknown} operation
 * @returns {ApolloOperationDetails}
 */
function apolloOperationDetails(operation) {
  const definition = findOperationDefinition(field(field(operation, "query"), "definitions"));
  const operationType = field(definition, "operation");
  return {
    operationName: safeGraphqlOperationName(field(operation, "operationName")) ?? safeGraphqlOperationName(field(field(definition, "name"), "value")),
    operationType: typeof operationType === "string" && GRAPHQL_OPERATION_TYPES.has(operationType) ? operationType : undefined
  };
}

/**
 * @param {ApolloOperationDetails} details
 * @returns {string}
 */
function apolloSpanName({ operationName, operationType }) {
  const base = `graphql.${operationType ?? "operation"}`;
  return operationName === undefined || operationName === "" ? base : `${base} ${operationName}`;
}

/**
 * @param {RandomValues | undefined} randomValues
 * @param {string} traceFlags
 * @returns {ReactNativeTraceContextConfig}
 */
function traceConfig(randomValues, traceFlags) {
  return randomValues === undefined ? { traceFlags } : { randomValues, traceFlags };
}

/**
 * @param {Pick<ApolloLinkSettings, "randomValues" | "trace" | "traceFlags">} settings
 * @returns {Readonly<ReactNativeTraceContext>}
 */
function apolloTraceContext({ randomValues, trace, traceFlags }) {
  if (typeof trace === "string") {
    return createReactNativeTraceContext({ ...traceConfig(randomValues, traceFlags), traceparent: trace });
  }
  return trace ?? getActiveLogBrewTrace() ?? createReactNativeTraceContext(traceConfig(randomValues, traceFlags));
}

/**
 * @param {unknown} observerOrNext
 * @param {unknown} onError
 * @param {unknown} onComplete
 * @returns {unknown}
 */
function apolloObserver(observerOrNext, onError, onComplete) {
  if (typeof observerOrNext === "function") {
    return { complete: onComplete, error: onError, next: observerOrNext };
  }
  return observerOrNext !== null && observerOrNext !== undefined && typeof observerOrNext === "object" ? observerOrNext : {};
}

/**
 * @param {unknown} observer
 * @param {"complete" | "error" | "next"} name
 * @param {readonly unknown[]} args
 * @returns {void}
 */
function callObserver(observer, name, args) {
  const handler = field(observer, name);
  if (isCallable(handler)) {
    handler.call(observer, ...args);
  } else if (handler !== undefined && handler !== null) {
    throw new TypeError(`observer.${name} is not a function`);
  }
}

/**
 * @param {unknown} operation
 * @param {Readonly<ReactNativeTraceContext>} trace
 * @returns {void}
 */
function setOperationTraceparent(operation, trace) {
  const setContext = field(operation, "setContext");
  if (!isCallable(setContext)) {
    return;
  }
  const { traceparent } = createReactNativeTraceHeaders(trace);
  setContext.call(
    operation,
    /**
     * @param {{ readonly headers?: Readonly<Record<string, string>> }} [previous]
     * @returns {{ headers: Record<string, string> }}
     */
    ({ headers = {} } = {}) => ({ headers: { ...headers, traceparent } })
  );
}

/**
 * @param {ApolloSpanOptions} options
 * @param {ApolloSpanOutcome} outcome
 * @returns {Metadata}
 */
function apolloSpanMetadata({ details, metadata, metadataFactory, screen }, { durationMs, error, graphqlErrorCount, status }) {
  /** @type {ApolloMetadataContext} */
  const context = {
    durationMs,
    error,
    operationName: details.operationName,
    operationType: details.operationType,
    screen,
    status
  };
  /** @type {Metadata} */
  const spanMetadata = {
    ...metadata,
    ...safeReactNativeMetadataFactoryResult(metadataFactory === undefined ? undefined : metadataFactory(context))
  };
  /** @type {ReadonlyArray<readonly [string, string | number | undefined]>} */
  const apolloValues = [
    ["errorName", errorName(error)],
    ["errorValueType", error === undefined ? undefined : typeof error],
    ["framework", "apollo-client"],
    ["graphqlErrorCount", graphqlErrorCount !== undefined && graphqlErrorCount > NO_ERRORS ? graphqlErrorCount : undefined],
    ["graphqlOperationName", details.operationName],
    ["graphqlOperationType", details.operationType],
    ["source", "react-native.apollo"]
  ];
  for (const [key, value] of apolloValues) {
    if (value === undefined) {
      Reflect.deleteProperty(spanMetadata, key);
    } else {
      spanMetadata[key] = value;
    }
  }
  return spanMetadata;
}

/**
 * @param {ApolloSpanOptions} options
 * @param {ApolloSpanOutcome} outcome
 * @returns {void}
 */
function captureApolloSpan(options, outcome) {
  const { activeTrace, appState, client, details, now, platform, screen, sessionId, timestamp } = options;
  const { durationMs, status } = outcome;
  captureReactNativeResourceSpan(client, {
    ...(appState === undefined ? {} : { appState }),
    ...(durationMs === undefined ? {} : { durationMs }),
    kind: "graphql",
    metadata: apolloSpanMetadata(options, outcome),
    name: apolloSpanName(details),
    now,
    ...(platform === undefined ? {} : { platform }),
    ...(screen === undefined ? {} : { screen }),
    ...(sessionId === undefined ? {} : { sessionId }),
    status,
    timestamp,
    trace: activeTrace
  });
}

/**
 * @param {unknown} forwarded
 * @param {ApolloSpanOptions} options
 * @param {unknown} observer
 * @returns {unknown}
 */
function subscribeWithSpan(forwarded, options, observer) {
  let finished = false;
  let graphqlErrorCount = NO_ERRORS;

  /**
   * @param {unknown} error
   * @param {ApolloSpanStatus} status
   * @returns {void}
   */
  function finish(error, status) {
    if (finished) {
      return;
    }
    finished = true;
    captureApolloSpan(options, { durationMs: elapsedMs(options.startedAtMs, options.nowMs), error, graphqlErrorCount, status });
  }

  try {
    const subscribe = field(forwarded, "subscribe");
    if (!isCallable(subscribe)) {
      throw new TypeError("forwarded.subscribe is not a function");
    }
    return subscribe.call(forwarded, {
      /** @param {unknown} value */
      next(value) {
        graphqlErrorCount += graphqlErrorCountFromResult(value);
        callObserver(observer, "next", [value]);
      },

      /** @param {unknown} error */
      error(error) {
        finish(error, "error");
        callObserver(observer, "error", [error]);
      },

      complete() {
        finish(undefined, graphqlErrorCount > NO_ERRORS ? "error" : "ok");
        callObserver(observer, "complete", []);
      }
    });
  } catch (error) {
    finish(error, "error");
    throw error;
  }
}

/**
 * @param {unknown} forwarded
 * @param {ApolloSpanOptions} options
 * @returns {{ subscribe: (observerOrNext: unknown, onError: unknown, onComplete: unknown) => unknown }}
 */
function apolloObservable(forwarded, options) {
  if (!isCallable(field(forwarded, "subscribe"))) {
    throw new SdkError("configuration_error", "Apollo forward must return an observable-like value");
  }
  return {
    subscribe(observerOrNext, onError, onComplete) {
      return subscribeWithSpan(forwarded, options, apolloObserver(observerOrNext, onError, onComplete));
    }
  };
}

/**
 * @param {Callable} forward
 * @param {unknown} operation
 * @param {ApolloSpanOptions} options
 * @returns {unknown}
 */
function forwardOperation(forward, operation, options) {
  try {
    return forward(operation);
  } catch (error) {
    captureApolloSpan(options, { durationMs: elapsedMs(options.startedAtMs, options.nowMs), error, status: "error" });
    throw error;
  }
}

/**
 * @param {ApolloLinkSettings} settings
 * @param {unknown} operation
 * @param {unknown} forward
 * @returns {unknown}
 */
function handleApolloOperation(settings, operation, forward) {
  if (!isCallable(forward)) {
    throw new SdkError("configuration_error", "createReactNativeApolloLink requires Apollo forward");
  }
  const startedAtMs = settings.nowMs();
  const timestamp = settings.now();
  const activeTrace = apolloTraceContext(settings);
  const details = apolloOperationDetails(operation);
  if (settings.propagateTraceparent) {
    setOperationTraceparent(operation, activeTrace);
  }
  /** @type {ApolloSpanOptions} */
  const options = { ...settings, activeTrace, details, startedAtMs, timestamp };
  return apolloObservable(forwardOperation(forward, operation, options), options);
}

/**
 * @param {LogBrewClient} client
 * @param {ApolloLinkOptions} [options]
 * @returns {unknown}
 */
function createReactNativeApolloLink(client, {
  ApolloLink,
  appState,
  metadata = {},
  metadataFactory,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  platform,
  propagateTraceparent = true,
  randomValues,
  screen,
  sessionId,
  trace,
  traceFlags = "01"
} = {}) {
  if (typeof ApolloLink !== "function") {
    throw new SdkError("configuration_error", "createReactNativeApolloLink requires an app-provided ApolloLink constructor");
  }
  if (metadataFactory !== undefined && typeof metadataFactory !== "function") {
    throw new SdkError("configuration_error", "metadataFactory must be a function");
  }
  /** @type {ApolloLinkSettings} */
  const settings = {
    appState,
    client,
    metadata,
    metadataFactory: isCallable(metadataFactory) ? metadataFactory : undefined,
    now,
    nowMs,
    platform,
    propagateTraceparent,
    randomValues,
    screen,
    sessionId,
    trace,
    traceFlags
  };
  return Reflect.construct(ApolloLink, [
    /**
     * @param {unknown} operation
     * @param {unknown} forward
     * @returns {unknown}
     */
    (operation, forward) => handleApolloOperation(settings, operation, forward)
  ]);
}

module.exports = { createReactNativeApolloLink, default: { createReactNativeApolloLink } };
