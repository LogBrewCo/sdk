import { SdkError } from "@logbrew/sdk";
import { isRecord, readField } from "./values.js";

/**
 * @import { TelemetryContext } from "@logbrew/sdk"
 */

/**
 * @typedef {{ version: 1, id: string, createdAt: number, expiresAt: number }} AnonymousSubjectRecord
 * @typedef {{ enable: () => void, disable: () => void, reset: () => void }} AnonymousSubjectControls
 * @typedef {{ controls: AnonymousSubjectControls, provider: () => TelemetryContext | undefined }} AnonymousSubject
 */

const STORAGE_KEY = "logbrew:browser:anonymous-subject";
const RECORD_VERSION = 1;
const CONTEXT_SCHEMA_VERSION = 1;
const DAY_MS = 86_400_000;
const MAX_AGE_DAYS = 395;
const MIN_AGE_DAYS = 1;
const MAX_ID_LENGTH = 200;
const UUID_BYTES = 16;
const VERSION_BYTE = 6;
const VARIANT_BYTE = 8;
const VERSION_MASK = 0x0f;
const VERSION_4 = 0x40;
const VARIANT_MASK = 0x3f;
const VARIANT_RFC = 0x80;
const HEX_RADIX = 16;
const UUID_GROUP_ENDS = [8, 12, 16, 20];

/**
 * @param {unknown} option
 * @returns {{ enabled: boolean, maxAgeMs: number }}
 */
function anonymousSubjectSettings(option) {
  if (option === undefined || typeof option === "boolean") {
    return { enabled: option === true, maxAgeMs: MAX_AGE_DAYS * DAY_MS };
  }
  if (!isRecord(option)) {
    throw new SdkError("configuration_error", "anonymousSubject must be true, false, or { maxAgeDays }");
  }
  const maxAgeDays = readField(option, "maxAgeDays") ?? MAX_AGE_DAYS;
  if (typeof maxAgeDays !== "number" || !Number.isInteger(maxAgeDays) || maxAgeDays < MIN_AGE_DAYS || maxAgeDays > MAX_AGE_DAYS) {
    throw new SdkError("configuration_error", `anonymousSubject.maxAgeDays must be a whole number from ${MIN_AGE_DAYS} to ${MAX_AGE_DAYS}`);
  }
  return { enabled: true, maxAgeMs: maxAgeDays * DAY_MS };
}

/**
 * @param {unknown} browserCrypto
 * @returns {string | undefined}
 */
function randomUuid(browserCrypto) {
  const randomUUID = readField(browserCrypto, "randomUUID");
  if (typeof randomUUID === "function") {
    return String(Reflect.apply(randomUUID, browserCrypto, []));
  }
  const getRandomValues = readField(browserCrypto, "getRandomValues");
  if (typeof getRandomValues !== "function") {
    return undefined;
  }
  const bytes = new Uint8Array(UUID_BYTES);
  Reflect.apply(getRandomValues, browserCrypto, [bytes]);
  bytes[VERSION_BYTE] = (bytes[VERSION_BYTE] & VERSION_MASK) | VERSION_4;
  bytes[VARIANT_BYTE] = (bytes[VARIANT_BYTE] & VARIANT_MASK) | VARIANT_RFC;
  const hex = Array.from(bytes, (byte) => byte.toString(HEX_RADIX).padStart(2, "0")).join("");
  return [0, ...UUID_GROUP_ENDS].map((start, index) => hex.slice(start, UUID_GROUP_ENDS[index])).join("-");
}

/**
 * @param {unknown} value
 * @param {number} now
 * @param {number} maxAgeMs
 * @returns {value is AnonymousSubjectRecord}
 */
function isLiveRecord(value, now, maxAgeMs) {
  const id = readField(value, "id");
  const expiresAt = readField(value, "expiresAt");
  return readField(value, "version") === RECORD_VERSION
    && typeof id === "string" && id !== "" && id.length <= MAX_ID_LENGTH
    && Number.isFinite(readField(value, "createdAt"))
    && typeof expiresAt === "number" && expiresAt > now && expiresAt - now <= maxAgeMs;
}

/**
 * @param {Window} browserWindow
 * @returns {unknown}
 */
function readStoredRecord(browserWindow) {
  try {
    const text = browserWindow.localStorage.getItem(STORAGE_KEY);
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Keeps one random anonymous ID in first-party storage for at most maxAgeDays from its creation.
 * The lifetime is fixed when the ID is created and never extends on later visits.
 * When localStorage throws, the ID lives in page memory only.
 *
 * @param {Window} browserWindow
 * @param {unknown} option
 * @returns {AnonymousSubject}
 */
function createAnonymousSubject(browserWindow, option) {
  const settings = anonymousSubjectSettings(option);
  let { enabled } = settings;
  /** @type {AnonymousSubjectRecord | undefined} */
  let unsaved;

  /** @returns {AnonymousSubjectRecord | undefined} */
  function currentRecord() {
    const now = Date.now();
    const live = [readStoredRecord(browserWindow), unsaved].find((value) => isLiveRecord(value, now, settings.maxAgeMs));
    if (live !== undefined) {
      return /** @type {AnonymousSubjectRecord} */ (live);
    }
    const id = randomUuid(readField(browserWindow, "crypto") ?? globalThis.crypto);
    if (id === undefined) {
      return undefined;
    }
    /** @type {AnonymousSubjectRecord} */
    const record = { version: RECORD_VERSION, id, createdAt: now, expiresAt: now + settings.maxAgeMs };
    try {
      browserWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
      unsaved = undefined;
    } catch {
      unsaved = record;
    }
    return record;
  }

  function reset() {
    unsaved = undefined;
    try {
      browserWindow.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage that cannot be read holds no ID to remove.
    }
  }

  return {
    controls: {
      disable() {
        enabled = false;
        reset();
      },
      enable() {
        enabled = true;
      },
      reset
    },
    provider() {
      const record = enabled ? currentRecord() : undefined;
      return record === undefined ? undefined : { schemaVersion: CONTEXT_SCHEMA_VERSION, subject: { id: record.id, kind: "anonymous" } };
    }
  };
}

export { createAnonymousSubject };
