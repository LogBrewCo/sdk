"use strict";

const TEXT_START = 0;
const MAX_URL_LENGTH = 256;
const LAST_C0_CONTROL = 31;
const FIRST_C1_CONTROL = 127;
const LAST_C1_CONTROL = 159;
const WHITESPACE_PATTERN = /\s+/gu;

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isWeakKey(value) {
  return isObjectLike(value) || typeof value === "function";
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {unknown}
 */
function readMember(value, name) {
  if (isWeakKey(value)) {
    return Reflect.get(value, name);
  }
  if (value === undefined || value === null) {
    throw new TypeError(`Cannot read properties of ${String(value)} (reading '${name}')`);
  }
  return Reflect.get(new Object(value), name);
}

/**
 * @param {() => void} operation
 * @returns {boolean}
 */
function attempt(operation) {
  try {
    operation();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} target
 * @param {string} name
 * @param {readonly unknown[]} args
 * @returns {unknown}
 */
function callOptional(target, name, args) {
  const method = readMember(target, name);
  if (method === undefined || method === null) {
    return undefined;
  }
  if (typeof method !== "function") {
    throw new TypeError(`${name} is not a function`);
  }
  /** @type {unknown} */
  const result = Reflect.apply(method, target, args);
  return result;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function templateText(value) {
  if (typeof value === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  return String(value);
}

/**
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
function boundedText(value, limit) {
  const characters = Array.from(String(value), (character) => {
    const code = character.codePointAt(TEXT_START) ?? TEXT_START;
    return code <= LAST_C0_CONTROL || (code >= FIRST_C1_CONTROL && code <= LAST_C1_CONTROL) ? " " : character;
  });
  return [...characters.join("").replaceAll(WHITESPACE_PATTERN, " ").trim()].slice(TEXT_START, limit).join("");
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function sanitizeUrl(value) {
  try {
    const url = new URL(templateText(value));
    return boundedText(`${url.protocol}//${url.host}${url.pathname}`, MAX_URL_LENGTH);
  } catch {
    return undefined;
  }
}

module.exports = {
  attempt,
  boundedText,
  callOptional,
  isObjectLike,
  isWeakKey,
  readMember,
  sanitizeUrl,
  templateText
};
