"use strict";

const FATAL_RECORD_SCHEMA_VERSION = 1;
const MAX_ADMITTED_FATAL_IDS = 256;
const MAX_FATAL_FILENAME_BYTES = 512;
const MAX_FATAL_STACK_BYTES = 16 * 1024;
const MAX_FATAL_STACK_FRAMES = 24;
const MAX_FATAL_ID_LENGTH = 128;
const MAX_FATAL_RECORD_BYTES = 16 * 1024;
const DURABLE_QUEUE = Symbol.for("co.logbrew.react-native.durable-event-queue");

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
  const directAdmission = !methods && safeReadProperty(client, DURABLE_QUEUE) === true;
  const state = {
    acknowledgedRecords: 0,
    available: methods !== undefined || directAdmission,
    corruptRecords: 0,
    droppedRecords: 0,
    lastOutcome: methods || directAdmission ? "idle" : "unavailable",
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
      if (!methods) {
        return;
      }
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
      if (!methods) {
        return directAdmission
          ? admitFatalError({ client, error, eventMessage, issue, onDiagnostic, sanitizers, state })
          : false;
      }
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

function admitFatalError({ client, error, eventMessage, issue, onDiagnostic, sanitizers, state }) {
  const record = createFatalRecord(error, sanitizers);
  let admission;
  try {
    admission = captureIssueWithAdmission(
      client, issue, record.id, record.timestamp, fatalEventAttributes(record, eventMessage)
    );
  } catch {
    state.lastOutcome = "storage_error";
    emitDiagnostic(onDiagnostic, "fatal_store_failed");
    return false;
  }
  if (admission === "unavailable") {
    state.lastOutcome = "admission_unavailable";
    emitDiagnostic(onDiagnostic, "fatal_admission_unavailable");
    return false;
  }
  if (admission !== "admitted") {
    state.lastOutcome = "storage_error";
    emitDiagnostic(onDiagnostic, "fatal_store_failed");
    return false;
  }
  state.storedRecords = incrementBounded(state.storedRecords);
  state.lastOutcome = "stored";
  return true;
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

  let admission;
  try {
    admission = captureIssueWithAdmission(
      client, issue, record.id, record.timestamp, fatalEventAttributes(record, eventMessage)
    );
  } catch {
    state.lastOutcome = "replay_failed";
    emitDiagnostic(onDiagnostic, "fatal_replay_failed");
    return;
  }
  if (admission === "unavailable") {
    state.lastOutcome = "admission_unavailable";
    emitDiagnostic(onDiagnostic, "fatal_replay_admission_unavailable");
    return;
  }
  if (admission !== "admitted") {
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

function captureIssueWithAdmission(client, issue, id, timestamp, attributes) {
  const capture = safeFunction(client, "issueWithAdmission");
  if (!capture) {
    issue.call(client, id, timestamp, attributes);
    return "unavailable";
  }
  const status = resultStatus(capture.call(client, id, timestamp, attributes));
  return status === "admitted" || status === "filtered" || status === "dropped"
    ? status
    : "unavailable";
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
  const record = {
    corruptRecords: 0,
    droppedRecords: 0,
    errorName: sanitizers.errorName(error),
    id: nextFatalEventId(),
    schemaVersion: FATAL_RECORD_SCHEMA_VERSION,
    stackFrames: fatalStackFrames(error, sanitizers.stackFrame),
    timestamp: new Date().toISOString()
  };
  while (record.stackFrames.length > 0 && utf8ByteLength(JSON.stringify(record)) > MAX_FATAL_RECORD_BYTES) {
    record.stackFrames = Object.freeze(record.stackFrames.slice(0, -1));
  }
  return Object.freeze(record);
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
    ...(record.stackFrames.length === 0
      ? {}
      : { stackFrames: record.stackFrames.map((frame) => Object.freeze({ ...frame })) }),
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
      ])) {
      return undefined;
    }
    const { corruptRecords, droppedRecords, errorName, id, schemaVersion, stackFrames, timestamp } = value;
    const frameCount = Array.isArray(stackFrames) ? stackFrames.length : undefined;
    if (schemaVersion !== FATAL_RECORD_SCHEMA_VERSION
      || typeof id !== "string"
      || id.length > MAX_FATAL_ID_LENGTH
      || !/^evt_rn_fatal_[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(id)
      || !sanitizers.isErrorName(errorName)
      || !isBoundedCounter(corruptRecords)
      || !isBoundedCounter(droppedRecords)
      || !validFatalTimestamp(timestamp)
      || !isBoundedCounter(frameCount)
      || frameCount > MAX_FATAL_STACK_FRAMES) {
      return undefined;
    }
    const frames = [];
    for (let index = 0; index < frameCount; index += 1) {
      const frame = validatedFatalFrame(stackFrames[index]);
      if (!frame) {
        return undefined;
      }
      frames.push(frame);
    }
    const record = {
      corruptRecords,
      droppedRecords,
      errorName,
      id,
      schemaVersion: FATAL_RECORD_SCHEMA_VERSION,
      stackFrames: frames,
      timestamp
    };
    return utf8ByteLength(JSON.stringify(record)) <= MAX_FATAL_RECORD_BYTES ? record : undefined;
  } catch {
    return undefined;
  }
}

function validatedFatalFrame(value) {
  try {
    if (!isPlainObject(value)
      || !hasExactKeys(value, ["column", "filename", "line"])) {
      return undefined;
    }
    const { column, filename, line } = value;
    if (!validFatalFilename(filename)
      || positiveInteger(line) === undefined
      || positiveInteger(column) === undefined) {
      return undefined;
    }
    return {
      column,
      filename,
      line
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
    const status = isPlainObject(result) ? result.status : undefined;
    return typeof status === "string" ? status : undefined;
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
  return Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : undefined;
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

module.exports = { captureIssueWithAdmission, createFatalController };
