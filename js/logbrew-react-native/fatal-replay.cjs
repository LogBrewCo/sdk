"use strict";

const FATAL_RECORD_SCHEMA_VERSION = 1;
const MAX_ADMITTED_FATAL_IDS = 256;
const MAX_FATAL_FILENAME_BYTES = 512;
const MAX_FATAL_STACK_BYTES = 16 * 1024;
const MAX_FATAL_STACK_FRAMES = 24;

const admittedFatalIdsByClient = new WeakMap();
let nextFatalSequence = 0;

function createFatalController({
  client,
  eventMessage,
  fatalStore,
  issue,
  onDiagnostic,
  sanitizers
}) {
  const methods = fatalStoreMethods(fatalStore);
  const state = {
    acknowledgedRecords: 0,
    available: methods !== undefined,
    corruptRecords: 0,
    droppedRecords: 0,
    lastOutcome: methods ? "idle" : "unavailable",
    replayedRecords: 0,
    storedRecords: 0
  };

  return {
    available: state.available,
    discard() {
      return discardPendingFatal(fatalStore, methods, state, onDiagnostic);
    },
    health() {
      return fatalHealthSnapshot(state);
    },
    replay() {
      replayPendingFatal({
        client,
        eventMessage,
        fatalStore,
        issue,
        methods,
        onDiagnostic,
        sanitizers,
        state
      });
    },
    store(error) {
      return storeFatalError({
        error,
        fatalStore,
        methods,
        onDiagnostic,
        sanitizers,
        state
      });
    }
  };
}

function fatalStoreMethods(fatalStore) {
  if (!isObjectLike(fatalStore)) {
    return undefined;
  }
  const methods = {
    acknowledge: safeFunction(fatalStore, "acknowledgeFatalRecord"),
    discard: safeFunction(fatalStore, "discardFatalRecord"),
    read: safeFunction(fatalStore, "readFatalRecord"),
    write: safeFunction(fatalStore, "writeFatalRecord")
  };
  return Object.values(methods).every((method) => typeof method === "function")
    ? methods
    : undefined;
}

function discardPendingFatal(fatalStore, methods, state, onDiagnostic) {
  if (!methods) {
    return false;
  }
  let result;
  try {
    result = methods.discard.call(fatalStore);
  } catch {
    state.lastOutcome = "discard_failed";
    emitDiagnostic(onDiagnostic, "fatal_discard_failed");
    return false;
  }
  if (resultStatus(result) !== "discarded") {
    state.lastOutcome = resultStatus(result) === "empty" ? "empty" : "discard_failed";
    if (state.lastOutcome === "discard_failed") {
      emitDiagnostic(onDiagnostic, "fatal_discard_failed");
    }
    return false;
  }
  state.lastOutcome = "discarded";
  return true;
}

function storeFatalError({
  error,
  fatalStore,
  methods,
  onDiagnostic,
  sanitizers,
  state
}) {
  if (!methods) {
    return false;
  }
  let result;
  try {
    result = methods.write.call(fatalStore, createFatalRecord(error, sanitizers));
  } catch {
    result = undefined;
  }
  const status = resultStatus(result);
  if (status === "stored" || status === "stored_after_corruption") {
    state.storedRecords = incrementBounded(state.storedRecords);
    state.corruptRecords = boundedResultCounter(result, "corruptRecords", state.corruptRecords);
    state.lastOutcome = status;
    return true;
  }
  if (status === "dropped_pending") {
    state.droppedRecords = boundedResultCounter(
      result,
      "droppedRecords",
      incrementBounded(state.droppedRecords)
    );
    state.lastOutcome = status;
    emitDiagnostic(onDiagnostic, "fatal_record_dropped");
    return false;
  }
  state.lastOutcome = "storage_error";
  emitDiagnostic(onDiagnostic, "fatal_store_failed");
  return false;
}

function replayPendingFatal({
  client,
  eventMessage,
  fatalStore,
  issue,
  methods,
  onDiagnostic,
  sanitizers,
  state
}) {
  if (!methods) {
    return;
  }
  let result;
  try {
    result = methods.read.call(fatalStore);
  } catch {
    result = undefined;
  }
  const status = resultStatus(result);
  if (status === "empty") {
    state.lastOutcome = "empty";
    return;
  }
  if (status === "corrupt_discarded") {
    state.corruptRecords = boundedResultCounter(
      result,
      "corruptRecords",
      incrementBounded(state.corruptRecords)
    );
    state.lastOutcome = status;
    emitDiagnostic(onDiagnostic, "fatal_corrupt_record_discarded");
    return;
  }
  const record = status === "pending"
    ? validatedFatalRecord(safeReadProperty(result, "record"), sanitizers)
    : undefined;
  if (!record) {
    state.lastOutcome = "replay_failed";
    emitDiagnostic(onDiagnostic, "fatal_replay_failed");
    return;
  }

  state.corruptRecords = Math.max(state.corruptRecords, record.corruptRecords);
  state.droppedRecords = Math.max(state.droppedRecords, record.droppedRecords);
  if (wasAdmittedInRuntime(client, record.id)) {
    acknowledgeFatalRecord(fatalStore, methods, record.id, state, onDiagnostic);
    return;
  }

  const before = admissionSnapshot(client);
  try {
    issue.call(client, record.id, record.timestamp, fatalEventAttributes(record, eventMessage));
  } catch {
    state.lastOutcome = "replay_failed";
    emitDiagnostic(onDiagnostic, "fatal_replay_failed");
    return;
  }
  const after = admissionSnapshot(client);
  if (!wasAdmitted(before, after)) {
    state.lastOutcome = "replay_not_admitted";
    emitDiagnostic(onDiagnostic, "fatal_replay_not_admitted");
    return;
  }

  rememberAdmittedFatalId(client, record.id);
  state.replayedRecords = incrementBounded(state.replayedRecords);
  acknowledgeFatalRecord(fatalStore, methods, record.id, state, onDiagnostic);
}

function acknowledgeFatalRecord(fatalStore, methods, recordId, state, onDiagnostic) {
  let result;
  try {
    result = methods.acknowledge.call(fatalStore, recordId);
  } catch {
    result = undefined;
  }
  if (resultStatus(result) === "acknowledged"
    && safeReadProperty(result, "recordId") === recordId) {
    state.acknowledgedRecords = incrementBounded(state.acknowledgedRecords);
    state.lastOutcome = "acknowledged";
    return;
  }
  state.lastOutcome = "acknowledge_failed";
  emitDiagnostic(onDiagnostic, "fatal_acknowledge_failed");
}

function admissionSnapshot(client) {
  const pendingEvents = safeFunction(client, "pendingEvents");
  const droppedEvents = safeFunction(client, "droppedEvents");
  if (!pendingEvents || !droppedEvents) {
    return undefined;
  }
  try {
    const pending = pendingEvents.call(client);
    const dropped = droppedEvents.call(client);
    return isBoundedCounter(pending) && isBoundedCounter(dropped)
      ? { dropped, pending }
      : undefined;
  } catch {
    return undefined;
  }
}

function wasAdmitted(before, after) {
  return before !== undefined
    && after !== undefined
    && after.pending === before.pending + 1
    && after.dropped === before.dropped;
}

function wasAdmittedInRuntime(client, recordId) {
  return isObjectLike(client) && admittedFatalIdsByClient.get(client)?.has(recordId) === true;
}

function rememberAdmittedFatalId(client, recordId) {
  if (!isObjectLike(client)) {
    return;
  }
  let admittedIds = admittedFatalIdsByClient.get(client);
  if (!admittedIds) {
    admittedIds = new Set();
    admittedFatalIdsByClient.set(client, admittedIds);
  }
  if (admittedIds.has(recordId)) {
    return;
  }
  admittedIds.add(recordId);
  if (admittedIds.size > MAX_ADMITTED_FATAL_IDS) {
    admittedIds.delete(admittedIds.values().next().value);
  }
}

function createFatalRecord(error, sanitizers) {
  return Object.freeze({
    corruptRecords: 0,
    droppedRecords: 0,
    errorName: sanitizers.errorName(error),
    id: nextFatalEventId(),
    schemaVersion: FATAL_RECORD_SCHEMA_VERSION,
    stackFrames: fatalStackFrames(error, sanitizers.stackFrame),
    timestamp: new Date().toISOString()
  });
}

function fatalStackFrames(error, stackFrame) {
  const stack = safeReadProperty(error, "stack");
  const candidate = typeof stack === "string"
    ? stack.slice(0, MAX_FATAL_STACK_BYTES)
    : "";
  const frames = [];
  for (const line of candidate.split(/\r?\n/u)) {
    const frame = stackFrame(line);
    const filename = frame ? normalizedStoredFatalFilename(frame.filename) : undefined;
    if (filename && validFatalFilename(filename)) {
      frames.push(Object.freeze({
        column: frame.column,
        filename,
        line: frame.line
      }));
      if (frames.length === MAX_FATAL_STACK_FRAMES) {
        break;
      }
    }
  }
  return Object.freeze(frames);
}

function fatalEventAttributes(record, eventMessage) {
  return Object.freeze({
    exception: Object.freeze({
      type: record.errorName,
      mechanism: Object.freeze({
        type: "react_native_error_utils",
        handled: false
      })
    }),
    level: "fatal",
    message: eventMessage,
    metadata: Object.freeze({
      automatic: true,
      fatal: true,
      handled: false,
      mechanism: "react_native_error_utils",
      nativeCorruptRecords: record.corruptRecords,
      nativeDroppedRecords: record.droppedRecords,
      replayed: true,
      source: "react-native.global_error"
    }),
    stackFrames: record.stackFrames.map((frame) => Object.freeze({ ...frame })),
    title: eventMessage
  });
}

function validatedFatalRecord(value, sanitizers) {
  try {
    if (!isPlainObject(value)
      || !hasExactKeys(value, [
        "corruptRecords",
        "droppedRecords",
        "errorName",
        "id",
        "schemaVersion",
        "stackFrames",
        "timestamp"
      ])
      || value.schemaVersion !== FATAL_RECORD_SCHEMA_VERSION
      || typeof value.id !== "string"
      || !/^evt_rn_fatal_[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(value.id)
      || !sanitizers.isErrorName(value.errorName)
      || !isBoundedCounter(value.corruptRecords)
      || !isBoundedCounter(value.droppedRecords)
      || !validFatalTimestamp(value.timestamp)
      || !Array.isArray(value.stackFrames)
      || value.stackFrames.length > MAX_FATAL_STACK_FRAMES) {
      return undefined;
    }
    const frames = value.stackFrames.map(validatedFatalFrame);
    if (frames.some((frame) => frame === undefined)) {
      return undefined;
    }
    return {
      corruptRecords: value.corruptRecords,
      droppedRecords: value.droppedRecords,
      errorName: value.errorName,
      id: value.id,
      schemaVersion: FATAL_RECORD_SCHEMA_VERSION,
      stackFrames: frames,
      timestamp: value.timestamp
    };
  } catch {
    return undefined;
  }
}

function validatedFatalFrame(value) {
  try {
    if (!isPlainObject(value)
      || !hasExactKeys(value, ["column", "filename", "line"])
      || !validFatalFilename(value.filename)
      || positiveInteger(value.line) === undefined
      || positiveInteger(value.column) === undefined) {
      return undefined;
    }
    return {
      column: value.column,
      filename: value.filename,
      line: value.line
    };
  } catch {
    return undefined;
  }
}

function validFatalFilename(value) {
  return typeof value === "string"
    && value.length > 0
    && utf8ByteLength(value) <= MAX_FATAL_FILENAME_BYTES
    && !hasControlCharacter(value)
    && !value.startsWith("/")
    && !/^[A-Za-z]:/u.test(value)
    && !value.includes("\\")
    && !value.includes("://")
    && !value.includes("?")
    && !value.includes("#")
    && !value.split("/").includes("..");
}

function normalizedStoredFatalFilename(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && value.length > 1
    && value.indexOf("/", 1) === -1
    ? value.slice(1)
    : value;
}

function validFatalTimestamp(value) {
  return typeof value === "string"
    && value.length >= 20
    && value.length <= 35
    && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u.test(value);
}

function resultStatus(result) {
  try {
    return isPlainObject(result) && typeof result.status === "string"
      ? result.status
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedResultCounter(result, property, fallback) {
  const value = isPlainObject(result) ? safeReadProperty(result, property) : undefined;
  return isBoundedCounter(value) ? value : fallback;
}

function hasExactKeys(value, expected) {
  try {
    const keys = Object.keys(value).sort();
    return keys.length === expected.length
      && keys.every((key, index) => key === expected[index]);
  } catch {
    return false;
  }
}

function isBoundedCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
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

function nextFatalEventId() {
  nextFatalSequence = incrementBounded(nextFatalSequence);
  return `evt_rn_fatal_${Date.now().toString(36)}_${nextFatalSequence.toString(36)}`;
}

function incrementBounded(value) {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
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

function utf8ByteLength(value) {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function fatalHealthSnapshot(state) {
  return Object.freeze({
    acknowledgedRecords: state.acknowledgedRecords,
    available: state.available,
    corruptRecords: state.corruptRecords,
    droppedRecords: state.droppedRecords,
    lastOutcome: state.lastOutcome,
    replayedRecords: state.replayedRecords,
    storedRecords: state.storedRecords
  });
}

function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

module.exports = { createFatalController };
