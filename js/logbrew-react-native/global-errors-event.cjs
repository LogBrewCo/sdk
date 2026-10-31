"use strict";

const { createReactNativeErrorEvent } = require("./index.cjs");
const { incrementBounded, safeReadProperty } = require("./global-errors-support.cjs");

/**
 * @import { IssueExceptionChain, IssueStackFrame, Metadata } from "@logbrew/sdk"
 * @import { ReactNativeErrorEvent } from "./index.cjs"
 */

/**
 * @template Value
 * @typedef {Value extends readonly (infer Item)[]
 *   ? readonly DeepReadonly<Item>[]
 *   : Value extends object ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> } : Value} DeepReadonly
 */

const AUTOMATIC_ERROR_MESSAGE = "React Native global JavaScript report";
const MAX_STACK_BYTES = 16_384;
const FIRST_INDEX = 0;
const NO_FRAMES = 0;
const ID_RADIX = 36;
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError"
]);
const LAST_ROUTE = Symbol.for("co.logbrew.react-native.last-route");
const LINE_BREAK_PATTERN = /\r?\n/u;
const DIRECTORY_PREFIX_PATTERN = /^.*[\\/]/u;
const GROUPING_PATH_PATTERN = /^(?<prefix>[^:]+:[^:]+:).*[\\/]/u;
const sequence = { next: FIRST_INDEX };

/** @type {(value: unknown) => boolean} */
const isTruthy = Boolean;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isSafeErrorName(value) {
  return typeof value === "string" && SAFE_ERROR_NAMES.has(value);
}

/**
 * @param {string} kind
 * @returns {string}
 */
function nextEventId(kind) {
  sequence.next = incrementBounded(sequence.next);
  return `evt_rn_${kind}_${Date.now().toString(ID_RADIX)}_${sequence.next.toString(ID_RADIX)}`;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function automaticStack(error) {
  const stack = safeReadProperty(error, "stack");
  if (typeof stack !== "string") {
    return "";
  }
  const lines = stack.slice(FIRST_INDEX, MAX_STACK_BYTES).split(LINE_BREAK_PATTERN);
  const frames = lines.filter((line) => line.trimStart().startsWith("at "));
  return (frames.length > NO_FRAMES ? frames : lines).join("\n");
}

/**
 * @template Value
 * @param {Value} value
 * @returns {Value | string}
 */
function basename(value) {
  return typeof value === "string" ? value.replace(DIRECTORY_PREFIX_PATTERN, "") : value;
}

/**
 * @param {DeepReadonly<IssueStackFrame[]>} frames
 * @returns {DeepReadonly<IssueStackFrame[]>}
 */
function basenameFrames(frames) {
  return frames.map((frame) => ({ ...frame, filename: basename(frame.filename) }));
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function safeErrorName(error) {
  const name = safeReadProperty(error, "name");
  const candidate = typeof name === "string" ? name : "Error";
  return SAFE_ERROR_NAMES.has(candidate) ? candidate : "Error";
}

/**
 * @param {DeepReadonly<IssueExceptionChain>} exceptionChain
 * @returns {DeepReadonly<IssueExceptionChain>}
 */
function basenameExceptionChain(exceptionChain) {
  return {
    ...exceptionChain,
    entries: exceptionChain.entries.map((entry) => ({
      ...entry,
      ...(entry.stackFrames ? { stackFrames: basenameFrames(entry.stackFrames) } : {})
    }))
  };
}

/**
 * @param {Readonly<Metadata>} metadata
 * @param {unknown} lastRoute
 * @param {boolean} fatal
 * @returns {Metadata}
 */
function automaticMetadata(metadata, lastRoute, fatal) {
  const { errorFrameFile, issueGroupingKey, releaseArtifactCodeFile } = metadata;
  return {
    ...metadata,
    ...(isTruthy(errorFrameFile) ? { errorFrameFile: basename(errorFrameFile) } : {}),
    ...(isTruthy(releaseArtifactCodeFile)
      ? { releaseArtifactCodeFile: basename(releaseArtifactCodeFile) }
      : {}),
    ...(typeof issueGroupingKey === "string"
      ? { issueGroupingKey: issueGroupingKey.replace(GROUPING_PATH_PATTERN, "$<prefix>") }
      : {}),
    automatic: true,
    fatal,
    handled: !fatal,
    ...(typeof lastRoute === "string" ? { lastRoute } : {}),
    mechanism: "react_native_error_utils",
    source: "react-native.global_error"
  };
}

/**
 * @param {unknown} error
 * @param {unknown} client
 * @param {boolean} [fatal]
 * @returns {DeepReadonly<ReactNativeErrorEvent>}
 */
function createAutomaticErrorEvent(error, client, fatal = false) {
  const sanitizedError = new Error(AUTOMATIC_ERROR_MESSAGE);
  sanitizedError.name = safeErrorName(error);
  sanitizedError.stack = automaticStack(error);
  const lastRoute = safeReadProperty(client, LAST_ROUTE);
  const event = createReactNativeErrorEvent(sanitizedError, {
    handled: false,
    id: nextEventId(fatal ? "fatal" : "global"),
    includeStack: false,
    level: fatal ? "fatal" : "error",
    mechanism: "react_native_error_utils"
  });
  const { exceptionChain, metadata, stackFrames } = event.attributes;
  if (exceptionChain === undefined || metadata === undefined) {
    throw new TypeError("React Native error event has no exception chain or metadata");
  }
  return {
    ...event,
    attributes: {
      ...event.attributes,
      exceptionChain: basenameExceptionChain(exceptionChain),
      ...(stackFrames ? { stackFrames: basenameFrames(stackFrames) } : {}),
      message: AUTOMATIC_ERROR_MESSAGE,
      metadata: automaticMetadata(metadata, lastRoute, fatal),
      title: AUTOMATIC_ERROR_MESSAGE
    }
  };
}

module.exports = { createAutomaticErrorEvent, isSafeErrorName };
