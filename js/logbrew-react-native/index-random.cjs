const { SdkError } = require("@logbrew/sdk");
const { readField } = require("./index-values.cjs");

/**
 * @typedef {{ readonly getRandomValues: (bytes: Uint8Array) => Uint8Array }} RandomSource
 * @typedef {(length: number) => ArrayLike<number>} RandomValues
 */

const NATIVE_RANDOM_HEX = Symbol.for("co.logbrew.react-native.secure-random-hex");
const HEX_RADIX = 16;
const BYTE_HEX_WIDTH = 2;
const MIN_BYTE = 0;
const MAX_BYTE = 255;
const EVENT_ID_BYTES = 16;
const NATIVE_HEX_RE = /^[0-9a-f]+$/iu;

/**
 * @param {unknown} value
 * @returns {value is RandomSource}
 */
function isRandomSource(value) {
  return typeof readField(value, "getRandomValues") === "function";
}

/**
 * @param {unknown} value
 * @returns {value is (length: number) => unknown}
 */
function isNativeRandom(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is RandomValues}
 */
function isRandomValues(value) {
  return typeof value === "function";
}

/**
 * @returns {SdkError}
 */
function secureRandomError() {
  return new SdkError("configuration_error", "React Native secure random values are unavailable");
}

/**
 * @param {(length: number) => unknown} nativeRandom
 * @param {number} length
 * @returns {unknown}
 */
function callNativeRandom(nativeRandom, length) {
  try {
    return nativeRandom(length);
  } catch {
    throw secureRandomError();
  }
}

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function nativeRandomValues(length) {
  /** @type {unknown} */
  const nativeRandom = Reflect.get(globalThis, NATIVE_RANDOM_HEX);
  if (!isNativeRandom(nativeRandom)) {
    throw secureRandomError();
  }
  const nativeHex = callNativeRandom(nativeRandom, length);
  if (typeof nativeHex !== "string" || nativeHex.length !== length * BYTE_HEX_WIDTH || !NATIVE_HEX_RE.test(nativeHex)) {
    throw secureRandomError();
  }
  return Uint8Array.from({ length }, (_byte, index) => Number.parseInt(nativeHex.slice(index * BYTE_HEX_WIDTH, index * BYTE_HEX_WIDTH + BYTE_HEX_WIDTH), HEX_RADIX));
}

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function defaultRandomValues(length) {
  const bytes = new Uint8Array(length);
  const cryptoObject = readField(globalThis, "crypto");
  if (isRandomSource(cryptoObject)) {
    return cryptoObject.getRandomValues(bytes);
  }
  const expoCrypto = readField(readField(readField(globalThis, "expo"), "modules"), "ExpoCrypto");
  if (isRandomSource(expoCrypto)) {
    expoCrypto.getRandomValues(bytes);
    return bytes;
  }
  return nativeRandomValues(length);
}

/**
 * @param {number} length
 * @param {unknown} randomValues
 * @returns {string}
 */
function randomHex(length, randomValues) {
  if (!isRandomValues(randomValues)) {
    throw new SdkError("configuration_error", "randomValues must be a function");
  }
  const bytes = Array.from(randomValues(length), value => value);
  if (bytes.length !== length || bytes.some(value => !Number.isInteger(value) || value < MIN_BYTE || value > MAX_BYTE)) {
    throw new SdkError("configuration_error", "randomValues must return byte values for the requested length");
  }
  return bytes.map(value => value.toString(HEX_RADIX).padStart(BYTE_HEX_WIDTH, "0")).join("");
}

/**
 * @param {string} kind
 * @returns {string}
 */
function defaultEventId(kind) {
  return `evt_native_${kind}_${randomHex(EVENT_ID_BYTES, defaultRandomValues)}`;
}

module.exports = { defaultEventId, defaultRandomValues, randomHex };
