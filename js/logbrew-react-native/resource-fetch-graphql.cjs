"use strict";

const { SdkError } = require("@logbrew/sdk");
const {
  isCallable,
  metadataRuntime,
  parseUrl,
  readField,
  stringValue,
  stripQueryAndHash
} = require("./instrumentation-values.cjs");

/**
 * @import { Metadata } from "@logbrew/sdk"
 * @import { Callable } from "./instrumentation-values.cjs"
 */

/**
 * @typedef {string | RegExp | Callable} EndpointMatcher
 * @typedef {{ readonly operationName?: string | undefined, readonly operationType?: string | undefined }} OperationDetails
 * @typedef {{ readonly endpoint?: unknown, readonly metadataFactory?: unknown }} GraphQLMetadataFactoryOptions
 */

const MAX_GRAPHQL_BODY_CHARS = 16_384;
const MAX_GRAPHQL_OPERATION_NAME_CHARS = 128;
const EMPTY_LENGTH = 0;
const FIRST_MATCH = 0;
const LAST_CANDIDATE = -1;
const GRAPHQL_OPERATION_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/u;
const GRAPHQL_OPERATION_RE = /^(?<type>query|mutation|subscription)\b(?:\s+(?<name>[_A-Za-z][_0-9A-Za-z]*))?/u;
const LEADING_GRAPHQL_COMMENTS_RE = /^(?:#[^\n\r]*(?:\r?\n|$)\s*)+/u;
const ABSOLUTE_HTTP_URL_RE = /^https?:\/\//iu;

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function endpointCandidatesFromUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }
  const parsedUrl = parseUrl(value);
  if (parsedUrl === undefined) {
    return [stripQueryAndHash(value)];
  }
  const candidates = [parsedUrl.pathname];
  if (ABSOLUTE_HTTP_URL_RE.test(value)) {
    candidates.push(`${parsedUrl.origin}${parsedUrl.pathname}`);
  }
  return candidates;
}

/**
 * @param {string} endpoint
 * @returns {string}
 */
function normalizeEndpointString(endpoint) {
  const value = endpoint.trim();
  const candidates = endpointCandidatesFromUrl(value);
  return candidates.at(LAST_CANDIDATE) ?? stripQueryAndHash(value);
}

/**
 * @param {unknown} candidate
 * @returns {EndpointMatcher}
 */
function normalizeGraphQLEndpointMatcher(candidate) {
  const text = stringValue(candidate);
  if (text !== undefined) {
    const value = normalizeEndpointString(text);
    if (value === "") {
      throw new SdkError("configuration_error", "GraphQL endpoint strings must not be empty");
    }
    return value;
  }
  if (candidate instanceof RegExp || isCallable(candidate)) {
    return candidate;
  }
  throw new SdkError("configuration_error", "GraphQL endpoint must be a string, RegExp, function, or array");
}

/**
 * @param {unknown} endpoint
 * @returns {EndpointMatcher[]}
 */
function normalizeGraphQLEndpointMatchers(endpoint) {
  if (endpoint === undefined) {
    return [];
  }
  const endpoints = Array.isArray(endpoint) ? endpoint : [endpoint];
  return endpoints.map(candidate => normalizeGraphQLEndpointMatcher(candidate));
}

/**
 * @param {RegExp} matcher
 * @param {string} candidate
 * @returns {boolean}
 */
function endpointRegExpMatches(matcher, candidate) {
  matcher.lastIndex = FIRST_MATCH;
  const matched = matcher.test(candidate);
  matcher.lastIndex = FIRST_MATCH;
  return matched;
}

/**
 * @param {unknown} context
 * @returns {string[]}
 */
function graphqlEndpointCandidates(context) {
  /** @type {Set<string>} */
  const candidates = new Set();
  const routeTemplate = readField(context, "routeTemplate");
  if (typeof routeTemplate === "string" && routeTemplate.trim() !== "") {
    candidates.add(routeTemplate);
  }
  for (const candidate of endpointCandidatesFromUrl(readField(context, "url"))) {
    candidates.add(candidate);
  }
  return [...candidates];
}

/**
 * @param {unknown} context
 * @param {readonly EndpointMatcher[]} endpointMatchers
 * @returns {boolean}
 */
function matchesGraphQLEndpoint(context, endpointMatchers) {
  const candidates = graphqlEndpointCandidates(context);
  return endpointMatchers.some(matcher => {
    if (typeof matcher === "string") {
      return candidates.includes(matcher);
    }
    if (matcher instanceof RegExp) {
      return candidates.some(candidate => endpointRegExpMatches(matcher, candidate));
    }
    return matcher(context) === true;
  });
}

/**
 * @param {unknown} context
 * @returns {string | undefined}
 */
function requestBody(context) {
  const body = readField(readField(context, "init"), "body") ?? readField(readField(context, "input"), "body");
  return stringValue(body);
}

/**
 * @param {string | undefined} body
 * @returns {unknown}
 */
function graphqlPayloadFromBody(body) {
  if (typeof body !== "string" || body.length > MAX_GRAPHQL_BODY_CHARS) {
    return undefined;
  }
  try {
    /** @type {unknown} */
    const payload = JSON.parse(body);
    return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
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
 * @param {unknown} query
 * @returns {OperationDetails}
 */
function graphqlOperationDetails(query) {
  if (typeof query !== "string" || query.length > MAX_GRAPHQL_BODY_CHARS) {
    return {};
  }
  const source = query.trimStart();
  if (source.startsWith("{")) {
    return { operationType: "query" };
  }
  const match = GRAPHQL_OPERATION_RE.exec(source.replace(LEADING_GRAPHQL_COMMENTS_RE, "").trimStart());
  if (!match) {
    return {};
  }
  return {
    operationName: safeGraphqlOperationName(match.groups?.["name"]),
    operationType: match.groups?.["type"]
  };
}

/**
 * @param {string | undefined} operationName
 * @param {string | undefined} operationType
 * @returns {Metadata}
 */
function operationMetadata(operationName, operationType) {
  /** @type {Metadata} */
  const metadata = {};
  if (operationName !== undefined) {
    metadata["graphqlOperationName"] = operationName;
  }
  if (operationType !== undefined) {
    metadata["graphqlOperationType"] = operationType;
  }
  return metadata;
}

/**
 * @param {unknown} context
 * @returns {Metadata}
 */
function graphqlMetadataFromContext(context) {
  const payload = graphqlPayloadFromBody(requestBody(context));
  if (payload === undefined) {
    return {};
  }
  const operation = graphqlOperationDetails(readField(payload, "query"));
  return operationMetadata(
    safeGraphqlOperationName(readField(payload, "operationName")) ?? operation.operationName,
    operation.operationType
  );
}

/**
 * @param {GraphQLMetadataFactoryOptions} [options]
 * @returns {(context: unknown) => Metadata}
 */
function createReactNativeGraphQLMetadataFactory({
  endpoint,
  metadataFactory
} = {}) {
  const endpointMatchers = normalizeGraphQLEndpointMatchers(endpoint);
  if (metadataFactory !== undefined && typeof metadataFactory !== "function") {
    throw new SdkError("configuration_error", "metadataFactory must be a function");
  }
  return function logBrewReactNativeGraphQLMetadata(context) {
    const safeMetadata = metadataRuntime.safeReactNativeMetadataFactoryResult(isCallable(metadataFactory) ? metadataFactory(context) : undefined);
    if (endpointMatchers.length > EMPTY_LENGTH && !matchesGraphQLEndpoint(context, endpointMatchers)) {
      return safeMetadata;
    }
    return {
      ...safeMetadata,
      ...graphqlMetadataFromContext(context)
    };
  };
}

module.exports = { createReactNativeGraphQLMetadataFactory };
