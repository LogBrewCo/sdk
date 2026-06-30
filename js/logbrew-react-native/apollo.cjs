"use strict";

const {
  SdkError
} = require("@logbrew/sdk");
const {
  captureReactNativeResourceSpan,
  createReactNativeTraceContext,
  createReactNativeTraceHeaders,
  getActiveLogBrewTrace
} = require("./index.cjs");
const {
  safeReactNativeMetadataFactoryResult
} = require("./metadata.cjs");

const MAX_GRAPHQL_OPERATION_NAME_CHARS = 128;
const GRAPHQL_OPERATION_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/u;
const GRAPHQL_OPERATION_TYPES = new Set(["query", "mutation", "subscription"]);

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

  return new ApolloLink((operation, forward) => {
    if (typeof forward !== "function") {
      throw new SdkError("configuration_error", "createReactNativeApolloLink requires Apollo forward");
    }

    const startedAtMs = nowMs();
    const timestamp = now();
    const activeTrace = apolloTraceContext({ randomValues, trace, traceFlags });
    const details = apolloOperationDetails(operation);
    if (propagateTraceparent) {
      setOperationTraceparent(operation, activeTrace);
    }

    let forwarded;
    try {
      forwarded = forward(operation);
    } catch (error) {
      captureApolloSpan(client, {
        activeTrace,
        appState,
        details,
        durationMs: elapsedMs(startedAtMs, nowMs),
        error,
        metadata,
        metadataFactory,
        now,
        platform,
        screen,
        sessionId,
        status: "error",
        timestamp
      });
      throw error;
    }

    if (!forwarded || typeof forwarded.subscribe !== "function") {
      throw new SdkError("configuration_error", "Apollo forward must return an observable-like value");
    }

    return apolloObservable(forwarded, {
      activeTrace,
      appState,
      client,
      details,
      metadata,
      metadataFactory,
      now,
      nowMs,
      platform,
      screen,
      sessionId,
      startedAtMs,
      timestamp
    });
  });
}

function apolloObservable(forwarded, options) {
  return {
    subscribe(observerOrNext, onError, onComplete) {
      const observer = apolloObserver(observerOrNext, onError, onComplete);
      let finished = false;
      let graphqlErrorCount = 0;

      const finish = ({ error, status }) => {
        if (finished) {
          return;
        }
        finished = true;
        captureApolloSpan(options.client, {
          activeTrace: options.activeTrace,
          appState: options.appState,
          details: options.details,
          durationMs: elapsedMs(options.startedAtMs, options.nowMs),
          error,
          graphqlErrorCount,
          metadata: options.metadata,
          metadataFactory: options.metadataFactory,
          now: options.now,
          platform: options.platform,
          screen: options.screen,
          sessionId: options.sessionId,
          status,
          timestamp: options.timestamp
        });
      };

      try {
        return forwarded.subscribe({
          next(value) {
            graphqlErrorCount += graphqlErrorCountFromResult(value);
            observer.next?.(value);
          },
          error(error) {
            finish({ error, status: "error" });
            observer.error?.(error);
          },
          complete() {
            finish({ status: graphqlErrorCount > 0 ? "error" : "ok" });
            observer.complete?.();
          }
        });
      } catch (error) {
        finish({ error, status: "error" });
        throw error;
      }
    }
  };
}

function captureApolloSpan(client, {
  activeTrace,
  appState,
  details,
  durationMs,
  error,
  graphqlErrorCount,
  metadata,
  metadataFactory,
  now,
  platform,
  screen,
  sessionId,
  status,
  timestamp
}) {
  const context = {
    durationMs,
    error,
    operationName: details.operationName,
    operationType: details.operationType,
    screen,
    status
  };
  captureReactNativeResourceSpan(client, {
    appState,
    durationMs,
    id: defaultApolloSpanId({ operationName: details.operationName, operationType: details.operationType, screen }),
    kind: "graphql",
    metadata: {
      ...metadata,
      ...safeReactNativeMetadataFactoryResult(typeof metadataFactory === "function" ? metadataFactory(context) : undefined),
      errorName: errorName(error),
      errorValueType: error === undefined ? undefined : typeof error,
      framework: "apollo-client",
      graphqlErrorCount: graphqlErrorCount && graphqlErrorCount > 0 ? graphqlErrorCount : undefined,
      graphqlOperationName: details.operationName,
      graphqlOperationType: details.operationType,
      source: "react-native.apollo"
    },
    name: apolloSpanName(details),
    now,
    platform,
    screen,
    sessionId,
    status,
    timestamp,
    trace: activeTrace
  });
}

function setOperationTraceparent(operation, trace) {
  if (!operation || typeof operation.setContext !== "function") {
    return;
  }
  const traceparent = createReactNativeTraceHeaders(trace).traceparent;
  operation.setContext(({ headers = {} } = {}) => ({
    headers: {
      ...headers,
      traceparent
    }
  }));
}

function apolloOperationDetails(operation) {
  const definition = operation?.query?.definitions?.find?.((candidate) => (
    candidate?.kind === "OperationDefinition" && GRAPHQL_OPERATION_TYPES.has(candidate?.operation)
  ));
  return {
    operationName: safeGraphqlOperationName(operation?.operationName) ?? safeGraphqlOperationName(definition?.name?.value),
    operationType: GRAPHQL_OPERATION_TYPES.has(definition?.operation) ? definition.operation : undefined
  };
}

function apolloSpanName({ operationName, operationType }) {
  const base = `graphql.${operationType ?? "operation"}`;
  return operationName ? `${base} ${operationName}` : base;
}

function apolloTraceContext({ randomValues, trace, traceFlags }) {
  if (typeof trace === "string") {
    return createReactNativeTraceContext({ randomValues, traceFlags, traceparent: trace });
  }
  return trace ?? getActiveLogBrewTrace() ?? createReactNativeTraceContext({ randomValues, traceFlags });
}

function apolloObserver(observerOrNext, onError, onComplete) {
  if (typeof observerOrNext === "function") {
    return {
      next: observerOrNext,
      error: onError,
      complete: onComplete
    };
  }
  return observerOrNext && typeof observerOrNext === "object" ? observerOrNext : {};
}

function graphqlErrorCountFromResult(value) {
  return Array.isArray(value?.errors) ? value.errors.length : 0;
}

function safeGraphqlOperationName(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const name = value.trim();
  if (
    name.length === 0 ||
    name.length > MAX_GRAPHQL_OPERATION_NAME_CHARS ||
    !GRAPHQL_OPERATION_NAME_RE.test(name)
  ) {
    return undefined;
  }
  return name;
}

function elapsedMs(startedAtMs, nowMs) {
  const durationMs = nowMs() - startedAtMs;
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : undefined;
}

function errorName(error) {
  if (error instanceof Error && typeof error.name === "string" && error.name.trim() !== "") {
    return error.name;
  }
  if (typeof error?.name === "string" && error.name.trim() !== "") {
    return error.name;
  }
  return undefined;
}

function defaultApolloSpanId({ operationName, operationType, screen }) {
  return `evt_native_apollo_${slugify([screen, operationType, operationName].filter(Boolean).join("_") || "operation")}`;
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 96) || "event";
}

module.exports = {
  createReactNativeApolloLink,
  default: {
    createReactNativeApolloLink
  }
};
