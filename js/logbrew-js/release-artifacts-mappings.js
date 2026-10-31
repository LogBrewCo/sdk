import { fileReference } from "./release-artifacts-common.js";
import path from "node:path";

/**
 * @typedef {{ readonly mappings: string, readonly names: unknown, readonly sources: readonly unknown[] }} ValidSourceMap
 * @typedef {{ readonly column: number, readonly line: number, readonly name?: string, readonly source: string }} OriginalPosition
 * @typedef {{ readonly shift: number, readonly value: number }} VlqAccumulator
 * @typedef {{
 *   readonly generatedColumn: number,
 *   readonly name: number,
 *   readonly originalColumn: number,
 *   readonly originalLine: number,
 *   readonly source: number
 * }} DecoderState
 * @typedef {{
 *   readonly generatedColumn: number,
 *   readonly name?: number,
 *   readonly originalColumn?: number,
 *   readonly originalLine?: number,
 *   readonly source?: number
 * }} MappingSegment
 */

const VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ_VALUES = new Map(Array.from(VLQ_CHARS, (char, index) => [char, index]));
const VLQ_CONTINUATION = 32;
const VLQ_SHIFT_STEP = 5;
const VLQ_SIGN_DIVISOR = 2;
const INT32_BITS = 32;
const BINARY_BASE = 2;
const NO_DELTA = 0;
const NEGATIVE_SIGN_BIT = 1;
const ONE_BASED_OFFSET = 1;
const GENERATED_COLUMN_ONLY = 1;
const SEGMENT_WITH_NAME = 5;
const SEGMENT_WITH_SOURCE = 4;
const SEGMENT_FIELD_COUNTS = new Set([GENERATED_COLUMN_ONLY, SEGMENT_WITH_SOURCE, SEGMENT_WITH_NAME]);
const NOT_FOUND = -1;
const LAST = -1;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/u;
const INITIAL_STATE = { generatedColumn: NO_DELTA, name: NO_DELTA, originalColumn: NO_DELTA, originalLine: NO_DELTA, source: NO_DELTA };
const EMPTY_ACCUMULATOR = { shift: NO_DELTA, value: NO_DELTA };

/**
 * @param {number} value
 * @returns {number}
 */
function toInt32(value) {
  return Number(BigInt.asIntN(INT32_BITS, BigInt(value)));
}

/**
 * @param {number} value
 * @returns {number}
 */
function signedVlqValue(value) {
  const wrapped = toInt32(value);
  const magnitude = Math.floor(wrapped / VLQ_SIGN_DIVISOR);
  return Math.abs(wrapped % VLQ_SIGN_DIVISOR) === NEGATIVE_SIGN_BIT ? -magnitude : magnitude;
}

/**
 * @param {string} char
 * @returns {number}
 */
function vlqDigit(char) {
  const digit = VLQ_VALUES.get(char);
  if (digit === undefined) {
    throw new Error("source map mappings contain an invalid base64 VLQ character");
  }
  return digit;
}

/**
 * @param {VlqAccumulator} accumulator
 * @param {string} char
 * @returns {{ readonly decoded: number | undefined, readonly next: VlqAccumulator }}
 */
function vlqStep(accumulator, char) {
  const digit = vlqDigit(char);
  const value = accumulator.value + toInt32((digit % VLQ_CONTINUATION) * BINARY_BASE ** (accumulator.shift % INT32_BITS));
  if (digit >= VLQ_CONTINUATION) {
    return { decoded: undefined, next: { shift: accumulator.shift + VLQ_SHIFT_STEP, value } };
  }
  return { decoded: signedVlqValue(value), next: EMPTY_ACCUMULATOR };
}

/**
 * @param {VlqAccumulator} accumulator
 * @returns {void}
 */
function requireTerminatedVlq(accumulator) {
  if (accumulator.shift !== NO_DELTA) {
    throw new Error("source map mappings contain an unterminated base64 VLQ value");
  }
}

/**
 * @param {string} segment
 * @returns {number[]}
 */
function decodeVlqValues(segment) {
  /** @type {number[]} */
  const values = [];
  /** @type {VlqAccumulator} */
  let accumulator = EMPTY_ACCUMULATOR;
  for (const char of segment) {
    const step = vlqStep(accumulator, char);
    accumulator = step.next;
    if (step.decoded !== undefined) {
      values.push(step.decoded);
    }
  }
  requireTerminatedVlq(accumulator);
  return values;
}

/**
 * @param {string} rawSegment
 * @returns {number[]}
 */
function decodeSegmentValues(rawSegment) {
  const values = decodeVlqValues(rawSegment);
  if (!SEGMENT_FIELD_COUNTS.has(values.length)) {
    throw new Error("source map segment must contain 1, 4, or 5 VLQ fields");
  }
  return values;
}

/**
 * @param {DecoderState} state
 * @param {readonly number[]} values
 * @returns {DecoderState}
 */
function advance(state, values) {
  const [column = NO_DELTA, source = NO_DELTA, line = NO_DELTA, originalColumn = NO_DELTA, name] = values;
  const generatedColumn = state.generatedColumn + column;
  if (values.length === GENERATED_COLUMN_ONLY) {
    return { ...state, generatedColumn };
  }
  return {
    generatedColumn,
    name: name === undefined ? state.name : state.name + name,
    originalColumn: state.originalColumn + originalColumn,
    originalLine: state.originalLine + line,
    source: state.source + source
  };
}

/**
 * @param {DecoderState} state
 * @param {number} fieldCount
 * @returns {MappingSegment}
 */
function segmentFromState({ generatedColumn, name, originalColumn, originalLine, source }, fieldCount) {
  if (fieldCount === GENERATED_COLUMN_ONLY) {
    return { generatedColumn };
  }
  const located = { generatedColumn, originalColumn, originalLine, source };
  return fieldCount === SEGMENT_WITH_NAME ? { ...located, name } : located;
}

/**
 * @param {string} rawLine
 * @param {DecoderState} initialState
 * @returns {{ readonly segments: readonly MappingSegment[], readonly state: DecoderState }}
 */
function decodeLine(rawLine, initialState) {
  /** @type {MappingSegment[]} */
  const segments = [];
  let state = { ...initialState, generatedColumn: NO_DELTA };
  for (const rawSegment of rawLine.split(",")) {
    if (rawSegment !== "") {
      const values = decodeSegmentValues(rawSegment);
      state = advance(state, values);
      segments.push(segmentFromState(state, values.length));
    }
  }
  return { segments, state };
}

/**
 * @param {string} mappings
 * @returns {readonly (readonly MappingSegment[])[]}
 */
function decodedMappingSegments(mappings) {
  /** @type {(readonly MappingSegment[])[]} */
  const lines = [];
  let state = INITIAL_STATE;
  for (const rawLine of mappings.split(";")) {
    const decoded = decodeLine(rawLine, state);
    lines.push(decoded.segments);
    ({ state } = decoded);
  }
  return lines;
}

/**
 * @param {unknown} source
 * @returns {string}
 */
function safeOriginalSourceForReport(source) {
  const value = typeof source === "string" ? fileReference(source.trim()) : "";
  if (value === "") {
    throw new Error("source map segment references an invalid source value");
  }
  if (value.startsWith("file://") || path.isAbsolute(value) || WINDOWS_DRIVE_RE.test(value)) {
    throw new Error("source map source path must be stripped before symbolication proof");
  }
  return value;
}

/**
 * @param {readonly MappingSegment[]} segments
 * @param {number} generatedColumnIndex
 * @returns {MappingSegment | undefined}
 */
function bestSegment(segments, generatedColumnIndex) {
  const firstAfter = segments.findIndex((segment) => segment.generatedColumn > generatedColumnIndex);
  return (firstAfter === NOT_FOUND ? segments : segments.slice(NO_DELTA, firstAfter)).at(LAST);
}

/**
 * @param {unknown} names
 * @param {number | undefined} nameIndex
 * @returns {{ readonly name?: string }}
 */
function originalName(names, nameIndex) {
  if (!Array.isArray(names) || nameIndex === undefined || nameIndex < NO_DELTA || nameIndex >= names.length) {
    return {};
  }
  /** @type {readonly unknown[]} */
  const list = names;
  const name = list[nameIndex];
  return typeof name === "string" && name !== "" ? { name } : {};
}

/**
 * @param {ValidSourceMap} payload
 * @param {number} generatedLine
 * @param {number} generatedColumn
 * @returns {OriginalPosition}
 */
function originalPositionFor(payload, generatedLine, generatedColumn) {
  const lines = decodedMappingSegments(payload.mappings);
  if (generatedLine - ONE_BASED_OFFSET >= lines.length) {
    throw new Error("generated line is outside source map mappings");
  }
  const best = bestSegment(lines[generatedLine - ONE_BASED_OFFSET] ?? [], generatedColumn - ONE_BASED_OFFSET);
  if (best?.source === undefined || best.originalLine === undefined || best.originalColumn === undefined) {
    throw new Error("no original source mapping found for generated frame");
  }
  const { source: sourceIndex } = best;
  if (!Number.isInteger(sourceIndex) || sourceIndex < NO_DELTA || sourceIndex >= payload.sources.length) {
    throw new Error("source map segment references an invalid source index");
  }
  return {
    column: best.originalColumn + ONE_BASED_OFFSET,
    line: best.originalLine + ONE_BASED_OFFSET,
    source: safeOriginalSourceForReport(payload.sources[sourceIndex]),
    ...originalName(payload.names, best.name)
  };
}

export { originalPositionFor };
