"use strict";

const { hasControlCharacter, safeReadProperty } = require("./global-errors-support.cjs");

/**
 * @typedef {Readonly<{ column: unknown, filename: string, line: unknown }>} FatalFrame
 * @typedef {Readonly<{
 *   corruptRecords: number,
 *   droppedRecords: number,
 *   errorName: unknown,
 *   id: string,
 *   schemaVersion: number,
 *   stackFrames: readonly FatalFrame[],
 *   timestamp: string
 * }>} FatalRecord
 * @typedef {Readonly<{
 *   id: string,
 *   timestamp: string,
 *   attributes: Readonly<{
 *     exception?: Readonly<{ type: string }> | undefined,
 *     stackFrames?: readonly Readonly<{ column: number, filename: string, line: number }>[] | undefined
 *   }>
 * }>} FatalEventInput
 */

const FATAL_RECORD_SCHEMA_VERSION = 1;
const MAX_FATAL_FILENAME_BYTES = 512;
const MAX_FATAL_STACK_FRAMES = 24;
const MAX_FATAL_ID_LENGTH = 128;
const MAX_FATAL_RECORD_BYTES = 16_384;
const MIN_FATAL_TIMESTAMP_LENGTH = 20;
const MAX_FATAL_TIMESTAMP_LENGTH = 35;
const MAX_FRAME_POSITION = 2_147_483_647;
const NO_COUNT = 0;
const FIRST_INDEX = 0;
const SECOND_INDEX = 1;
const MIN_POSITION = 0;
const ONE_BYTE_LIMIT = 0x7F;
const TWO_BYTE_LIMIT = 0x7_FF;
const THREE_BYTE_LIMIT = 0xFF_FF;
const ONE_BYTE = 1;
const TWO_BYTES = 2;
const THREE_BYTES = 3;
const FOUR_BYTES = 4;
const FATAL_ID_PATTERN = /^evt_rn_fatal_[a-z0-9]+(?:_[a-z0-9]+)*$/u;
const DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;
const FATAL_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;
const RECORD_KEYS = ["corruptRecords", "droppedRecords", "errorName", "id", "schemaVersion", "stackFrames", "timestamp"];
const FRAME_KEYS = ["column", "filename", "line"];

/**
 * @param {string} value
 * @returns {number}
 */
function utf8ByteLength(value) {
  let bytes = NO_COUNT;
  for (const character of value) {
    const code = character.codePointAt(FIRST_INDEX) ?? NO_COUNT;
    if (code <= ONE_BYTE_LIMIT) {
      bytes += ONE_BYTE;
    } else if (code <= TWO_BYTE_LIMIT) {
      bytes += TWO_BYTES;
    } else {
      bytes += code <= THREE_BYTE_LIMIT ? THREE_BYTES : FOUR_BYTES;
    }
  }
  return bytes;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function validFatalFilename(value) {
  return typeof value === "string"
    && value.length > NO_COUNT
    && utf8ByteLength(value) <= MAX_FATAL_FILENAME_BYTES
    && !hasControlCharacter(value)
    && !value.startsWith("/")
    && !DRIVE_PREFIX_PATTERN.test(value)
    && !value.includes("\\")
    && !value.includes("://")
    && !value.includes("?")
    && !value.includes("#")
    && !value.split("/").includes("..");
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizedStoredFatalFilename(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && value.length > SECOND_INDEX
    && !value.includes("/", SECOND_INDEX)
    ? value.slice(SECOND_INDEX)
    : value;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function validFatalTimestamp(value) {
  return typeof value === "string"
    && value.length >= MIN_FATAL_TIMESTAMP_LENGTH
    && value.length <= MAX_FATAL_TIMESTAMP_LENGTH
    && FATAL_TIMESTAMP_PATTERN.test(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isBoundedCounter(value) {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= NO_COUNT;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function positiveInteger(value) {
  return Number.isSafeInteger(value) && typeof value === "number" && value > MIN_POSITION && value <= MAX_FRAME_POSITION;
}

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  try {
    /** @type {unknown} */
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/**
 * @param {object} value
 * @param {readonly string[]} expected
 * @returns {boolean}
 */
function hasExactKeys(value, expected) {
  try {
    const keys = Object.keys(value);
    keys.sort();
    return keys.length === expected.length
      && keys.every((key, index) => key === expected[index]);
  } catch {
    return false;
  }
}

/**
 * @param {unknown} result
 * @returns {string | undefined}
 */
function resultStatus(result) {
  try {
    const status = isPlainObject(result) ? result["status"] : undefined;
    return typeof status === "string" ? status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} result
 * @param {string} property
 * @param {number} fallback
 * @returns {number}
 */
function boundedResultCounter(result, property, fallback) {
  const value = isPlainObject(result) ? safeReadProperty(result, property) : undefined;
  return isBoundedCounter(value) ? value : fallback;
}

/**
 * @param {FatalEventInput} event
 * @returns {FatalRecord}
 */
function createFatalRecord(event) {
  const { exception } = event.attributes;
  if (exception === undefined) {
    throw new TypeError("fatal event has no exception type");
  }
  const record = {
    corruptRecords: NO_COUNT,
    droppedRecords: NO_COUNT,
    errorName: exception.type,
    id: event.id,
    schemaVersion: FATAL_RECORD_SCHEMA_VERSION,
    stackFrames: (event.attributes.stackFrames ?? []).flatMap(({ column, filename, line }) => {
      const stored = normalizedStoredFatalFilename(filename);
      return validFatalFilename(stored) ? [{ column, filename: stored, line }] : [];
    }).slice(FIRST_INDEX, MAX_FATAL_STACK_FRAMES),
    timestamp: event.timestamp
  };
  while (record.stackFrames.length > NO_COUNT && utf8ByteLength(JSON.stringify(record)) > MAX_FATAL_RECORD_BYTES) {
    record.stackFrames.pop();
  }
  return record;
}

/**
 * @param {unknown} value
 * @returns {FatalFrame | undefined}
 */
function validatedFatalFrame(value) {
  try {
    if (!isPlainObject(value) || !hasExactKeys(value, FRAME_KEYS)) {
      return undefined;
    }
    const { column, filename, line } = value;
    if (!validFatalFilename(filename) || !positiveInteger(line) || !positiveInteger(column)) {
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

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isList(value) {
  return Array.isArray(value);
}

/**
 * @param {readonly unknown[]} stackFrames
 * @param {number} frameCount
 * @returns {FatalFrame[] | undefined}
 */
function validatedFatalFrames(stackFrames, frameCount) {
  /** @type {FatalFrame[]} */
  const frames = [];
  for (let index = FIRST_INDEX; index < frameCount; index += SECOND_INDEX) {
    const frame = validatedFatalFrame(stackFrames[index]);
    if (!frame) {
      return undefined;
    }
    frames.push(frame);
  }
  return frames;
}

/**
 * @param {unknown} value
 * @param {(value: unknown) => boolean} isErrorName
 * @returns {FatalRecord | undefined}
 */
function readFatalRecord(value, isErrorName) {
  if (!isPlainObject(value) || !hasExactKeys(value, RECORD_KEYS)) {
    return undefined;
  }
  const { corruptRecords, droppedRecords, errorName, id, schemaVersion, stackFrames, timestamp } = value;
  const frameCount = isList(stackFrames) ? stackFrames.length : undefined;
  if (schemaVersion !== FATAL_RECORD_SCHEMA_VERSION
    || typeof id !== "string"
    || id.length > MAX_FATAL_ID_LENGTH
    || !FATAL_ID_PATTERN.test(id)
    || !isErrorName(errorName)
    || !isBoundedCounter(corruptRecords)
    || !isBoundedCounter(droppedRecords)
    || !validFatalTimestamp(timestamp)
    || !isBoundedCounter(frameCount)
    || frameCount > MAX_FATAL_STACK_FRAMES
    || !isList(stackFrames)) {
    return undefined;
  }
  const frames = validatedFatalFrames(stackFrames, frameCount);
  const record = frames && {
    corruptRecords,
    droppedRecords,
    errorName,
    id,
    schemaVersion: FATAL_RECORD_SCHEMA_VERSION,
    stackFrames: frames,
    timestamp
  };
  return record && utf8ByteLength(JSON.stringify(record)) <= MAX_FATAL_RECORD_BYTES ? record : undefined;
}

/**
 * @param {unknown} value
 * @param {(value: unknown) => boolean} isErrorName
 * @returns {FatalRecord | undefined}
 */
function validatedFatalRecord(value, isErrorName) {
  try {
    return readFatalRecord(value, isErrorName);
  } catch {
    return undefined;
  }
}

module.exports = {
  boundedResultCounter,
  createFatalRecord,
  isPlainObject,
  resultStatus,
  validatedFatalRecord
};
