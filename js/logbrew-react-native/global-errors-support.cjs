"use strict";

/**
 * @typedef {(this: unknown, ...args: readonly unknown[]) => unknown} UnknownFunction
 * @typedef {(diagnostic: Readonly<{ code: string }>) => unknown} DiagnosticListener
 * @typedef {Readonly<{ emit: (code: string) => void }>} DiagnosticEmitter
 */

const STEP = 1;
const LAST_C0_CONTROL = 31;
const DELETE_CONTROL = 127;
const FIRST_INDEX = 0;

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

/**
 * @param {unknown} value
 * @returns {value is UnknownFunction}
 */
function isFunction(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @param {PropertyKey} property
 * @returns {unknown}
 */
function safeReadProperty(value, property) {
  if (!isObjectLike(value)) {
    return undefined;
  }
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @param {PropertyKey} property
 * @returns {UnknownFunction | undefined}
 */
function safeFunction(value, property) {
  const candidate = safeReadProperty(value, property);
  return isFunction(candidate) ? candidate : undefined;
}

/**
 * @param {number} value
 * @returns {number}
 */
function incrementBounded(value) {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + STEP;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(FIRST_INDEX);
    return code !== undefined && (code <= LAST_C0_CONTROL || code === DELETE_CONTROL);
  });
}

/**
 * @param {unknown} onDiagnostic
 * @param {string} code
 * @returns {boolean}
 */
function emitDiagnostic(onDiagnostic, code) {
  if (!isFunction(onDiagnostic)) {
    return false;
  }
  try {
    onDiagnostic(Object.freeze({ code }));
    return true;
  } catch {
    return false;
  }
}

class DiagnosticGate {
  emitting = false;

  /**
   * @param {unknown} onDiagnostic
   */
  constructor(onDiagnostic) {
    this.onDiagnostic = onDiagnostic;
  }

  /**
   * @param {string} code
   * @returns {void}
   */
  emit(code) {
    if (this.emitting) {
      return;
    }
    this.emitting = true;
    try {
      emitDiagnostic(this.onDiagnostic, code);
    } finally {
      this.emitting = false;
    }
  }
}

module.exports = {
  DiagnosticGate,
  emitDiagnostic,
  hasControlCharacter,
  incrementBounded,
  isFunction,
  isObjectLike,
  safeFunction,
  safeReadProperty
};
