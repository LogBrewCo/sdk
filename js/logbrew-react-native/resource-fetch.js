import {
  SdkError
} from "@logbrew/sdk";
import {
  captureReactNativeResourceSpan,
  createReactNativeTraceContext,
  createTraceparentFetch,
  getActiveLogBrewTrace
} from "./index.js";
import {
  createSafeReactNativeMetadata,
  safeReactNativeMetadataFactoryResult
} from "./metadata.js";

const MAX_GRAPHQL_BODY_CHARS = 16_384;
const MAX_GRAPHQL_OPERATION_NAME_CHARS = 128;
const GRAPHQL_OPERATION_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/u;
const GRAPHQL_OPERATION_RE = /^(query|mutation|subscription)\b(?:\s+([_A-Za-z][_0-9A-Za-z]*))?/u;

export function createReactNativeResourceFetch(client, {
  appState,
  fetchImpl,
  metadata = {},
  metadataFactory,
  measureResponseBodySize = false,
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
      const responseSizeBytes = await responseSizeBytesFromResponse(response, { measureResponseBodySize });
      captureReactNativeResourceSpan(client, {
        appState,
        durationMs,
        metadata: createSafeReactNativeMetadata(metadata, metadataFactory, {
          durationMs,
          init,
          input,
          method,
          response,
          responseSizeBytes,
          routeTemplate: safeRouteTemplate,
          statusCode,
          url
        }),
        method,
        platform,
        routeTemplate: safeRouteTemplate,
        screen,
        sessionId,
        responseSizeBytes,
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
          ...createSafeReactNativeMetadata(metadata, metadataFactory, {
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
  endpoint,
  metadataFactory
} = {}) {
  const endpointMatchers = normalizeGraphQLEndpointMatchers(endpoint);
  if (metadataFactory !== undefined && typeof metadataFactory !== "function") {
    throw new SdkError("configuration_error", "metadataFactory must be a function");
  }
  return function logBrewReactNativeGraphQLMetadata(context) {
    const safeMetadata = safeReactNativeMetadataFactoryResult(typeof metadataFactory === "function" ? metadataFactory(context) : undefined);
    if (endpointMatchers.length > 0 && !matchesGraphQLEndpoint(context, endpointMatchers)) {
      return safeMetadata;
    }
    return {
      ...safeMetadata,
      ...graphqlMetadataFromContext(context)
    };
  };
}

function normalizeGraphQLEndpointMatchers(endpoint) {
  if (endpoint === undefined) {
    return [];
  }
  const endpoints = Array.isArray(endpoint) ? endpoint : [endpoint];
  return endpoints.map((candidate) => {
    if (typeof candidate === "string" || candidate instanceof String) {
      const value = normalizeEndpointString(candidate.toString());
      if (value === "") {
        throw new SdkError("configuration_error", "GraphQL endpoint strings must not be empty");
      }
      return value;
    }
    if (candidate instanceof RegExp || typeof candidate === "function") {
      return candidate;
    }
    throw new SdkError("configuration_error", "GraphQL endpoint must be a string, RegExp, function, or array");
  });
}

function matchesGraphQLEndpoint(context, endpointMatchers) {
  const candidates = graphqlEndpointCandidates(context);
  return endpointMatchers.some((matcher) => {
    if (typeof matcher === "string") {
      return candidates.includes(matcher);
    }
    if (matcher instanceof RegExp) {
      return candidates.some((candidate) => endpointRegExpMatches(matcher, candidate));
    }
    return matcher(context) === true;
  });
}

function endpointRegExpMatches(matcher, candidate) {
  matcher.lastIndex = 0;
  const matched = matcher.test(candidate);
  matcher.lastIndex = 0;
  return matched;
}

function graphqlEndpointCandidates(context) {
  const candidates = new Set();
  if (typeof context?.routeTemplate === "string" && context.routeTemplate.trim() !== "") {
    candidates.add(context.routeTemplate);
  }
  for (const candidate of endpointCandidatesFromUrl(context?.url)) {
    candidates.add(candidate);
  }
  return Array.from(candidates);
}

function normalizeEndpointString(endpoint) {
  const value = endpoint.trim();
  const candidates = endpointCandidatesFromUrl(value);
  return candidates[candidates.length - 1] ?? value.split(/[?#]/u, 1)[0];
}

function endpointCandidatesFromUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }
  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor === "function") {
    try {
      const parsedUrl = new URLConstructor(value, "https://logbrew.local");
      const candidates = [parsedUrl.pathname];
      if (/^https?:\/\//iu.test(value)) {
        candidates.push(`${parsedUrl.origin}${parsedUrl.pathname}`);
      }
      return candidates;
    } catch {
      // Fall back to query/hash stripping below for non-standard request keys.
    }
  }
  return [value.split(/[?#]/u, 1)[0]];
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

async function responseSizeBytesFromResponse(response, { measureResponseBodySize = false } = {}) {
  const contentLength = responseContentLengthBytes(response);
  if (contentLength !== undefined) {
    return contentLength;
  }
  return measureResponseBodySize ? clonedResponseBodySizeBytes(response) : undefined;
}

function responseContentLengthBytes(response) {
  const header = responseHeader(response, "Content-Length");
  const value = Number.parseInt(String(header ?? ""), 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get !== "function") {
    return undefined;
  }
  try {
    return response.headers.get(name) ?? response.headers.get(name.toLowerCase()) ?? undefined;
  } catch {
    return undefined;
  }
}

async function clonedResponseBodySizeBytes(response) {
  if (typeof response?.clone !== "function") {
    return undefined;
  }
  let clonedResponse;
  try {
    clonedResponse = response.clone();
  } catch {
    return undefined;
  }
  return responseBodySizeBytes(clonedResponse);
}

async function responseBodySizeBytes(response) {
  const arrayBufferSize = await responseArrayBufferSizeBytes(response);
  if (arrayBufferSize !== undefined) {
    return arrayBufferSize;
  }
  const blobSize = await responseBlobSizeBytes(response);
  if (blobSize !== undefined) {
    return blobSize;
  }
  return responseTextSizeBytes(response);
}

async function responseArrayBufferSizeBytes(response) {
  if (typeof response?.arrayBuffer !== "function") {
    return undefined;
  }
  try {
    return binaryByteLength(await response.arrayBuffer());
  } catch {
    return undefined;
  }
}

async function responseBlobSizeBytes(response) {
  if (typeof response?.blob !== "function") {
    return undefined;
  }
  try {
    const blob = await response.blob();
    return typeof blob?.size === "number" && Number.isFinite(blob.size) && blob.size >= 0 ? blob.size : undefined;
  } catch {
    return undefined;
  }
}

async function responseTextSizeBytes(response) {
  if (typeof response?.text !== "function") {
    return undefined;
  }
  try {
    const text = await response.text();
    return typeof text === "string" || text instanceof String ? utf8ByteLength(text.toString()) : undefined;
  } catch {
    return undefined;
  }
}

function binaryByteLength(value) {
  if (typeof value?.byteLength === "number" && Number.isFinite(value.byteLength) && value.byteLength >= 0) {
    return value.byteLength;
  }
  return undefined;
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function errorName(error) {
  return typeof error?.name === "string" && error.name.trim() !== "" ? error.name : "Error";
}
