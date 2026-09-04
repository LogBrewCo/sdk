"use strict";

const MAX_ISSUE_STACK_FRAMES = 32;
const MAX_ISSUE_STACK_FUNCTION_LENGTH = 256;
const MAX_ISSUE_STACK_MODULE_LENGTH = 512;
const SAFE_DEBUG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const NATIVE_IMAGE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NATIVE_OFFSET_PATTERN = /^[0-9a-f]{16}$/u;
const NATIVE_ARCHITECTURES = new Set(["arm", "arm64", "arm64e", "x86", "x86_64"]);
const LOCAL_ABSOLUTE_PATH_PATTERN = /(?:^|\s)(?:\/(?:Users|home|private|tmp|var|Volumes)\/|[A-Za-z]:[\\/])/u;
const DEBUG_ID_REGISTRY = Symbol.for("logbrew.release-artifact.debug-ids");

function buildIssueStackHelpers({ SdkError }) {
  function javascriptStackEvidence(stack, debugIdMap) {
    if (typeof stack !== "string" || stack.trim() === "") {
      return { frames: [], truncated: false };
    }
    const frames = [];
    let truncated = false;
    for (const rawLine of stack.split(/\r?\n/u)) {
      const parsed = parseJavaScriptStackFrame(rawLine);
      if (parsed) {
        if (frames.length === MAX_ISSUE_STACK_FRAMES) {
          truncated = true;
          break;
        }
        const debugId = debugIdForFrame(parsed.filename, debugIdMap, SdkError);
        frames.push({ ...parsed, ...(debugId ? { debugId } : {}) });
      }
    }
    return { frames, truncated };
  }

  function validateIssueStackFrames(stackFrames) {
    if (stackFrames === undefined) {
      return undefined;
    }
    if (!Array.isArray(stackFrames) || stackFrames.length === 0 || stackFrames.length > MAX_ISSUE_STACK_FRAMES) {
      throw new SdkError("validation_error", `issue stackFrames must contain 1-${MAX_ISSUE_STACK_FRAMES} frames`);
    }
    return stackFrames.map((frame) => {
      if (!frame || Array.isArray(frame) || typeof frame !== "object") {
        throw new SdkError("validation_error", "issue stack frame must be an object");
      }
      if (typeof frame.filename !== "string") {
        throw new SdkError("validation_error", "issue stack frame filename is invalid");
      }
      const filename = sanitizeFrameFilename(frame.filename);
      if (!filename || filename.length > 2048 || hasControlCharacter(filename)) {
        throw new SdkError("validation_error", "issue stack frame filename is invalid");
      }
      const line = frameCoordinateFromText(frame.line);
      const column = frameCoordinateFromText(frame.column);
      if (line === null || column === null || line > 2147483647 || column > 2147483647) {
        throw new SdkError("validation_error", "issue stack frame coordinates must be positive integers");
      }
      const debugId = frame.debugId === undefined
        ? undefined
        : typeof frame.debugId === "string" && SAFE_DEBUG_ID_PATTERN.test(frame.debugId.trim())
          ? frame.debugId.trim().toLowerCase()
          : null;
      if (debugId === null) {
        throw new SdkError("validation_error", "issue stack frame debugId is invalid");
      }
      const functionName = optionalFrameIdentity(frame.function, MAX_ISSUE_STACK_FUNCTION_LENGTH);
      if (functionName === null) {
        throw new SdkError("validation_error", "issue stack frame function is invalid");
      }
      const moduleName = optionalFrameIdentity(frame.module, MAX_ISSUE_STACK_MODULE_LENGTH, true);
      if (moduleName === null) {
        throw new SdkError("validation_error", "issue stack frame module is invalid");
      }
      const inApp = frame.inApp === undefined
        ? undefined
        : typeof frame.inApp === "boolean"
          ? frame.inApp
          : null;
      if (inApp === null) {
        throw new SdkError("validation_error", "issue stack frame inApp is invalid");
      }
      return {
        filename,
        line,
        column,
        ...(functionName ? { function: functionName } : {}),
        ...(moduleName ? { module: moduleName } : {}),
        ...(inApp !== undefined ? { inApp } : {}),
        ...(debugId ? { debugId } : {})
      };
    });
  }

  function validateNativeStackFrames(frames) {
    if (frames === undefined) {
      return undefined;
    }
    if (!Array.isArray(frames) || frames.length === 0 || frames.length > MAX_ISSUE_STACK_FRAMES) {
      throw new SdkError("validation_error", `issue nativeStackFrames must contain 1-${MAX_ISSUE_STACK_FRAMES} frames`);
    }
    return frames.map((frame) => {
      const keys = frame && !Array.isArray(frame) && typeof frame === "object" ? Object.keys(frame) : [];
      if (keys.length !== 3
        || !keys.every((key) => ["imageUuid", "architecture", "instructionOffset"].includes(key))
        || typeof frame.imageUuid !== "string" || !NATIVE_IMAGE_UUID_PATTERN.test(frame.imageUuid)
        || !NATIVE_ARCHITECTURES.has(frame.architecture)
        || typeof frame.instructionOffset !== "string" || !NATIVE_OFFSET_PATTERN.test(frame.instructionOffset)) {
        throw new SdkError("validation_error", "issue native stack frame is invalid");
      }
      return {
        imageUuid: frame.imageUuid,
        architecture: frame.architecture,
        instructionOffset: frame.instructionOffset
      };
    });
  }

  return { javascriptStackEvidence, validateIssueStackFrames, validateNativeStackFrames };
}

function parseJavaScriptStackFrame(rawLine) {
  const line = typeof rawLine === "string" ? rawLine.trim() : "";
  if (!line) {
    return null;
  }
  let location = line;
  let functionName;
  if (location.startsWith("at ")) {
    location = location.slice(3).trim();
    if (location.endsWith(")") && location.includes("(")) {
      const marker = location.lastIndexOf("(");
      functionName = generatedFrameFunction(location.slice(0, marker));
      location = location.slice(marker + 1, -1);
    }
  } else if (location.includes("@")) {
    const marker = location.lastIndexOf("@");
    functionName = generatedFrameFunction(location.slice(0, marker));
    location = location.slice(marker + 1);
  }
  const hermesBytecode = location.startsWith("address at ");
  location = location.replace(/^address at /u, "");
  const parts = location.split(":");
  if (parts.length < 3) {
    return null;
  }
  const rawColumn = parts.pop();
  const lineNumber = frameCoordinateFromText(parts.pop());
  const column = frameCoordinateFromText(rawColumn, hermesBytecode && lineNumber === 1 ? 1 : 0);
  const filename = sanitizeFrameFilename(parts.join(":"));
  if (!filename || lineNumber === null || column === null) {
    return null;
  }
  return {
    filename,
    line: lineNumber,
    column,
    ...(functionName ? { function: functionName } : {})
  };
}

function optionalFrameIdentity(value, maxLength, rejectLocationText = false) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const identity = value.trim();
  if (!identity
    || Array.from(identity).length > maxLength
    || hasControlCharacter(identity)
    || (rejectLocationText && (identity.includes("?") || identity.includes("#")))) {
    return null;
  }
  return identity;
}

function generatedFrameFunction(value) {
  const functionName = optionalFrameIdentity(value, MAX_ISSUE_STACK_FUNCTION_LENGTH);
  if (!functionName
    || functionName.includes("@")
    || functionName.includes("/")
    || functionName.includes("\\")
    || functionName.includes("?")
    || functionName.includes("#")) {
    return undefined;
  }
  return functionName;
}

function frameCoordinateFromText(value, offset = 0) {
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) {
    return null;
  }
  const parsed = Number(text) + offset;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function sanitizeFrameFilename(value) {
  let filename = String(value ?? "").trim();
  if (!filename) {
    return "";
  }
  filename = filename.split("?", 1)[0].split("#", 1)[0];
  if (filename.startsWith("file://")) {
    filename = filename.slice("file://".length);
  }
  if (LOCAL_ABSOLUTE_PATH_PATTERN.test(filename)) {
    return basename(filename);
  }
  return filename;
}

function debugIdForFrame(filename, debugIdMap, SdkError) {
  if (debugIdMap !== undefined && debugIdMap !== null
    && (!debugIdMap || Array.isArray(debugIdMap) || typeof debugIdMap !== "object")) {
    throw new SdkError("validation_error", "debugIdMap must be an object");
  }
  return debugIdFromEntries(filename, debugIdMap ? Object.entries(debugIdMap) : [])
    ?? debugIdFromEntries(filename, runtimeDebugIdEntries());
}

function debugIdFromEntries(filename, entries) {
  const normalizedFilename = sanitizeFrameFilename(filename);
  const frameBasename = basename(normalizedFilename);
  let basenameMatch = null;
  for (const [candidate, debugId] of entries) {
    if (typeof debugId !== "string" || !SAFE_DEBUG_ID_PATTERN.test(debugId.trim())) {
      continue;
    }
    const normalizedCandidate = sanitizeFrameFilename(candidate);
    const normalizedDebugId = debugId.trim().toLowerCase();
    if (normalizedFilename === normalizedCandidate
      || (normalizedCandidate.includes("/")
        && normalizedFilename.endsWith(`/${normalizedCandidate.replace(/^\/+/, "")}`))) {
      return normalizedDebugId;
    }
    if (frameBasename === basename(normalizedCandidate)) {
      basenameMatch = basenameMatch === null || basenameMatch === normalizedDebugId
        ? normalizedDebugId
        : false;
    }
  }
  return typeof basenameMatch === "string" ? basenameMatch : null;
}

function runtimeDebugIdEntries() {
  try {
    const registry = typeof globalThis === "object"
      ? Object.getOwnPropertyDescriptor(globalThis, DEBUG_ID_REGISTRY)?.value
      : null;
    if (!registry || Array.isArray(registry) || typeof registry !== "object") {
      return [];
    }
    return Object.entries(Object.getOwnPropertyDescriptors(registry)).slice(0, 512).flatMap(
      ([candidate, descriptor]) => "value" in descriptor ? [[candidate, descriptor.value]] : []
    );
  } catch {
    return [];
  }
}

function basename(value) {
  const normalized = String(value).replace(/\\/gu, "/").replace(/\/+$/u, "");
  const marker = normalized.lastIndexOf("/");
  return marker === -1 ? normalized : normalized.slice(marker + 1);
}

function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 31 || code === 127);
  });
}

module.exports = { buildIssueStackHelpers };
