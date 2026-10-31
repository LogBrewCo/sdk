import {
  byteSize,
  errorMessage,
  fileReference,
  isJsonObject,
  mapInOrder,
  pathExists,
  readText,
  relativeTo,
  safeResolve,
  sourceMapDebugId
} from "./release-artifacts-common.js";
import { findDebugId, findSourceMappingUrl } from "./release-artifacts-debug-id.js";
import path from "node:path";
import { readdir } from "node:fs/promises";

/**
 * @import { JsonObject } from "./release-artifacts-common.js"
 * @typedef {{ readonly entryPath: string, readonly isDirectory: boolean, readonly isFile: boolean }} WalkEntry
 * @typedef {{ readonly errors: readonly string[], readonly payload?: JsonObject }} SourceMapRead
 * @typedef {{ readonly errors: readonly string[], readonly path?: string, readonly warnings: readonly string[] }} SourceMapLocation
 * @typedef {{
 *   readonly errors: readonly string[],
 *   readonly mapDebugId?: string,
 *   readonly payload?: JsonObject,
 *   readonly relativePath?: string,
 *   readonly size?: number
 * }} SourceMapInspection
 * @typedef {{
 *   readonly errors: readonly string[],
 *   readonly jsDebugId: string | undefined,
 *   readonly jsSize: number,
 *   readonly jsSource: string,
 *   readonly mapDebugId: string | undefined,
 *   readonly relJs: string,
 *   readonly sourceMapPath: string | undefined,
 *   readonly sourceMapPayload: JsonObject | undefined,
 *   readonly sourceMapRel: string | undefined,
 *   readonly sourceMapSize: number | undefined,
 *   readonly sourceMappingUrl: string | undefined,
 *   readonly warnings: readonly string[]
 * }} ArtifactInspection
 */

const MINIFIED_SOURCE_SUFFIXES = [".js", ".mjs", ".bundle", ".jsbundle"];
const URL_WITH_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const EMPTY_FILE_SIZE = 0;
const ROOT_PREFIX_LENGTH = 1;

/**
 * @param {string} filePath
 * @returns {Promise<SourceMapRead>}
 */
async function readSourceMap(filePath) {
  try {
    /** @type {unknown} */
    const payload = JSON.parse(await readText(filePath));
    return isJsonObject(payload) ? { errors: [], payload } : { errors: ["source map must be a JSON object"] };
  } catch (error) {
    return { errors: [`source map is not valid JSON: ${errorMessage(error)}`] };
  }
}

/**
 * @param {string} jsPath
 * @param {string} buildDir
 * @param {string} reference
 * @returns {Promise<SourceMapLocation>}
 */
async function resolveReferencedSourceMap(jsPath, buildDir, reference) {
  const candidate = reference.startsWith("/")
    ? path.join(buildDir, reference.slice(ROOT_PREFIX_LENGTH))
    : path.join(path.dirname(jsPath), reference);
  const resolved = await safeResolve(candidate, buildDir);
  if (resolved === undefined) {
    return { errors: ["sourceMappingURL resolves outside the build directory"], warnings: [] };
  }
  return { errors: [], path: resolved, warnings: [] };
}

/**
 * @param {string} jsPath
 * @param {string} buildDir
 * @param {string | undefined} sourceMappingUrl
 * @returns {Promise<SourceMapLocation>}
 */
async function resolveSourceMapPath(jsPath, buildDir, sourceMappingUrl) {
  if (sourceMappingUrl === undefined) {
    const fallback = `${jsPath}.map`;
    const warnings = ["sourceMappingURL comment missing; checked sibling .map fallback"];
    return (await pathExists(fallback)) ? { errors: [], path: fallback, warnings } : { errors: [], warnings };
  }
  const reference = fileReference(sourceMappingUrl);
  if (reference.startsWith("data:")) {
    return { errors: ["inline source maps are not accepted for release artifact manifests"], warnings: [] };
  }
  if (URL_WITH_SCHEME_RE.test(reference)) {
    return { errors: ["external sourceMappingURL cannot be validated from the local build directory"], warnings: [] };
  }
  return resolveReferencedSourceMap(jsPath, buildDir, reference);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isMinifiedSource(filePath) {
  return !filePath.endsWith(".map") && MINIFIED_SOURCE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  /** @type {WalkEntry[]} */
  const descriptors = [];
  for (const entry of entries) {
    descriptors.push({ entryPath: path.join(root, entry.name), isDirectory: entry.isDirectory(), isFile: entry.isFile() });
  }
  const nested = await mapInOrder(descriptors, async ({ entryPath, isDirectory, isFile }) => {
    if (isDirectory) {
      return walkFiles(entryPath);
    }
    return isFile ? [entryPath] : [];
  });
  const results = nested.flat();
  results.sort();
  return results;
}

/**
 * @param {string} buildDir
 * @returns {Promise<string[]>}
 */
async function iterMinifiedSourceFiles(buildDir) {
  const files = await walkFiles(buildDir);
  return files.filter((filePath) => isMinifiedSource(filePath));
}

/**
 * @param {string} sourceMapPath
 * @param {string} relativePath
 * @param {number} size
 * @returns {Promise<SourceMapInspection>}
 */
async function inspectSourceMapPayload(sourceMapPath, relativePath, size) {
  const { errors, payload } = await readSourceMap(sourceMapPath);
  if (payload === undefined) {
    return { errors, relativePath, size };
  }
  const mapDebugId = sourceMapDebugId(payload);
  return mapDebugId === undefined
    ? { errors, payload, relativePath, size }
    : { errors, mapDebugId, payload, relativePath, size };
}

/**
 * @param {string | undefined} sourceMapPath
 * @param {string} buildDir
 * @returns {Promise<SourceMapInspection>}
 */
async function inspectSourceMap(sourceMapPath, buildDir) {
  if (sourceMapPath === undefined) {
    return { errors: ["source map file is missing"] };
  }
  if (!(await pathExists(sourceMapPath))) {
    return { errors: [`source map file is missing: ${relativeTo(buildDir, sourceMapPath)}`] };
  }
  const size = await byteSize(sourceMapPath);
  if (size === EMPTY_FILE_SIZE) {
    return { errors: [`source map file is empty: ${relativeTo(buildDir, sourceMapPath)}`] };
  }
  return inspectSourceMapPayload(sourceMapPath, relativeTo(buildDir, sourceMapPath), size);
}

/**
 * @param {string} jsPath
 * @param {string} buildDir
 * @returns {Promise<ArtifactInspection>}
 */
async function inspectArtifactFiles(jsPath, buildDir) {
  const jsSize = await byteSize(jsPath);
  const jsSource = await readText(jsPath);
  const jsDebugId = findDebugId(jsSource);
  const sourceMappingUrl = findSourceMappingUrl(jsSource);
  const location = await resolveSourceMapPath(jsPath, buildDir, sourceMappingUrl);
  const sourceMap = await inspectSourceMap(location.path, buildDir);
  const { mapDebugId } = sourceMap;
  const mismatch = jsDebugId !== undefined && mapDebugId !== undefined && jsDebugId !== mapDebugId;
  return {
    errors: [
      ...(jsSize === EMPTY_FILE_SIZE ? ["minified source file is empty"] : []),
      ...location.errors,
      ...sourceMap.errors,
      ...(mismatch ? ["minified source debugId does not match source map debugId"] : [])
    ],
    jsDebugId,
    jsSize,
    jsSource,
    mapDebugId,
    relJs: relativeTo(buildDir, jsPath),
    sourceMapPath: location.path,
    sourceMapPayload: sourceMap.payload,
    sourceMapRel: sourceMap.relativePath,
    sourceMapSize: sourceMap.size,
    sourceMappingUrl,
    warnings: location.warnings
  };
}

export { inspectArtifactFiles, iterMinifiedSourceFiles, readSourceMap };
