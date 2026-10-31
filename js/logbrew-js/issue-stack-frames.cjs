"use strict";

const { SdkError } = require("./sdk-error.cjs");
const { isRecord } = require("./validation.cjs");
const {
  SAFE_DEBUG_ID_PATTERN,
  frameCoordinateFromText,
  frameIdentity,
  hasControlCharacter,
  sanitizeFrameFilename
} = require("./issue-stack-text.cjs");

/**
 * @import { IssueStackFrame, NativeStackArchitecture, NativeStackFrame } from "./index.cjs"
 */

const MAX_ISSUE_STACK_FRAMES = 32;
const MAX_ISSUE_STACK_FUNCTION_LENGTH = 256;
const MAX_ISSUE_STACK_MODULE_LENGTH = 512;
const MAX_ISSUE_STACK_FILENAME_LENGTH = 2048;
const MAX_FRAME_COORDINATE = 2_147_483_647;
const NATIVE_FRAME_KEY_COUNT = 3;
const NO_FRAMES = 0;
const NATIVE_FRAME_KEYS = new Set(["imageUuid", "architecture", "instructionOffset"]);
const NATIVE_IMAGE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NATIVE_OFFSET_PATTERN = /^[0-9a-f]{16}$/u;
/** @type {ReadonlySet<string>} */
const NATIVE_ARCHITECTURES = new Set(["arm", "arm64", "arm64e", "x86", "x86_64"]);

/**
 * @param {unknown} value
 * @returns {value is NativeStackArchitecture}
 */
function isNativeArchitecture(value) {
  return typeof value === "string" && NATIVE_ARCHITECTURES.has(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function requireFrameFilename(value) {
  if (typeof value !== "string") {
    throw new SdkError("validation_error", "issue stack frame filename is invalid");
  }
  const filename = sanitizeFrameFilename(value);
  if (filename === "" || filename.length > MAX_ISSUE_STACK_FILENAME_LENGTH || hasControlCharacter(filename)) {
    throw new SdkError("validation_error", "issue stack frame filename is invalid");
  }
  return filename;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function boundedFrameCoordinate(value) {
  const coordinate = frameCoordinateFromText(value);
  return coordinate !== undefined && coordinate <= MAX_FRAME_COORDINATE ? coordinate : undefined;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalFrameDebugId(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !SAFE_DEBUG_ID_PATTERN.test(value.trim())) {
    throw new SdkError("validation_error", "issue stack frame debugId is invalid");
  }
  return value.trim().toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalFrameFunction(value) {
  if (value === undefined) {
    return undefined;
  }
  const functionName = typeof value === "string" ? frameIdentity(value, MAX_ISSUE_STACK_FUNCTION_LENGTH, false) : undefined;
  if (functionName === undefined) {
    throw new SdkError("validation_error", "issue stack frame function is invalid");
  }
  return functionName;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalFrameModule(value) {
  if (value === undefined) {
    return undefined;
  }
  const moduleName = typeof value === "string" ? frameIdentity(value, MAX_ISSUE_STACK_MODULE_LENGTH, true) : undefined;
  if (moduleName === undefined) {
    throw new SdkError("validation_error", "issue stack frame module is invalid");
  }
  return moduleName;
}

/**
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
function optionalFrameInApp(value) {
  if (value === undefined || typeof value === "boolean") {
    return value;
  }
  throw new SdkError("validation_error", "issue stack frame inApp is invalid");
}

/**
 * @param {Readonly<Record<string, unknown>>} frame
 * @returns {Pick<IssueStackFrame, "debugId" | "function" | "inApp" | "module">}
 */
function optionalFrameFields(frame) {
  const debugId = optionalFrameDebugId(frame["debugId"]);
  const functionName = optionalFrameFunction(frame["function"]);
  const moduleName = optionalFrameModule(frame["module"]);
  const inApp = optionalFrameInApp(frame["inApp"]);
  return {
    ...(functionName === undefined ? {} : { function: functionName }),
    ...(moduleName === undefined ? {} : { module: moduleName }),
    ...(inApp === undefined ? {} : { inApp }),
    ...(debugId === undefined ? {} : { debugId })
  };
}

/**
 * @param {unknown} frame
 * @returns {IssueStackFrame}
 */
function validateIssueStackFrame(frame) {
  if (!isRecord(frame)) {
    throw new SdkError("validation_error", "issue stack frame must be an object");
  }
  const filename = requireFrameFilename(frame["filename"]);
  const line = boundedFrameCoordinate(frame["line"]);
  const column = boundedFrameCoordinate(frame["column"]);
  if (line === undefined || column === undefined) {
    throw new SdkError("validation_error", "issue stack frame coordinates must be positive integers");
  }
  return {
    filename,
    line,

    column,
    ...optionalFrameFields(frame)
  };
}

/**
 * @param {unknown} stackFrames
 * @returns {IssueStackFrame[] | undefined}
 */
function validateIssueStackFrames(stackFrames) {
  if (stackFrames === undefined) {
    return undefined;
  }
  if (!Array.isArray(stackFrames) || stackFrames.length === NO_FRAMES || stackFrames.length > MAX_ISSUE_STACK_FRAMES) {
    throw new SdkError("validation_error", `issue stackFrames must contain 1-${MAX_ISSUE_STACK_FRAMES} frames`);
  }
  /** @type {readonly unknown[]} */
  const frames = stackFrames;
  return frames.map((frame) => validateIssueStackFrame(frame));
}

/**
 * @param {unknown} frame
 * @returns {NativeStackFrame}
 */
function validateNativeStackFrame(frame) {
  const keys = isRecord(frame) ? Object.keys(frame) : [];
  if (
    !isRecord(frame)
    || keys.length !== NATIVE_FRAME_KEY_COUNT
    || !keys.every((key) => NATIVE_FRAME_KEYS.has(key))
  ) {
    throw new SdkError("validation_error", "issue native stack frame is invalid");
  }
  const { architecture, imageUuid, instructionOffset } = frame;
  if (
    typeof imageUuid !== "string"
    || !NATIVE_IMAGE_UUID_PATTERN.test(imageUuid)
    || !isNativeArchitecture(architecture)
    || typeof instructionOffset !== "string"
    || !NATIVE_OFFSET_PATTERN.test(instructionOffset)
  ) {
    throw new SdkError("validation_error", "issue native stack frame is invalid");
  }
  return {
    imageUuid,

    architecture,
    instructionOffset
  };
}

/**
 * @param {unknown} frames
 * @returns {NativeStackFrame[] | undefined}
 */
function validateNativeStackFrames(frames) {
  if (frames === undefined) {
    return undefined;
  }
  if (!Array.isArray(frames) || frames.length === NO_FRAMES || frames.length > MAX_ISSUE_STACK_FRAMES) {
    throw new SdkError("validation_error", `issue nativeStackFrames must contain 1-${MAX_ISSUE_STACK_FRAMES} frames`);
  }
  /** @type {readonly unknown[]} */
  const list = frames;
  return list.map((frame) => validateNativeStackFrame(frame));
}

module.exports = { validateIssueStackFrames, validateNativeStackFrames };
