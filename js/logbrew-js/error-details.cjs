const { stringOrUndefined } = require("./validation.cjs");

/**
 * @typedef {{ available: true, value: unknown } | { available: false, value: undefined }} PropertyRead
 * @typedef {{ name: string, message?: string | undefined, stack?: string | undefined }} ErrorDetails
 */

const TYPE_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const BUILTIN_ERROR_NAMES = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError"
]);

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

/**
 * @param {object} value
 * @param {string} name
 * @returns {PropertyRead}
 */
function safeProperty(value, name) {
  try {
    /** @type {unknown} */
    const property = Reflect.get(value, name);
    return { available: true, value: property };
  } catch {
    return { available: false, value: undefined };
  }
}

/**
 * @param {Readonly<PropertyRead>} property
 * @returns {string | undefined}
 */
function nonBlankText(property) {
  return property.available ? stringOrUndefined(property.value) : undefined;
}

/**
 * @param {unknown} error
 * @returns {ErrorDetails}
 */
function errorDetails(error) {
  if (error instanceof Error || (typeof error === "object" && error !== null)) {
    const name = safeProperty(error, "name");
    const message = safeProperty(error, "message");
    const stack = safeProperty(error, "stack");
    return {
      name: nonBlankText(name) ?? "Error",

      message: nonBlankText(message),

      stack: nonBlankText(stack)
    };
  }
  if (typeof error === "string" && error.trim() !== "") {
    return { message: error, name: "Error" };
  }
  return { name: "Error" };
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function safeCauseTypeName(value) {
  return typeof value === "string" && TYPE_NAME_PATTERN.test(value) ? value : undefined;
}

/**
 * @param {object} value
 * @returns {string | undefined}
 */
function constructorTypeName(value) {
  const constructor = safeProperty(value, "constructor");
  if (!constructor.available || !isObjectLike(constructor.value)) {
    return undefined;
  }
  const name = safeProperty(constructor.value, "name");
  return name.available ? safeCauseTypeName(name.value) : undefined;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function errorCauseType(value) {
  if (!isObjectLike(value)) {
    return "NonError";
  }
  const constructorName = constructorTypeName(value);
  if (!(value instanceof Error)) {
    return constructorName ?? "Object";
  }
  if (constructorName !== undefined && constructorName !== "Error") {
    return constructorName;
  }
  const name = safeProperty(value, "name");
  const builtinName = name.available && typeof name.value === "string" && BUILTIN_ERROR_NAMES.has(name.value) ? name.value : undefined;
  return builtinName ?? constructorName ?? "Error";
}

module.exports = { errorCauseType, errorDetails, isObjectLike, safeProperty };
