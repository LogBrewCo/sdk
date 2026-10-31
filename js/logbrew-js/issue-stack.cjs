"use strict";

const { SdkError } = require("./sdk-error.cjs");
const { isRecord } = require("./validation.cjs");
const {
  SAFE_DEBUG_ID_PATTERN,
  basename,
  frameCoordinateFromText,
  frameIdentity,
  sanitizeFrameFilename
} = require("./issue-stack-text.cjs");
const { validateIssueStackFrames, validateNativeStackFrames } = require("./issue-stack-frames.cjs");

/**
 * @import { IssueStackFrame } from "./index.cjs"
 * @typedef {{ frames: IssueStackFrame[], truncated: boolean }} StackEvidence
 * @typedef {readonly (readonly [string, unknown])[]} DebugIdEntries
 * @typedef {{ functionName: string | undefined, location: string }} FrameLocation
 * @typedef {{ readonly debugId: string, readonly path: string }} DebugIdCandidate
 */

const MAX_ISSUE_STACK_FRAMES = 32;
const MAX_ISSUE_STACK_FUNCTION_LENGTH = 256;
const MAX_RUNTIME_DEBUG_IDS = 512;
const MIN_FRAME_LOCATION_PARTS = 3;
const NO_OFFSET = 0;
const HERMES_BYTECODE_OFFSET = 1;
const HERMES_BYTECODE_LINE = 1;
const UNIQUE_MATCH = 1;
const TEXT_START = 0;
const MARKER_WIDTH = 1;
const LAST_CHARACTER = -1;
const CHROME_FRAME_PREFIX = "at ";
const HERMES_BYTECODE_PREFIX = "address at ";
const LINE_BREAK_PATTERN = /\r?\n/u;
const LEADING_SLASHES_PATTERN = /^\/+/u;
const DEBUG_ID_REGISTRY = Symbol.for("logbrew.release-artifact.debug-ids");

/**
 * @param {string} value
 * @returns {string | undefined}
 */
function generatedFrameFunction(value) {
  const functionName = frameIdentity(value, MAX_ISSUE_STACK_FUNCTION_LENGTH, false);
  if (
    functionName === undefined
    || functionName.includes("@")
    || functionName.includes("/")
    || functionName.includes("\\")
    || functionName.includes("?")
    || functionName.includes("#")
  ) {
    return undefined;
  }
  return functionName;
}

/**
 * @param {string} line
 * @returns {FrameLocation}
 */
function splitFrameFunction(line) {
  if (line.startsWith(CHROME_FRAME_PREFIX)) {
    const location = line.slice(CHROME_FRAME_PREFIX.length).trim();
    if (!location.endsWith(")") || !location.includes("(")) {
      return { functionName: undefined, location };
    }
    const marker = location.lastIndexOf("(");
    return {
      functionName: generatedFrameFunction(location.slice(TEXT_START, marker)),
      location: location.slice(marker + MARKER_WIDTH, LAST_CHARACTER)
    };
  }
  if (!line.includes("@")) {
    return { functionName: undefined, location: line };
  }
  const marker = line.lastIndexOf("@");
  return {
    functionName: generatedFrameFunction(line.slice(TEXT_START, marker)),
    location: line.slice(marker + MARKER_WIDTH)
  };
}

/**
 * @param {string} location
 * @param {boolean} hermesBytecode
 * @returns {Omit<IssueStackFrame, "function"> | undefined}
 */
function frameCoordinates(location, hermesBytecode) {
  const parts = location.split(":");
  if (parts.length < MIN_FRAME_LOCATION_PARTS) {
    return undefined;
  }
  const rawColumn = parts.pop();
  const lineNumber = frameCoordinateFromText(parts.pop());
  const column = frameCoordinateFromText(
    rawColumn,
    hermesBytecode && lineNumber === HERMES_BYTECODE_LINE ? HERMES_BYTECODE_OFFSET : NO_OFFSET
  );
  const filename = sanitizeFrameFilename(parts.join(":"));
  if (filename === "" || lineNumber === undefined || column === undefined) {
    return undefined;
  }
  return { column, filename, line: lineNumber };
}

/**
 * @param {string} rawLine
 * @returns {IssueStackFrame | undefined}
 */
function parseJavaScriptStackFrame(rawLine) {
  const line = rawLine.trim();
  if (line === "") {
    return undefined;
  }
  const { functionName, location } = splitFrameFunction(line);
  const hermesBytecode = location.startsWith(HERMES_BYTECODE_PREFIX);
  const coordinates = frameCoordinates(
    hermesBytecode ? location.slice(HERMES_BYTECODE_PREFIX.length) : location,
    hermesBytecode
  );
  if (coordinates === undefined) {
    return undefined;
  }
  return functionName === undefined ? coordinates : { ...coordinates, function: functionName };
}

/**
 * @param {string} filename
 * @param {string} candidate
 * @returns {boolean}
 */
function matchesFramePath(filename, candidate) {
  return filename === candidate
    || (candidate.includes("/") && filename.endsWith(`/${candidate.replace(LEADING_SLASHES_PATTERN, "")}`));
}

/**
 * @param {string} filename
 * @param {DebugIdEntries} entries
 * @returns {string | undefined}
 */
function debugIdFromEntries(filename, entries) {
  const normalizedFilename = sanitizeFrameFilename(filename);
  const frameBasename = basename(normalizedFilename);
  /** @type {readonly DebugIdCandidate[]} */
  const candidates = entries.flatMap(([candidate, debugId]) =>
    typeof debugId === "string" && SAFE_DEBUG_ID_PATTERN.test(debugId.trim())
      ? [{ debugId: debugId.trim().toLowerCase(), path: sanitizeFrameFilename(candidate) }]
      : []);
  const exact = candidates.find((candidate) => matchesFramePath(normalizedFilename, candidate.path));
  if (exact !== undefined) {
    return exact.debugId;
  }
  const basenameIds = new Set(
    candidates.filter((candidate) => basename(candidate.path) === frameBasename).map((candidate) => candidate.debugId)
  );
  const [onlyId] = basenameIds;
  return basenameIds.size === UNIQUE_MATCH ? onlyId : undefined;
}

/**
 * @returns {DebugIdEntries}
 */
function runtimeDebugIdEntries() {
  try {
    /** @type {unknown} */
    const registry = Object.getOwnPropertyDescriptor(globalThis, DEBUG_ID_REGISTRY)?.value;
    if (!isRecord(registry)) {
      return [];
    }
    return Object.getOwnPropertyNames(registry)
      .slice(TEXT_START, MAX_RUNTIME_DEBUG_IDS)
      .flatMap((candidate) => {
        const descriptor = Object.getOwnPropertyDescriptor(registry, candidate);
        /** @type {unknown} */
        const value = descriptor?.value;
        return descriptor !== undefined && "value" in descriptor ? [[candidate, value]] : [];
      });
  } catch {
    return [];
  }
}

/**
 * @param {string} filename
 * @param {unknown} debugIdMap
 * @returns {string | undefined}
 */
function debugIdForFrame(filename, debugIdMap) {
  if (debugIdMap === undefined || debugIdMap === null) {
    return debugIdFromEntries(filename, runtimeDebugIdEntries());
  }
  if (!isRecord(debugIdMap)) {
    throw new SdkError("validation_error", "debugIdMap must be an object");
  }
  return debugIdFromEntries(filename, Object.entries(debugIdMap))
    ?? debugIdFromEntries(filename, runtimeDebugIdEntries());
}

/**
 * @param {Readonly<IssueStackFrame>} frame
 * @param {unknown} debugIdMap
 * @returns {IssueStackFrame}
 */
function withDebugId(frame, debugIdMap) {
  const debugId = debugIdForFrame(frame.filename, debugIdMap);
  return debugId === undefined ? frame : { ...frame, debugId };
}

/**
 * @param {unknown} stack
 * @param {unknown} debugIdMap
 * @returns {StackEvidence}
 */
function javascriptStackEvidence(stack, debugIdMap) {
  if (typeof stack !== "string" || stack.trim() === "") {
    return { frames: [], truncated: false };
  }
  /** @type {IssueStackFrame[]} */
  const frames = [];
  for (const rawLine of stack.split(LINE_BREAK_PATTERN)) {
    const parsed = parseJavaScriptStackFrame(rawLine);
    if (parsed !== undefined) {
      if (frames.length === MAX_ISSUE_STACK_FRAMES) {
        return { frames, truncated: true };
      }
      frames.push(withDebugId(parsed, debugIdMap));
    }
  }
  return { frames, truncated: false };
}

module.exports = { javascriptStackEvidence, validateIssueStackFrames, validateNativeStackFrames };
