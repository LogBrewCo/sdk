"use strict";

const NOT_FOUND = -1;
const TEXT_START = 0;
const MARKER_WIDTH = 1;
const NO_OFFSET = 0;
const MIN_FRAME_COORDINATE = 1;
const LAST_CONTROL_CHARACTER = 31;
const DELETE_CHARACTER = 127;
const FILE_URL_PREFIX = "file://";
const SAFE_DEBUG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FRAME_COORDINATE_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const TRAILING_SLASHES_PATTERN = /\/+$/u;
const LOCAL_ABSOLUTE_PATH_PATTERN = /(?:^|\s)(?:\/(?:Users|home|private|tmp|var|Volumes)\/|[A-Za-z]:[\\/])/u;

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(TEXT_START);
    return code !== undefined && (code <= LAST_CONTROL_CHARACTER || code === DELETE_CHARACTER);
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
function basename(value) {
  const normalized = value.replaceAll("\\", "/").replace(TRAILING_SLASHES_PATTERN, "");
  const marker = normalized.lastIndexOf("/");
  return marker === NOT_FOUND ? normalized : normalized.slice(marker + MARKER_WIDTH);
}

/**
 * @param {string} text
 * @param {string} marker
 * @returns {string}
 */
function beforeFirst(text, marker) {
  const index = text.indexOf(marker);
  return index === NOT_FOUND ? text : text.slice(TEXT_START, index);
}

/**
 * @param {string} value
 * @returns {string}
 */
function sanitizeFrameFilename(value) {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }
  const withoutQuery = beforeFirst(beforeFirst(trimmed, "?"), "#");
  const filename = withoutQuery.startsWith(FILE_URL_PREFIX) ? withoutQuery.slice(FILE_URL_PREFIX.length) : withoutQuery;
  return LOCAL_ABSOLUTE_PATH_PATTERN.test(filename) ? basename(filename) : filename;
}

/**
 * @param {unknown} value
 * @param {number} [offset]
 * @returns {number | undefined}
 */
function frameCoordinateFromText(value, offset = NO_OFFSET) {
  const text = String(value);
  if (!FRAME_COORDINATE_PATTERN.test(text)) {
    return undefined;
  }
  const parsed = Number(text) + offset;
  return Number.isSafeInteger(parsed) && parsed >= MIN_FRAME_COORDINATE ? parsed : undefined;
}

/**
 * @param {string} value
 * @param {number} maxLength
 * @param {boolean} rejectLocationText
 * @returns {string | undefined}
 */
function frameIdentity(value, maxLength, rejectLocationText) {
  const identity = value.trim();
  if (
    identity === ""
    || [...identity].length > maxLength
    || hasControlCharacter(identity)
    || (rejectLocationText && (identity.includes("?") || identity.includes("#")))
  ) {
    return undefined;
  }
  return identity;
}

module.exports = {
  SAFE_DEBUG_ID_PATTERN,
  basename,
  frameCoordinateFromText,
  frameIdentity,
  hasControlCharacter,
  sanitizeFrameFilename
};
