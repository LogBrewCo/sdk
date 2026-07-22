"use strict";

const MAX_ISSUE_STACK_FRAMES = 32;
const SAFE_DEBUG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LOCAL_ABSOLUTE_PATH_PATTERN = /^(?:\/(?:Users|home|private|tmp|var|Volumes)\/|[A-Za-z]:[\\/])/u;

function buildIssueStackHelpers({ SdkError }) {
  function javascriptStackFrames(stack, debugIdMap) {
    if (typeof stack !== "string" || stack.trim() === "") {
      return [];
    }
    const frames = [];
    for (const rawLine of stack.split(/\r?\n/u)) {
      const parsed = parseJavaScriptStackFrame(rawLine);
      if (parsed) {
        const debugId = debugIdForFrame(parsed.filename, debugIdMap, SdkError);
        frames.push({ ...parsed, ...(debugId ? { debugId } : {}) });
        if (frames.length === MAX_ISSUE_STACK_FRAMES) {
          break;
        }
      }
    }
    return frames;
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
      const line = positiveIntegerFromText(frame.line);
      const column = positiveIntegerFromText(frame.column);
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
      return { filename, line, column, ...(debugId ? { debugId } : {}) };
    });
  }

  return { javascriptStackFrames, validateIssueStackFrames };
}

function parseJavaScriptStackFrame(rawLine) {
  const line = typeof rawLine === "string" ? rawLine.trim() : "";
  if (!line) {
    return null;
  }
  let location = line;
  if (location.startsWith("at ")) {
    location = location.slice(3).trim();
    if (location.endsWith(")") && location.includes("(")) {
      location = location.slice(location.lastIndexOf("(") + 1, -1);
    }
  } else if (location.includes("@")) {
    location = location.slice(location.lastIndexOf("@") + 1);
  }
  const parts = location.split(":");
  if (parts.length < 3) {
    return null;
  }
  const column = positiveIntegerFromText(parts.pop());
  const lineNumber = positiveIntegerFromText(parts.pop());
  const filename = sanitizeFrameFilename(parts.join(":"));
  if (!filename || lineNumber === null || column === null) {
    return null;
  }
  return { filename, line: lineNumber, column };
}

function positiveIntegerFromText(value) {
  const text = String(value);
  if (!/^[1-9][0-9]*$/u.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
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
  if (debugIdMap === undefined || debugIdMap === null) {
    return null;
  }
  if (!debugIdMap || Array.isArray(debugIdMap) || typeof debugIdMap !== "object") {
    throw new SdkError("validation_error", "debugIdMap must be an object");
  }
  const normalizedFilename = sanitizeFrameFilename(filename);
  const aliases = new Set([normalizedFilename, basename(normalizedFilename)].filter(Boolean));
  for (const [candidate, debugId] of Object.entries(debugIdMap)) {
    if (typeof debugId !== "string" || !SAFE_DEBUG_ID_PATTERN.test(debugId.trim())) {
      continue;
    }
    const normalizedCandidate = sanitizeFrameFilename(candidate);
    if (aliases.has(normalizedCandidate) || aliases.has(basename(normalizedCandidate))) {
      return debugId.trim().toLowerCase();
    }
  }
  return null;
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
