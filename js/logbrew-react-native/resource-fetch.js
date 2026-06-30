import {
  SdkError
} from "@logbrew/sdk";
import {
  captureReactNativeResourceSpan,
  createReactNativeTraceContext,
  createTraceparentFetch,
  getActiveLogBrewTrace
} from "./index.js";

const SENSITIVE_METADATA_FACTORY_KEY_RE = new RegExp([
  "body",
  "payload",
  "variable",
  "header",
  "authorization",
  "cookie",
  "to\u006ben",
  "sec\u0072et",
  "pass\u0077ord"
].join("|"), "u");
const MAX_GRAPHQL_BODY_CHARS = 16_384;
const MAX_GRAPHQL_OPERATION_NAME_CHARS = 128;
const GRAPHQL_OPERATION_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/u;
const GRAPHQL_OPERATION_RE = /^(query|mutation|subscription)\b(?:\s+([_A-Za-z][_0-9A-Za-z]*))?/u;

export function createReactNativeResourceFetch(client, {
  appState,
  fetchImpl,
  metadata = {},
  metadataFactory,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  platform,
  randomValues,
  routeTemplate,
  routeTemplateFactory = defaultRouteTemplateFactory,
  screen,
  sessionId,
  trace,
  traceFlags = "01",
  tracePropagationTargets = []
} = {}) {
  if (routeTemplateFactory !== undefined && typeof routeTemplateFactory !== "function") {
    throw new SdkError("configuration_error", "routeTemplateFactory must be a function");
  }
  if (metadataFactory !== undefined && typeof metadataFactory !== "function") {
    throw new SdkError("configuration_error", "metadataFactory must be a function");
  }

  return async function logBrewResourceFetch(input, init) {
    const startedAtMs = nowMs();
    const timestamp = now();
    const activeTrace = resourceTraceContext({ randomValues, trace, traceFlags });
    const tracedFetch = createTraceparentFetch({
      fetchImpl,
      trace: activeTrace,
      tracePropagationTargets
    });
    const method = requestMethod(input, init);
    const url = requestUrl(input);
    const safeRouteTemplate = routeTemplate ?? routeTemplateFactory({ input, init, url });
    try {
      const response = await tracedFetch(input, init);
      const durationMs = elapsedMs(startedAtMs, nowMs);
      const statusCode = responseStatusCode(response);
      captureReactNativeResourceSpan(client, {
        appState,
        durationMs,
        metadata: resourceMetadata(metadata, metadataFactory, {
          durationMs,
          init,
          input,
          method,
          response,
          routeTemplate: safeRouteTemplate,
          statusCode,
          url
        }),
        method,
        platform,
        routeTemplate: safeRouteTemplate,
        screen,
        sessionId,
        statusCode,
        timestamp,
        trace: activeTrace
      });
      return response;
    } catch (error) {
      const durationMs = elapsedMs(startedAtMs, nowMs);
      captureReactNativeResourceSpan(client, {
        appState,
        durationMs,
        metadata: {
          ...resourceMetadata(metadata, metadataFactory, {
            durationMs,
            error,
            init,
            input,
            method,
            routeTemplate: safeRouteTemplate,
            status: "error",
            url
          }),
          fetchErrorName: errorName(error),
          fetchErrorValueType: typeof error
        },
        method,
        platform,
        routeTemplate: safeRouteTemplate,
        screen,
        sessionId,
        status: "error",
        timestamp,
        trace: activeTrace
      });
      throw error;
    }
  };
}

export function createReactNativeGraphQLMetadataFactory({
  metadataFactory
} = {}) {
  if (metadataFactory !== undefined && typeof metadataFactory !== "function") {
    throw new SdkError("configuration_error", "metadataFactory must be a function");
  }
  return function logBrewReactNativeGraphQLMetadata(context) {
    return {
      ...safeFactoryMetadata(typeof metadataFactory === "function" ? metadataFactory(context) : undefined),
      ...graphqlMetadataFromContext(context)
    };
  };
}

function resourceMetadata(metadata, metadataFactory, context) {
  if (typeof metadataFactory !== "function") {
    return metadata;
  }
  return {
    ...metadata,
    ...safeFactoryMetadata(metadataFactory(context))
  };
}

function safeFactoryMetadata(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {};
  }
  const metadata = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (isSensitiveMetadataKey(key)) {
      continue;
    }
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      metadata[key] = value;
    }
  }
  return metadata;
}

function isSensitiveMetadataKey(key) {
  return SENSITIVE_METADATA_FACTORY_KEY_RE.test(String(key).toLowerCase());
}

function graphqlMetadataFromContext(context) {
  const payload = graphqlPayloadFromBody(requestBody(context));
  if (!payload) {
    return {};
  }
  const operation = graphqlOperationDetails(payload.query);
  const operationName = safeGraphqlOperationName(payload.operationName) ?? operation.operationName;
  const metadata = {};
  if (operationName) {
    metadata.graphqlOperationName = operationName;
  }
  if (operation.operationType) {
    metadata.graphqlOperationType = operation.operationType;
  }
  return metadata;
}

function requestBody(context) {
  const body = context?.init?.body ?? context?.input?.body;
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof String) {
    return body.toString();
  }
  return undefined;
}

function graphqlPayloadFromBody(body) {
  if (typeof body !== "string" || body.length > MAX_GRAPHQL_BODY_CHARS) {
    return undefined;
  }
  try {
    const payload = JSON.parse(body);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function graphqlOperationDetails(query) {
  if (typeof query !== "string" || query.length > MAX_GRAPHQL_BODY_CHARS) {
    return {};
  }
  const source = query.trimStart();
  if (source.startsWith("{")) {
    return { operationType: "query" };
  }
  const match = GRAPHQL_OPERATION_RE.exec(stripLeadingGraphQLComments(source));
  if (!match) {
    return {};
  }
  return {
    operationName: safeGraphqlOperationName(match[2]),
    operationType: match[1]
  };
}

function stripLeadingGraphQLComments(source) {
  return source.replace(/^(?:#[^\n\r]*(?:\r?\n|$)\s*)+/u, "").trimStart();
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

function requestMethod(input, init) {
  const method = init?.method ?? input?.method ?? "GET";
  return String(method).toUpperCase();
}

function resourceTraceContext({ randomValues, trace, traceFlags }) {
  if (typeof trace === "string") {
    return createReactNativeTraceContext({ randomValues, traceFlags, traceparent: trace });
  }
  return trace ?? getActiveLogBrewTrace() ?? createReactNativeTraceContext({ randomValues, traceFlags });
}

function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor === "function" && input instanceof URLConstructor) {
    return input.toString();
  }
  if (typeof input?.url === "string") {
    return input.url;
  }
  return String(input);
}

function defaultRouteTemplateFactory({ url }) {
  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor === "function") {
    try {
      const parsedUrl = new URLConstructor(url, "https://logbrew.local");
      return parsedUrl.pathname;
    } catch {
      // Fall back to query/hash stripping below for non-standard request keys.
    }
  }
  return String(url).split(/[?#]/u, 1)[0];
}

function elapsedMs(startedAtMs, nowMs) {
  const durationMs = nowMs() - startedAtMs;
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : undefined;
}

function responseStatusCode(response) {
  return typeof response?.status === "number" && Number.isFinite(response.status) ? response.status : undefined;
}

function errorName(error) {
  return typeof error?.name === "string" && error.name.trim() !== "" ? error.name : "Error";
}
