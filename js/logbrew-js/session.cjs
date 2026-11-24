"use strict";

const { propertyOf } = require("./error-details.cjs");
const { randomHex } = require("./random-hex.cjs");
const { isRecord } = require("./validation.cjs");

/**
 * @typedef {Readonly<{ version: number, id: string, startedAt: number, lastActiveAt: number }>} SessionRecord
 * @typedef {Readonly<{ storage?: unknown, storageKey?: string, now?: () => number }>} LogBrewSessionOptions
 */

const RECORD_VERSION = 1;
const SESSION_ID_BYTES = 16;
const INACTIVITY_TIMEOUT_MS = 1_800_000;
const MAX_DURATION_MS = 14_400_000;
const DEFAULT_STORAGE_KEY = "logbrew:session";
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/u;

/**
 * @param {unknown} storage
 * @param {string} method
 * @param {readonly unknown[]} args
 * @returns {unknown}
 */
function callStorage(storage, method, args) {
  try {
    const fn = propertyOf(storage, method);
    return typeof fn === "function" ? Reflect.apply(fn, storage, args) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} storage
 * @param {string} storageKey
 * @returns {unknown}
 */
function readRecord(storage, storageKey) {
  const text = callStorage(storage, "getItem", [storageKey]);
  try {
    return typeof text === "string" ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} record
 * @param {number} now
 * @returns {record is SessionRecord}
 */
function isLive(record, now) {
  if (!isRecord(record)) {
    return false;
  }
  const { id, lastActiveAt, startedAt, version } = record;
  return version === RECORD_VERSION
    && typeof id === "string" && SESSION_ID_PATTERN.test(id)
    && typeof startedAt === "number" && typeof lastActiveAt === "number"
    && startedAt <= lastActiveAt && lastActiveAt <= now
    && now - lastActiveAt < INACTIVITY_TIMEOUT_MS
    && now - startedAt < MAX_DURATION_MS;
}

/**
 * @param {LogBrewSessionOptions} [options]
 * @returns {{ id: () => string }}
 */
function createLogBrewSession({ storage, storageKey = DEFAULT_STORAGE_KEY, now = Date.now } = {}) {
  /** @type {unknown} */
  let record = readRecord(storage, storageKey);
  return {
    id() {
      const time = now();
      /** @type {SessionRecord} */
      const next = isLive(record, time)
        ? { ...record, lastActiveAt: time }
        : { id: randomHex(SESSION_ID_BYTES), lastActiveAt: time, startedAt: time, version: RECORD_VERSION };
      record = next;
      callStorage(storage, "setItem", [storageKey, JSON.stringify(next)]);
      return next.id;
    }
  };
}

module.exports = { createLogBrewSession };
