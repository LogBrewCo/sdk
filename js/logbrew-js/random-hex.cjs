const { propertyOf } = require("./error-details.cjs");

const BYTE_VALUES = 256;
const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;

/**
 * @param {number} byteLength
 * @returns {Uint8Array}
 */
function randomBytes(byteLength) {
  const bytes = new Uint8Array(byteLength);
  const getRandomValues = propertyOf(propertyOf(globalThis, "crypto"), "getRandomValues");
  if (typeof getRandomValues === "function") {
    Reflect.apply(getRandomValues, propertyOf(globalThis, "crypto"), [bytes]);
    return bytes;
  }
  return Uint8Array.from(bytes, () => Math.floor(Math.random() * BYTE_VALUES));
}

/**
 * @param {number} byteLength
 * @returns {string}
 */
function randomHex(byteLength) {
  return Array.from(randomBytes(byteLength), (byte) => byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, "0")).join("");
}

module.exports = { randomHex };
