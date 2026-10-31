"use strict";

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFunction(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isObjectLike(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {PropertyKey} key
 * @returns {unknown}
 */
function readField(value, key) {
  return isObjectLike(value) ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} value
 * @returns {value is Iterable<unknown>}
 */
function isIterable(value) {
  return typeof value !== "string" && isFunction(readField(value, Symbol.iterator));
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function slugify(value) {
  return String(value)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "") || "event";
}

/**
 * @param {unknown} target
 * @param {PropertyKey} name
 * @param {readonly unknown[]} args
 * @returns {unknown}
 */
function callMethod(target, name, args) {
  const method = readField(target, name);
  return typeof method === "function" ? Reflect.apply(method, target, args) : undefined;
}

/**
 * @returns {typeof fetch | undefined}
 */
function defaultFetch() {
  return isFunction(globalThis.fetch) ? globalThis.fetch.bind(globalThis) : undefined;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function errorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

module.exports = {
  callMethod,
  defaultFetch,
  errorMessage,
  isFunction,
  isIterable,
  isList,
  isObjectLike,
  isRecord,
  readField,
  slugify,
  stringOrUndefined
};
