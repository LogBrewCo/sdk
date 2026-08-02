"use strict";

const { createReactNativeErrorEvent } = require("./index.cjs");

const AUTOMATIC_MESSAGE = "Unhandled Promise rejection";
const DEFAULT_MAX_TRACKED_REJECTIONS = 128;
const MAX_TRACKED_REJECTIONS = 1024;
const MAX_STRING_ID_LENGTH = 128;
const activeTrackerInstallations = new WeakMap();
let nextEventSequence = 0;

function createLogBrewReactNativePromiseRejectionHandlers(options = {}) {
  return createPromiseRejectionHandlers(
    options,
    "app_owned_promise_rejection_tracker"
  );
}

function createPromiseRejectionHandlers(options, mechanism) {
  const input = isObjectLike(options) ? options : {};
  const client = safeReadProperty(input, "client");
  const issue = safeFunction(client, "issue");
  const onDiagnostic = safeFunction(input, "onDiagnostic");
  if (!issue) {
    emitDiagnostic(onDiagnostic, "promise_rejection_handler_unavailable");
    return inactiveHandlers();
  }

  const configuredMaximum = safeReadProperty(input, "maxTrackedRejections");
  const maxTrackedRejections = validMaximum(configuredMaximum)
    ? configuredMaximum
    : DEFAULT_MAX_TRACKED_REJECTIONS;
  if (configuredMaximum !== undefined && maxTrackedRejections !== configuredMaximum) {
    emitDiagnostic(onDiagnostic, "promise_rejection_configuration_invalid");
  }

  const tracked = new Map();
  const state = {
    capturedEvents: 0,
    emittingDiagnostic: false,
    evictedRejections: 0,
    handledLaterEvents: 0,
    handling: false,
    lastOutcome: "idle",
    suppressedEvents: 0,
    unknownHandledEvents: 0,
    untrackedEvents: 0
  };
  let emittedEvictionDiagnostic = false;

  return Object.freeze({
    health() {
      return healthSnapshot(state, tracked.size, maxTrackedRejections);
    },
    onHandled(runtimeRejectionId) {
      const key = rejectionKey(runtimeRejectionId);
      const record = key === undefined ? undefined : tracked.get(key);
      if (!record) {
        state.unknownHandledEvents = incrementBounded(state.unknownHandledEvents);
        state.lastOutcome = "handled_unknown";
        return;
      }
      if (record.handled) {
        recordSuppression(
          state,
          onDiagnostic,
          "promise_rejection_duplicate_suppressed",
          "duplicate_suppressed"
        );
        return;
      }
      record.handled = true;
      state.handledLaterEvents = incrementBounded(state.handledLaterEvents);
      state.lastOutcome = "handled_later";
    },
    onUnhandled(runtimeRejectionId) {
      if (state.handling) {
        recordSuppression(
          state,
          onDiagnostic,
          "promise_rejection_recursive_capture_suppressed",
          "recursive_suppressed"
        );
        return;
      }

      const key = rejectionKey(runtimeRejectionId);
      if (key !== undefined && tracked.has(key)) {
        recordSuppression(
          state,
          onDiagnostic,
          "promise_rejection_duplicate_suppressed",
          "duplicate_suppressed"
        );
        return;
      }

      state.handling = true;
      try {
        if (key === undefined) {
          emitStateDiagnostic(state, onDiagnostic, "promise_rejection_id_unavailable");
        }
        const event = createEvent(mechanism);
        issue.call(client, event.id, event.timestamp, event.attributes);
        state.capturedEvents = incrementBounded(state.capturedEvents);

        if (key === undefined) {
          state.untrackedEvents = incrementBounded(state.untrackedEvents);
          state.lastOutcome = "captured_untracked";
          return;
        }

        let evicted = false;
        if (tracked.size === maxTrackedRejections) {
          tracked.delete(tracked.keys().next().value);
          state.evictedRejections = incrementBounded(state.evictedRejections);
          evicted = true;
          if (!emittedEvictionDiagnostic) {
            emittedEvictionDiagnostic = true;
            emitStateDiagnostic(state, onDiagnostic, "promise_rejection_tracking_evicted");
          }
        }
        tracked.set(key, { handled: false });
        state.lastOutcome = evicted ? "captured_with_eviction" : "captured";
      } catch {
        state.lastOutcome = "capture_failed";
        emitStateDiagnostic(state, onDiagnostic, "promise_rejection_capture_failed");
      } finally {
        state.handling = false;
      }
    }
  });
}

function installLogBrewReactNativePromiseRejectionTracker(options = {}) {
  const input = isObjectLike(options) ? options : {};
  const onDiagnostic = safeFunction(input, "onDiagnostic");
  if (safeReadProperty(input, "takeOwnership") !== true) {
    emitDiagnostic(onDiagnostic, "promise_rejection_tracker_ownership_required");
    return inactiveTrackerInstallation("ownership_required");
  }

  const tracker = safeReadProperty(input, "tracker");
  const enable = safeFunction(tracker, "enable");
  const engine = safeReadProperty(input, "trackerKind") === "hermes"
    ? "hermes"
    : isObjectLike(tracker) ? "custom" : "unavailable";
  if (!isObjectLike(tracker) || !enable) {
    emitDiagnostic(onDiagnostic, "promise_rejection_tracker_unavailable");
    return inactiveTrackerInstallation("tracker_unavailable", engine);
  }

  const existing = activeTrackerInstallations.get(tracker);
  if (existing?.health().active) {
    return existing;
  }

  const handlers = createPromiseRejectionHandlers(
    input,
    "logbrew_owned_promise_rejection_tracker"
  );
  if (!handlers.health().available) {
    return inactiveTrackerInstallation("handler_unavailable", engine, handlers);
  }

  const state = {
    active: true,
    lastOutcome: "installed"
  };
  const trackerOptions = Object.freeze({
    allRejections: true,
    onHandled(runtimeRejectionId) {
      if (state.active) {
        handlers.onHandled(runtimeRejectionId);
      }
    },
    onUnhandled(runtimeRejectionId, rejection) {
      if (state.active) {
        handlers.onUnhandled(runtimeRejectionId, rejection);
      }
    }
  });

  const installation = Object.freeze({
    deactivate() {
      if (!state.active) {
        return false;
      }
      state.active = false;
      state.lastOutcome = "deactivated";
      if (activeTrackerInstallations.get(tracker) === installation) {
        activeTrackerInstallations.delete(tracker);
      }
      return true;
    },
    health() {
      return trackerHealthSnapshot(state, engine, true);
    },
    rejectionHealth() {
      return handlers.health();
    }
  });

  try {
    enable.call(tracker, trackerOptions);
  } catch {
    state.active = false;
    state.lastOutcome = "installation_failed";
    emitDiagnostic(onDiagnostic, "promise_rejection_tracker_installation_failed");
    return inactiveTrackerInstallation(
      "installation_failed",
      engine,
      handlers
    );
  }

  activeTrackerInstallations.set(tracker, installation);
  return installation;
}

function createEvent(mechanism) {
  const error = new Error(AUTOMATIC_MESSAGE);
  delete error.stack;
  const event = createReactNativeErrorEvent(error, {
    id: nextEventId(),
    handled: false,
    includeStack: false,
    mechanism
  });
  return {
    ...event,
    attributes: {
      ...event.attributes,
      title: AUTOMATIC_MESSAGE,
      message: AUTOMATIC_MESSAGE,
      metadata: {
        ...event.attributes.metadata,
        automatic: true,
        fatal: false,
        handled: false,
        mechanism,
        source: "react-native.promise_rejection"
      }
    }
  };
}

function rejectionKey(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return `number:${value}`;
  }
  if (typeof value === "string"
    && value.length > 0
    && value.length <= MAX_STRING_ID_LENGTH
    && !hasControlCharacter(value)) {
    return `string:${value}`;
  }
  return undefined;
}

function validMaximum(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_TRACKED_REJECTIONS;
}

function nextEventId() {
  nextEventSequence = incrementBounded(nextEventSequence);
  return `evt_rn_promise_${Date.now().toString(36)}_${nextEventSequence.toString(36)}`;
}

function incrementBounded(value) {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function recordSuppression(state, onDiagnostic, code, outcome) {
  state.suppressedEvents = incrementBounded(state.suppressedEvents);
  state.lastOutcome = outcome;
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
    // Diagnostics must never interfere with application rejection handling.
  }
}

function inactiveHandlers() {
  const snapshot = Object.freeze({
    available: false,
    capturedEvents: 0,
    evictedRejections: 0,
    handledLaterEvents: 0,
    lastOutcome: "unavailable",
    maxTrackedRejections: 0,
    suppressedEvents: 0,
    trackedRejections: 0,
    unknownHandledEvents: 0,
    untrackedEvents: 0
  });
  return Object.freeze({
    health: () => snapshot,
    onHandled: () => {},
    onUnhandled: () => {}
  });
}

function inactiveTrackerInstallation(
  lastOutcome,
  engine = "unavailable",
  handlers = inactiveHandlers()
) {
  const snapshot = Object.freeze({
    active: false,
    available: false,
    engine,
    lastOutcome,
    restoration: "deactivate_only"
  });
  return Object.freeze({
    deactivate: () => false,
    health: () => snapshot,
    rejectionHealth: () => handlers.health()
  });
}

function trackerHealthSnapshot(state, engine, available) {
  return Object.freeze({
    active: state.active,
    available,
    engine,
    lastOutcome: state.lastOutcome,
    restoration: "deactivate_only"
  });
}

function healthSnapshot(state, trackedRejections, maxTrackedRejections) {
  return Object.freeze({
    available: true,
    capturedEvents: state.capturedEvents,
    evictedRejections: state.evictedRejections,
    handledLaterEvents: state.handledLaterEvents,
    lastOutcome: state.lastOutcome,
    maxTrackedRejections,
    suppressedEvents: state.suppressedEvents,
    trackedRejections,
    unknownHandledEvents: state.unknownHandledEvents,
    untrackedEvents: state.untrackedEvents
  });
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

function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

module.exports = {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativePromiseRejectionTracker
};
