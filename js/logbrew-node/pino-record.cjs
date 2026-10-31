"use strict";

const { SdkError } = require("@logbrew/sdk");
const { isWeakKey, readOptionalMember } = require("./internal.cjs");

/**
 * @import { PinoLogRecord } from "@logbrew/sdk"
 */

const MAX_PROTOTYPE_DEPTH = 8;
const LEVEL_ARGUMENT = 2;
const PROTOTYPE_STEP = 1;

/**
 * @param {unknown} value
 * @returns {Promise<boolean>}
 */
async function settle(value) {
  try {
    await value;
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} owner
 * @param {object} logger
 * @param {string} expected
 * @returns {string | undefined}
 */
function ownPinoKey(owner, logger, expected) {
  for (const symbol of Object.getOwnPropertySymbols(owner)) {
    if (symbol.toString() === expected) {
      /** @type {unknown} */
      const value = Reflect.get(logger, symbol);
      if (typeof value === "string") {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * @param {object} logger
 * @param {string} expected
 * @returns {string | undefined}
 */
function findPinoKey(logger, expected) {
  /** @type {Set<object>} */
  const visited = new Set();
  /** @type {object | null} */
  let owner = logger;
  for (let depth = 0; owner !== null && depth < MAX_PROTOTYPE_DEPTH && !visited.has(owner); depth += PROTOTYPE_STEP) {
    visited.add(owner);
    const key = ownPinoKey(owner, logger, expected);
    if (key !== undefined) {
      return key;
    }
    owner = Reflect.getPrototypeOf(owner);
  }
  return undefined;
}

/**
 * @param {unknown} logger
 * @param {string} symbolName
 * @param {string} fallback
 * @returns {string}
 */
function getPinoKey(logger, symbolName, fallback) {
  if (!isWeakKey(logger)) {
    return fallback;
  }
  try {
    return findPinoKey(logger, `Symbol(${symbolName})`) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * @param {unknown} data
 * @returns {number | undefined}
 */
function pinoLevelNumber(data) {
  const value = readOptionalMember(readOptionalMember(data, "arguments"), LEVEL_ARGUMENT);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * @param {object} parsed
 * @returns {PinoLogRecord}
 */
function copyRecord(parsed) {
  /** @type {PinoLogRecord} */
  const record = {};
  for (const [key, value] of Object.entries(parsed)) {
    Reflect.defineProperty(record, key, { configurable: true, enumerable: true, value, writable: true });
  }
  return record;
}

/**
 * @param {unknown} data
 * @returns {readonly (readonly [string, "err" | "msg"])[]}
 */
function pinoKeyPairs(data) {
  const instance = readOptionalMember(data, "instance");
  return [
    [getPinoKey(instance, "pino.messageKey", "msg"), "msg"],
    [getPinoKey(instance, "pino.errorKey", "err"), "err"]
  ];
}

/**
 * @param {unknown} data
 * @returns {object}
 */
function parsedRecord(data) {
  const result = readOptionalMember(data, "result");
  if (typeof result !== "string") {
    throw new SdkError("validation_error", "Pino diagnostics result must be a JSON string");
  }
  /** @type {unknown} */
  const parsed = JSON.parse(result);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new SdkError("validation_error", "Pino diagnostics result must contain a JSON object");
  }
  return parsed;
}

/**
 * @param {unknown} data
 * @param {number | undefined} levelNumber
 * @returns {PinoLogRecord}
 */
function normalizedPinoRecord(data, levelNumber) {
  const record = copyRecord(parsedRecord(data));
  for (const [key, target] of pinoKeyPairs(data)) {
    if (key !== target) {
      if (record[target] === undefined) {
        record[target] = record[key];
      }
      Reflect.deleteProperty(record, key);
    }
  }
  if (record.level === undefined && levelNumber !== undefined) {
    record.level = levelNumber;
  }
  return record;
}

module.exports = { normalizedPinoRecord, pinoLevelNumber, settle };
