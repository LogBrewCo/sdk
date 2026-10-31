import {
  byteSize,
  fileReference,
  isDirectory,
  isFile,
  pathExists,
  readText,
  realPath,
  relativeTo,
  safeResolve
} from "./release-artifacts-common.js";
import path from "node:path";

/**
 * @import { OriginalPosition } from "./release-artifacts-mappings.js"
 * @typedef {{ readonly contextLines: number, readonly sourceRoot: string }} SourceContextOptions
 * @typedef {{ readonly highlighted: boolean, readonly line: number, readonly text: string }} SourceContextLine
 * @typedef {{ readonly lines: readonly SourceContextLine[], readonly source: string, readonly startLine: number }} SourceContext
 */

const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 10;
const MIN_CONTEXT_LINES = 0;
const MAX_SOURCE_CONTEXT_FILE_BYTES = 1_048_576;
const FIRST_LINE = 1;
const FIRST_PART = 0;
const NOT_FOUND = -1;
const BUNDLER_PROJECT_SEGMENT_RE = /^\[[^\]/]+\]$/u;
const LEADING_SLASHES_RE = /^\/+/u;
const LINE_BREAK_RE = /\r?\n/u;
const URL_WITH_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/u;
const BUNDLER_MARKERS = ["/./", "!./"];

/**
 * @param {number | undefined} value
 * @returns {number}
 */
function requireContextLineCount(value) {
  if (value === undefined) {
    return DEFAULT_CONTEXT_LINES;
  }
  if (!Number.isInteger(value) || value < MIN_CONTEXT_LINES || value > MAX_CONTEXT_LINES) {
    throw new Error("source context line count must be an integer from 0 to 10");
  }
  return value;
}

/**
 * @param {string} candidate
 * @returns {string}
 */
function cleanedReference(candidate) {
  return fileReference(candidate.trim()).replaceAll("\\", "/");
}

/**
 * @param {string} candidate
 * @returns {string | undefined}
 */
function relativeCandidate(candidate) {
  const cleaned = cleanedReference(candidate);
  if (cleaned === "" || cleaned.startsWith("file://") || WINDOWS_DRIVE_RE.test(cleaned)) {
    return undefined;
  }
  const normalized = path.posix.normalize(cleaned.replace(LEADING_SLASHES_RE, ""));
  if (normalized === "" || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    return undefined;
  }
  return normalized;
}

/**
 * @param {string} candidate
 * @returns {string[]}
 */
function bundlerSuffixes(candidate) {
  const cleaned = cleanedReference(candidate);
  const markerSuffixes = BUNDLER_MARKERS.flatMap((marker) => {
    const markerIndex = cleaned.lastIndexOf(marker);
    return markerIndex === NOT_FOUND ? [] : [cleaned.slice(markerIndex + marker.length)];
  });
  const [first = "", ...rest] = cleaned.replace(LEADING_SLASHES_RE, "").split("/");
  return rest.length > FIRST_PART && BUNDLER_PROJECT_SEGMENT_RE.test(first) ? [...markerSuffixes, rest.join("/")] : markerSuffixes;
}

/**
 * @param {string} source
 * @returns {string[]}
 */
function urlPathCandidates(source) {
  if (!URL_WITH_SCHEME_RE.test(source)) {
    return [];
  }
  try {
    const { pathname } = new URL(source);
    return [pathname, ...bundlerSuffixes(pathname)];
  } catch {
    return [];
  }
}

/**
 * @param {string} source
 * @returns {string[]}
 */
function sourceRootRelativeCandidates(source) {
  const candidates = [source, ...bundlerSuffixes(source), ...urlPathCandidates(source)];
  return [...new Set(candidates.map((candidate) => relativeCandidate(candidate)).filter((candidate) => candidate !== undefined))];
}

/**
 * @param {string} source
 * @param {string} sourceRoot
 * @param {string} sourceMapPath
 * @returns {string[]}
 */
function sourceContextPathCandidates(source, sourceRoot, sourceMapPath) {
  return [
    ...new Set([
      path.resolve(path.dirname(sourceMapPath), source),
      path.join(sourceRoot, source),
      ...sourceRootRelativeCandidates(source).map((relativeSource) => path.join(sourceRoot, relativeSource))
    ])
  ];
}

/**
 * @param {string} sourceRoot
 * @returns {Promise<string>}
 */
async function requireSourceRoot(sourceRoot) {
  if (sourceRoot.trim() === "") {
    throw new Error("source context root must be a non-empty directory path");
  }
  const requestedSourceRoot = path.resolve(sourceRoot);
  if (!(await pathExists(requestedSourceRoot)) || !(await isDirectory(requestedSourceRoot))) {
    throw new Error("source context root must resolve to an existing directory");
  }
  return realPath(requestedSourceRoot);
}

/**
 * @param {readonly string[]} candidates
 * @param {string} sourceRoot
 * @returns {Promise<string>}
 */
async function readableSourcePath(candidates, sourceRoot) {
  const [candidate, ...rest] = candidates;
  if (candidate === undefined) {
    throw new Error("original source file is not readable under the source context root");
  }
  const resolved = await safeResolve(candidate, sourceRoot);
  if (resolved !== undefined && (await pathExists(resolved)) && (await isFile(resolved))) {
    return resolved;
  }
  return readableSourcePath(rest, sourceRoot);
}

/**
 * @param {string} sourcePath
 * @returns {Promise<string[]>}
 */
async function readContextSourceLines(sourcePath) {
  const size = await byteSize(sourcePath);
  if (size > MAX_SOURCE_CONTEXT_FILE_BYTES) {
    throw new Error("source context file is too large for local report output");
  }
  const text = await readText(sourcePath);
  return text.split(LINE_BREAK_RE);
}

/**
 * @param {readonly string[]} sourceLines
 * @param {number} originalLine
 * @param {number} contextLines
 * @returns {{ readonly lines: readonly SourceContextLine[], readonly startLine: number }}
 */
function contextAround(sourceLines, originalLine, contextLines) {
  const startLine = Math.max(FIRST_LINE, originalLine - contextLines);
  const endLine = Math.min(sourceLines.length, originalLine + contextLines);
  /** @type {SourceContextLine[]} */
  const lines = [];
  for (let line = startLine; line <= endLine; line += FIRST_LINE) {
    lines.push({ highlighted: line === originalLine, line, text: sourceLines[line - FIRST_LINE] ?? "" });
  }
  return { lines, startLine };
}

/**
 * @param {OriginalPosition} original
 * @param {(SourceContextOptions & { readonly sourceMapPath: string }) | undefined} options
 * @returns {Promise<SourceContext | undefined>}
 */
async function sourceContextForOriginalPosition(original, options) {
  if (options === undefined || options.sourceRoot === "") {
    return undefined;
  }
  const sourceRoot = await requireSourceRoot(options.sourceRoot);
  const sourcePath = await readableSourcePath(
    sourceContextPathCandidates(original.source, sourceRoot, options.sourceMapPath),
    sourceRoot
  );
  const contextLines = requireContextLineCount(options.contextLines);
  const sourceLines = await readContextSourceLines(sourcePath);
  const { lines, startLine } = contextAround(sourceLines, original.line, contextLines);
  return { lines, source: relativeTo(sourceRoot, sourcePath), startLine };
}

export { sourceContextForOriginalPosition };
