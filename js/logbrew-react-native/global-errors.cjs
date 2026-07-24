"use strict";

const { createReactNativeErrorEvent } = require("./index.cjs");

const AUTOMATIC_ERROR_MESSAGE = "React Native global JavaScript report";
const MAX_STACK_BYTES = 16 * 1024;
const MAX_STACK_FRAMES = 32;
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError"
]);
const installations = new WeakMap();
let nextEventSequence = 0;

function installLogBrewReactNativeGlobalErrorHandler({
  client,
  errorUtils = globalThis?.ErrorUtils,
  onDiagnostic
} = {}) {
  const issue = safeFunction(client, "issue");
  const getGlobalHandler = safeFunction(errorUtils, "getGlobalHandler");
  const setGlobalHandler = safeFunction(errorUtils, "setGlobalHandler");
  if (!issue || !getGlobalHandler || !setGlobalHandler || !isObjectLike(errorUtils)) {
    emitDiagnostic(onDiagnostic, "handler_unavailable");
    return inactiveInstallation();
  }

  const existing = installations.get(errorUtils);
  if (existing?.health().active) {
    return existing;
  }

  let previousHandler;
  try {
    previousHandler = getGlobalHandler.call(errorUtils);
  } catch {
    emitDiagnostic(onDiagnostic, "handler_unavailable");
    return inactiveInstallation();
  }
  if (typeof previousHandler !== "function") {
    emitDiagnostic(onDiagnostic, "handler_unavailable");
    return inactiveInstallation();
  }

  const state = {
    active: true,
    capturedEvents: 0,
    handling: false,
    lastOutcome: "idle",
    suppressedEvents: 0
  };
  const capturedErrors = new WeakSet();
  const handler = (error, isFatal) => {
    if (!state.active) {
      previousHandler(error, isFatal);
      return;
    }
    if (state.handling) {
      recordSuppression(state, onDiagnostic, "recursive_capture_suppressed");
      return;
    }
    state.handling = true;
    try {
      if (isFatal === true) {
        state.lastOutcome = "fatal_unsupported";
        emitDiagnostic(onDiagnostic, "fatal_capture_requires_sync_store");
      } else if (isObjectLike(error) && capturedErrors.has(error)) {
        recordSuppression(state, onDiagnostic, "duplicate_capture_suppressed");
      } else {
        captureNonfatalError(client, issue, error, capturedErrors, state, onDiagnostic);
      }
    } finally {
      try {
        if (typeof previousHandler === "function") {
          previousHandler(error, isFatal);
        }
      } finally {
        state.handling = false;
      }
    }
  };

  const installation = Object.freeze({
    health() {
      return healthSnapshot(state);
    },
    remove() {
      if (!state.active) {
        return false;
      }
      let ownsHandler;
      try {
        ownsHandler = getGlobalHandler.call(errorUtils) === handler;
      } catch {
        return false;
      }
      if (!ownsHandler) {
        state.active = false;
        state.lastOutcome = "handler_replaced";
        installations.delete(errorUtils);
        return false;
      }
      try {
        setGlobalHandler.call(errorUtils, previousHandler);
      } catch {
        state.lastOutcome = "remove_failed";
        return false;
      }
      state.active = false;
      state.lastOutcome = "removed";
      installations.delete(errorUtils);
      return true;
    }
  });

  try {
    setGlobalHandler.call(errorUtils, handler);
  } catch {
    state.active = false;
    try {
      if (getGlobalHandler.call(errorUtils) === handler) {
        setGlobalHandler.call(errorUtils, previousHandler);
      }
    } catch {
      // An inactive wrapper only delegates if a platform setter failed after mutation.
    }
    emitDiagnostic(onDiagnostic, "handler_unavailable");
    return inactiveInstallation();
  }
  installations.set(errorUtils, installation);
  return installation;
}

function captureNonfatalError(client, issue, error, capturedErrors, state, onDiagnostic) {
  const tracksIdentity = isObjectLike(error);
  if (tracksIdentity) {
    capturedErrors.add(error);
  }
  try {
    const event = createAutomaticErrorEvent(error);
    issue.call(client, event.id, event.timestamp, event.attributes);
    state.capturedEvents = incrementBounded(state.capturedEvents);
    state.lastOutcome = "captured";
  } catch {
    if (tracksIdentity) {
      capturedErrors.delete(error);
    }
    state.lastOutcome = "capture_failed";
    emitDiagnostic(onDiagnostic, "capture_failed");
  }
}

function createAutomaticErrorEvent(error) {
  const sanitizedError = new Error(AUTOMATIC_ERROR_MESSAGE);
  sanitizedError.name = safeErrorName(error);
  const stack = safeStack(error);
  if (stack) {
    sanitizedError.stack = stack;
  } else {
    delete sanitizedError.stack;
  }
  const event = createReactNativeErrorEvent(sanitizedError, {
    id: nextEventId(),
    includeStack: false
  });
  return {
    ...event,
    attributes: {
      ...event.attributes,
      title: AUTOMATIC_ERROR_MESSAGE,
      message: AUTOMATIC_ERROR_MESSAGE,
      metadata: {
        ...event.attributes.metadata,
        automatic: true,
        fatal: false,
        handled: true,
        mechanism: "react_native_error_utils",
        source: "react-native.global_error"
      }
    }
  };
}

function safeStack(error) {
  const stack = safeReadProperty(error, "stack");
  const candidate = typeof stack === "string"
    ? stack.slice(0, MAX_STACK_BYTES)
    : "";
  const frames = [];
  for (const line of candidate.split(/\r?\n/u)) {
    const frame = safeStackFrame(line);
    if (frame) {
      frames.push(`    at frame (${frame})`);
      if (frames.length === MAX_STACK_FRAMES) {
        break;
      }
    }
  }
  return frames.length === 0
    ? undefined
    : `${safeErrorName(error)}: ${AUTOMATIC_ERROR_MESSAGE}\n${frames.join("\n")}`;
}

function safeStackFrame(line) {
  let location = typeof line === "string" ? line.trim() : "";
  if (!location) {
    return undefined;
  }
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
    return undefined;
  }
  const column = positiveInteger(parts.pop());
  const lineNumber = positiveInteger(parts.pop());
  const filename = safeStackFilename(parts.join(":"));
  if (!filename || lineNumber === undefined || column === undefined) {
    return undefined;
  }
  return `${filename}:${lineNumber}:${column}`;
}

function safeStackFilename(value) {
  let filename = String(value ?? "").trim().replace(/\\/gu, "/");
  if (!filename || filename.length > 2048 || hasControlCharacter(filename)) {
    return undefined;
  }
  try {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(filename)) {
      const parsed = new URL(filename);
      if (!["app:", "http:", "https:"].includes(parsed.protocol)
        || parsed.username
        || urlAuthority(filename).includes("@")) {
        return undefined;
      }
      filename = parsed.pathname;
    } else {
      filename = filename.split(/[?#]/u, 1)[0];
      if (filename.startsWith("/") || /^[A-Za-z]:\//u.test(filename)) {
        return undefined;
      }
    }
  } catch {
    return undefined;
  }
  return filename && filename.length <= 2048 && !hasControlCharacter(filename)
    ? filename
    : undefined;
}

function urlAuthority(value) {
  const schemeMarker = value.indexOf("://");
  if (schemeMarker < 0) {
    return "";
  }
  const start = schemeMarker + 3;
  const end = value.indexOf("/", start);
  return value.slice(start, end < 0 ? value.length : end);
}

function safeErrorName(error) {
  const name = safeReadProperty(error, "name");
  const candidate = typeof name === "string" ? name : "Error";
  return SAFE_ERROR_NAMES.has(candidate) ? candidate : "Error";
}

function safeReadProperty(value, property) {
  if (!isObjectLike(value)) {
    return undefined;
  }
  try {
    return value[property];
  } catch {
    return undefined;
  }
}

function safeFunction(value, property) {
  const candidate = safeReadProperty(value, property);
  return typeof candidate === "function" ? candidate : undefined;
}

function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 31 || code === 127);
  });
}

function positiveInteger(value) {
  if (!/^[1-9][0-9]*$/u.test(String(value))) {
    return undefined;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= 2147483647 ? number : undefined;
}

function nextEventId() {
  nextEventSequence = incrementBounded(nextEventSequence);
  return `evt_rn_global_${Date.now().toString(36)}_${nextEventSequence.toString(36)}`;
}

function incrementBounded(value) {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function recordSuppression(state, onDiagnostic, code) {
  state.suppressedEvents = incrementBounded(state.suppressedEvents);
  state.lastOutcome = code === "recursive_capture_suppressed" ? "recursive_suppressed" : "duplicate_suppressed";
  emitDiagnostic(onDiagnostic, code);
}

function emitDiagnostic(onDiagnostic, code) {
  if (typeof onDiagnostic !== "function") {
    return;
  }
  try {
    onDiagnostic(Object.freeze({ code }));
  } catch {
    // Diagnostics must never interfere with application error handling.
  }
}

function inactiveInstallation() {
  const snapshot = Object.freeze({
    active: false,
    capturedEvents: 0,
    lastOutcome: "unavailable",
    suppressedEvents: 0
  });
  return Object.freeze({
    health: () => snapshot,
    remove: () => false
  });
}

function healthSnapshot(state) {
  return Object.freeze({
    active: state.active,
    capturedEvents: state.capturedEvents,
    lastOutcome: state.lastOutcome,
    suppressedEvents: state.suppressedEvents
  });
}

function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

const defaultExport = {
  installLogBrewReactNativeGlobalErrorHandler
};

module.exports = { ...defaultExport, default: defaultExport };
