const FIRST_CODE_POINT = 0;
const LAST_C0_CONTROL = 0x1F;
const FIRST_C1_CONTROL = 0x7F;
const LAST_C1_CONTROL = 0x9F;
const ONE_BYTE_LIMIT = 0x7F;
const TWO_BYTE_LIMIT = 0x7_FF;
const THREE_BYTE_LIMIT = 0xFF_FF;
const ONE_BYTE = 1;
const TWO_BYTES = 2;
const THREE_BYTES = 3;
const FOUR_BYTES = 4;
const NO_BYTES = 0;
const MIN_COUNT = 0;

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isCount(value) {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= MIN_COUNT;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function readField(value, key) {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? Reflect.get(value, key)
    : undefined;
}

/**
 * @param {object} value
 * @param {string} key
 * @returns {boolean}
 */
function hasOwnKey(value, key) {
  return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

/**
 * @param {string} character
 * @returns {number}
 */
function codePointOf(character) {
  return character.codePointAt(FIRST_CODE_POINT) ?? FIRST_CODE_POINT;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasControlCharacter(value) {
  for (const scalar of value) {
    const codePoint = codePointOf(scalar);
    if (codePoint <= LAST_C0_CONTROL || (codePoint >= FIRST_C1_CONTROL && codePoint <= LAST_C1_CONTROL)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {number} codePoint
 * @returns {number}
 */
function scalarBytes(codePoint) {
  if (codePoint <= ONE_BYTE_LIMIT) {
    return ONE_BYTE;
  }
  if (codePoint <= TWO_BYTE_LIMIT) {
    return TWO_BYTES;
  }
  return codePoint <= THREE_BYTE_LIMIT ? THREE_BYTES : FOUR_BYTES;
}

/**
 * @param {string} value
 * @returns {number}
 */
function utf8Length(value) {
  let bytes = NO_BYTES;
  for (const scalar of value) {
    bytes += scalarBytes(codePointOf(scalar));
  }
  return bytes;
}

/**
 * @param {unknown} target
 * @param {string} method
 * @param {readonly unknown[]} args
 * @returns {{ found: false } | { found: true, call: () => unknown }}
 */
function nativeMethod(target, method, args) {
  const candidate = readField(target, method);
  if (typeof candidate !== "function") {
    return { found: false };
  }
  return {
    call() {
      /** @type {unknown} */
      const result = Reflect.apply(candidate, target, args);
      return result;
    },
    found: true
  };
}

export { hasControlCharacter, hasOwnKey, isCount, isRecord, nativeMethod, readField, utf8Length };
