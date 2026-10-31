"use strict";

const { randomBytes } = require("node:crypto");

const MAX_EVENT_ID_LENGTH = 200;
const RANDOM_SUFFIX_BYTES = 16;
const SEPARATOR_COUNT = 2;
const START = 0;

/**
 * @param {string} prefix
 * @param {unknown} semanticValue
 * @returns {string}
 */
function createAutomaticEventId(prefix, semanticValue) {
  const suffix = randomBytes(RANDOM_SUFFIX_BYTES).toString("hex");
  const maxSemanticLength = MAX_EVENT_ID_LENGTH - prefix.length - suffix.length - SEPARATOR_COUNT;
  const semantic = String(semanticValue).slice(START, maxSemanticLength) || "event";
  return `${prefix}_${semantic}_${suffix}`;
}

module.exports = { createAutomaticEventId };
