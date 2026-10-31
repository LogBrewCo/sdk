const { createIssueAttributesFromError } = require("@logbrew/sdk");
const {
  runtimeReactNativeDebugIdMap,
  sanitizeReactNativeIssueExceptionChain,
  sanitizeReactNativeIssueMetadata,
  sanitizeReactNativeIssueStackFrames
} = require("./metadata.cjs");
const { defaultEventId } = require("./index-random.cjs");
const { getActiveLogBrewTrace, resolveTraceContext } = require("./index-trace.cjs");
const { compactMetadata, getReactNativeContext, readField, requireClient, textOf } = require("./index-values.cjs");

/**
 * @import { IssueAttributes } from "@logbrew/sdk"
 * @import { ClientLike, ContextOptions } from "./index-values.cjs"
 * @typedef {ContextOptions & {
 *   readonly debugIdMap?: unknown,
 *   readonly evidence?: unknown,
 *   readonly environment?: unknown,
 *   readonly fingerprint?: unknown,
 *   readonly handled?: unknown,
 *   readonly id?: string | undefined,
 *   readonly idFactory?: (context: { readonly error: unknown, readonly message: string, readonly screen: string | undefined }) => string,
 *   readonly includeStack?: unknown,
 *   readonly level?: unknown,
 *   readonly mechanism?: unknown,
 *   readonly now?: () => string,
 *   readonly release?: unknown,
 *   readonly runtime?: unknown,
 *   readonly screen?: string | undefined,
 *   readonly service?: unknown,
 *   readonly timestamp?: string | undefined,
 *   readonly trace?: unknown
 * }} ErrorEventOptions
 * @typedef {{ readonly id: string, readonly timestamp: string, readonly attributes: IssueAttributes }} ErrorEvent
 * @typedef {{ readonly message: string, readonly valueType: string }} ErrorDetails
 */

/** @type {(error: unknown, options: object) => IssueAttributes} */
const createIssueAttributes = createIssueAttributesFromError;

/**
 * @returns {string}
 */
function currentTimestamp() {
  return new Date().toISOString();
}

/**
 * @returns {string}
 */
function defaultErrorEventId() {
  return defaultEventId("error");
}

/**
 * @param {unknown} error
 * @returns {unknown}
 */
function errorCandidate(error) {
  return readField(error, "reason") ?? readField(error, "error") ?? error;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error && typeof error.message === "string" && error.message.trim() !== "") {
    return error.message;
  }
  const message = readField(error, "message");
  if (typeof message === "string" && message.trim() !== "") {
    return message;
  }
  if (typeof error === "string" && error.trim() !== "") {
    return error;
  }
  return textOf(error ?? "unknown error");
}

/**
 * @param {unknown} error
 * @returns {ErrorDetails}
 */
function errorDetails(error) {
  const candidate = errorCandidate(error);
  return {
    message: errorMessage(candidate),
    valueType: candidate === null ? "null" : typeof candidate
  };
}

/**
 * @param {IssueAttributes} attributes
 * @param {string} message
 * @returns {IssueAttributes}
 */
function reactNativeIssueAttributes(attributes, message) {
  const stackFrames = sanitizeReactNativeIssueStackFrames(attributes.stackFrames);
  const exceptionChain = sanitizeReactNativeIssueExceptionChain(attributes.exceptionChain);
  return {
    ...attributes,
    ...(exceptionChain === undefined ? {} : { exceptionChain }),
    ...(stackFrames === undefined ? {} : { stackFrames }),
    title: `React Native error: ${message}`,

    message,
    metadata: sanitizeReactNativeIssueMetadata(attributes.metadata, compactMetadata, stackFrames)
  };
}

/**
 * @param {unknown} error
 * @param {ErrorEventOptions} [options]
 * @returns {ErrorEvent}
 */
function createReactNativeErrorEvent(error, {
  debugIdMap, evidence, environment, fingerprint, handled = true, id, idFactory = defaultErrorEventId,
  includeStack = false, level = "error", mechanism = "react-native.error", metadata = {}, now = currentTimestamp,
  platform, appState, release, runtime, screen, service, timestamp, trace
} = {}) {
  const details = errorDetails(error);
  const traceContext = resolveTraceContext(trace ?? getActiveLogBrewTrace());
  const attributes = createIssueAttributes(errorCandidate(error), {
    debugIdMap: debugIdMap === undefined ? runtimeReactNativeDebugIdMap() : debugIdMap,
    evidence,

    environment,
    fingerprint,
    handled,
    includeErrorStack: includeStack,
    level,
    mechanism,
    metadata: {
      ...getReactNativeContext({ appState, platform }),
      errorValueType: details.valueType,
      screen,
      ...metadata
    },
    release,
    runtime,
    service,
    source: "react-native.error",
    trace: traceContext
  });
  return {
    id: id ?? idFactory({ error, message: details.message, screen }),
    timestamp: timestamp ?? now(),

    attributes: reactNativeIssueAttributes(attributes, details.message)
  };
}

/**
 * @param {ClientLike} client
 * @param {unknown} error
 * @param {ErrorEventOptions} [options]
 * @returns {ErrorEvent}
 */
function captureReactNativeError(client, error, options = {}) {
  requireClient(client);
  const event = createReactNativeErrorEvent(error, options);
  client.issue(event.id, event.timestamp, event.attributes);
  return event;
}

module.exports = { captureReactNativeError, createReactNativeErrorEvent };
