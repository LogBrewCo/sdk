const { errorCauseType, isObjectLike, safeProperty } = require("./error-details.cjs");

/**
 * @typedef {{
 *   errorCauseCount?: number,
 *   errorCauseTypes?: string,
 *   errorCauseSources?: string,
 *   errorExceptionGroup?: true,
 *   errorCauseTruncated?: true
 * }} ErrorCauseMetadata
 */

const MAX_ERROR_CAUSES = 5;
const NO_CAUSES = 0;

class ErrorCauseCollector {
  constructor() {
    /** @type {Readonly<{ source: string, type: string }>[]} */
    this.items = [];
    /** @type {Set<object>} */
    this.seen = new Set();
    this.sawExceptionGroup = false;
    this.truncated = false;
  }

  /**
   * @param {unknown} value
   * @param {string} source
   * @returns {void}
   */
  collect(value, source) {
    if (value === undefined || value === null) {
      return;
    }
    if (this.items.length >= MAX_ERROR_CAUSES) {
      this.truncated = true;
      return;
    }
    if (!this.markSeen(value)) {
      return;
    }
    this.items.push({ source, type: errorCauseType(value) });
    this.collectNested(value);
  }

  /**
   * @param {unknown} value
   * @returns {boolean}
   */
  markSeen(value) {
    if (!isObjectLike(value)) {
      return true;
    }
    if (this.seen.has(value)) {
      this.truncated = true;
      return false;
    }
    this.seen.add(value);
    return true;
  }

  /**
   * @param {unknown} parent
   * @returns {void}
   */
  collectNested(parent) {
    if (!isObjectLike(parent)) {
      return;
    }
    this.collectCause(parent);
    this.collectErrors(parent);
  }

  /**
   * @param {object} parent
   * @returns {void}
   */
  collectCause(parent) {
    const cause = safeProperty(parent, "cause");
    if (!cause.available) {
      this.truncated = true;
    } else if (cause.value !== undefined && cause.value !== null) {
      this.collect(cause.value, "cause");
    }
  }

  /**
   * @param {object} parent
   * @returns {void}
   */
  collectErrors(parent) {
    const errors = safeProperty(parent, "errors");
    if (!errors.available) {
      this.truncated = true;
    } else if (Array.isArray(errors.value)) {
      this.sawExceptionGroup = true;
      /** @type {readonly unknown[]} */
      const children = errors.value;
      for (const [index, child] of children.entries()) {
        this.collect(child, `errors[${index}]`);
      }
    }
  }
}

/**
 * @param {unknown} error
 * @returns {ErrorCauseMetadata}
 */
function errorCauseMetadata(error) {
  const collector = new ErrorCauseCollector();
  if (isObjectLike(error)) {
    collector.seen.add(error);
    collector.collectNested(error);
  }
  if (collector.items.length === NO_CAUSES) {
    return {};
  }
  return {
    errorCauseCount: collector.items.length,

    errorCauseTypes: collector.items.map((item) => item.type).join(","),

    errorCauseSources: collector.items.map((item) => item.source).join(","),
    ...(collector.sawExceptionGroup ? { errorExceptionGroup: true } : {}),
    ...(collector.truncated ? { errorCauseTruncated: true } : {})
  };
}

module.exports = { errorCauseMetadata };
