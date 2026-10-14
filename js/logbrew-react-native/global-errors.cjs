"use strict";

const { createReactNativeErrorEvent } = require("./index.cjs");
const { captureIssueWithAdmission, createFatalController } = require("./fatal-replay.cjs");
const {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativePromiseRejectionTracker
} = require("./promise-rejections.cjs");

const AUTOMATIC_ERROR_MESSAGE = "React Native global JavaScript report";
const MAX_STACK_BYTES = 16 * 1024;
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
const LOCATION_DIRECTORIES =
  /(?:[a-z][a-z0-9+.-]*:\/\/[^/\s()]*)?(?:[a-z]:)?[\\/](?:[^\\/\s():]*[\\/])*/giu;
const installations = new WeakMap();
let nextEventSequence = 0;

function installLogBrewReactNativeGlobalErrorHandler({
  client,
  errorUtils = globalThis?.ErrorUtils,
  fatalStore,
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
    emittingDiagnostic: false,
    handling: false,
    lastOutcome: "idle",
    suppressedEvents: 0
  };
  const fatal = createFatalController({
    client,
    createEvent: (error) => createAutomaticErrorEvent(error, client, true),
    eventMessage: AUTOMATIC_ERROR_MESSAGE,
    fatalStore,
    isErrorName: (value) => SAFE_ERROR_NAMES.has(value),
    issue,
    onDiagnostic: (diagnostic) => emitStateDiagnostic(state, onDiagnostic, diagnostic.code)
  });
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
        if (fatal.available) {
          if (fatal.store(error)) {
            state.lastOutcome = "fatal_stored";
          } else {
            state.lastOutcome = fatal.health().lastOutcome === "admission_unavailable"
              ? "admission_unavailable"
              : "fatal_store_failed";
          }
        } else {
          state.lastOutcome = "fatal_unsupported";
          emitStateDiagnostic(state, onDiagnostic, "fatal_capture_requires_sync_store");
        }
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
    discardPendingFatalRecord() {
      return fatal.discard();
    },
    fatalHealth() {
      return fatal.health();
    },
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
  fatal.replay();
  return installation;
}

function captureNonfatalError(client, issue, error, capturedErrors, state, onDiagnostic) {
  const tracksIdentity = isObjectLike(error);
  if (tracksIdentity) {
    capturedErrors.add(error);
  }
  try {
    const event = createAutomaticErrorEvent(error, client);
    const admission = captureIssueWithAdmission(client, issue, event.id, event.timestamp, event.attributes);
    if (admission !== "admitted") {
      if (tracksIdentity) {
        capturedErrors.delete(error);
      }
      state.lastOutcome = admission === "unavailable"
        ? "admission_unavailable"
        : admission === "filtered" ? "filtered" : "capture_failed";
      emitStateDiagnostic(state, onDiagnostic, admission === "unavailable"
        ? "capture_admission_unavailable"
        : admission === "filtered" ? "capture_filtered" : "capture_failed");
      return;
    }
    state.capturedEvents = incrementBounded(state.capturedEvents);
    state.lastOutcome = "captured";
  } catch {
    if (tracksIdentity) {
      capturedErrors.delete(error);
    }
    state.lastOutcome = "capture_failed";
    emitStateDiagnostic(state, onDiagnostic, "capture_failed");
  }
}

function createAutomaticErrorEvent(error, client, fatal = false) {
  const sanitizedError = new Error(AUTOMATIC_ERROR_MESSAGE);
  sanitizedError.name = safeErrorName(error);
  sanitizedError.stack = automaticStack(error);
  const lastRoute = safeReadProperty(client, LAST_ROUTE);
  const event = createReactNativeErrorEvent(sanitizedError, {
    id: nextEventId(fatal ? "fatal" : "global"),
    handled: false,
    includeStack: false,
    level: fatal ? "fatal" : "error",
    mechanism: "react_native_error_utils"
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
        fatal,
        handled: !fatal,
        ...(typeof lastRoute === "string" ? { lastRoute } : {}),
        mechanism: "react_native_error_utils",
        source: "react-native.global_error"
      }
    }
  };
}

// Removes the message header, remote hosts, and local directories before the
// canonical parser reads frames, so only file basenames, lines, columns, and
// function names remain.
function automaticStack(error) {
  const stack = safeReadProperty(error, "stack");
  if (typeof stack !== "string") {
    return "";
  }
  const name = safeReadProperty(error, "name");
  const message = safeReadProperty(error, "message");
  const header = `${typeof name === "string" ? name : "Error"}: ${typeof message === "string" ? message : ""}`;
  return (stack.startsWith(header) ? stack.slice(header.length) : stack)
    .slice(0, MAX_STACK_BYTES)
    .replace(LOCATION_DIRECTORIES, "");
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

function nextEventId(kind) {
  nextEventSequence = incrementBounded(nextEventSequence);
  return `evt_rn_${kind}_${Date.now().toString(36)}_${nextEventSequence.toString(36)}`;
}

function incrementBounded(value) {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function recordSuppression(state, onDiagnostic, code) {
  state.suppressedEvents = incrementBounded(state.suppressedEvents);
  state.lastOutcome = code === "recursive_capture_suppressed" ? "recursive_suppressed" : "duplicate_suppressed";
  emitStateDiagnostic(state, onDiagnostic, code);
}

function emitStateDiagnostic(state, onDiagnostic, code) {
  if (state.emittingDiagnostic) {
    return;
  }
  state.emittingDiagnostic = true;
  try {
    emitDiagnostic(onDiagnostic, code);
  } finally {
    state.emittingDiagnostic = false;
  }
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
  const fatalSnapshot = Object.freeze({
    acknowledgedRecords: 0,
    available: false,
    corruptRecords: 0,
    droppedRecords: 0,
    lastOutcome: "unavailable",
    replayedRecords: 0,
    storedRecords: 0
  });
  return Object.freeze({
    discardPendingFatalRecord: () => false,
    fatalHealth: () => fatalSnapshot,
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
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativeGlobalErrorHandler,
  installLogBrewReactNativePromiseRejectionTracker
};

module.exports = { ...defaultExport, default: defaultExport };
