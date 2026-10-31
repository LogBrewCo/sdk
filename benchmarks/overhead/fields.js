/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function readField(value, key) {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} value
 * @returns {readonly unknown[]}
 */
function readList(value) {
  return Array.isArray(value) ? value : [];
}

export { readField, readList };
