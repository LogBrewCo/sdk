"use strict";

const { SdkError } = require("./sdk-error.cjs");
const { hasUnicodeControlCharacter } = require("./validation.cjs");

const MACHINE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
const LOCATION_TEXT_PATTERN = /[?#]/u;

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {string}
 */
function requireMachineName(label, value) {
  if (typeof value !== "string" || !MACHINE_NAME_PATTERN.test(value)) {
    throw new SdkError("validation_error", `${label} must match ${MACHINE_NAME_PATTERN}`);
  }
  return value;
}

/**
 * @param {string} label
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
function boundedText(label, value, maxLength) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "") {
    throw new SdkError("validation_error", `${label} must be non-empty`);
  }
  if ([...normalized].length > maxLength || hasUnicodeControlCharacter(normalized)) {
    throw new SdkError("validation_error", `${label} is invalid or exceeds ${maxLength} characters`);
  }
  return normalized;
}

/**
 * @param {string} label
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
function boundedIdentity(label, value, maxLength) {
  const normalized = boundedText(label, value, maxLength);
  if (LOCATION_TEXT_PATTERN.test(normalized)) {
    throw new SdkError("validation_error", `${label} is invalid or exceeds ${maxLength} characters`);
  }
  return normalized;
}

/**
 * @param {string} label
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string | undefined}
 */
function optionalText(label, value, maxLength) {
  return value === undefined ? undefined : boundedText(label, value, maxLength);
}

/**
 * @param {string} label
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string | undefined}
 */
function optionalIdentity(label, value, maxLength) {
  return value === undefined ? undefined : boundedIdentity(label, value, maxLength);
}

module.exports = { boundedIdentity, boundedText, optionalIdentity, optionalText, requireMachineName };
