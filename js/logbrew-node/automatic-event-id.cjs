"use strict";

const { randomBytes } = require("node:crypto");

const MAX_EVENT_ID_LENGTH = 200;
const RANDOM_SUFFIX_BYTES = 16;

function createAutomaticEventId(prefix, semanticValue) {
  const suffix = randomBytes(RANDOM_SUFFIX_BYTES).toString("hex");
  const maxSemanticLength = MAX_EVENT_ID_LENGTH - prefix.length - suffix.length - 2;
  const semantic = String(semanticValue).slice(0, maxSemanticLength) || "event";
  return `${prefix}_${semantic}_${suffix}`;
}

module.exports = { createAutomaticEventId };
