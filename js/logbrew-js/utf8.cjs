const ONE_BYTE_LIMIT = 0x80;
const TWO_BYTE_LIMIT = 0x8_00;
const THREE_BYTE_LIMIT = 0x1_00_00;
const ONE_BYTE = 1;
const TWO_BYTES = 2;
const THREE_BYTES = 3;
const FOUR_BYTES = 4;
const NO_BYTES = 0;

/**
 * @param {string} character
 * @returns {number}
 */
function characterBytes(character) {
  const codePoint = character.codePointAt(NO_BYTES) ?? NO_BYTES;
  if (codePoint < ONE_BYTE_LIMIT) {
    return ONE_BYTE;
  }
  if (codePoint < TWO_BYTE_LIMIT) {
    return TWO_BYTES;
  }
  return codePoint < THREE_BYTE_LIMIT ? THREE_BYTES : FOUR_BYTES;
}

/**
 * @param {string} value
 * @returns {number}
 */
function utf8ByteLength(value) {
  let bytes = NO_BYTES;
  for (const character of value) {
    bytes += characterBytes(character);
  }
  return bytes;
}

module.exports = { utf8ByteLength };
