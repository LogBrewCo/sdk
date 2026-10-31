import {
  fileReference,
  findInOrder,
  isJsonList,
  isJsonObject,
  readJsonObject,
  relativeTo,
  safeResolve,
  sourceMapDebugId
} from "./release-artifacts-common.js";
import {
  metadataFromIssueEvent,
  requireMetadataMatchesManifest,
  requireMetadataString,
  stackFrameFromIssueMetadata
} from "./release-artifacts-issue-event.js";
import { originalPositionFor } from "./release-artifacts-mappings.js";
import path from "node:path";
import { sourceContextForOriginalPosition } from "./release-artifacts-source-context.js";

/**
 * @import { JsonObject } from "./release-artifacts-common.js"
 * @import { ValidSourceMap } from "./release-artifacts-mappings.js"
 * @import { SourceContextOptions } from "./release-artifacts-source-context.js"
 * @typedef {{ readonly column: number, readonly filename: string, readonly function?: string, readonly line: number }} StackFrame
 * @typedef {{ readonly buildDir: string, readonly manifest: JsonObject, readonly sourceContext: SourceContextOptions | undefined }} SymbolicationInput
 * @typedef {{
 *   readonly artifact: JsonObject,
 *   readonly buildDir: string,
 *   readonly frame: StackFrame,
 *   readonly manifest: JsonObject,
 *   readonly sourceContext: SourceContextOptions | undefined
 * }} ArtifactSymbolicationInput
 */

const SCRIPT_VERSION = "0.1.0";
const FRAME_PREFIX = "at ";
const FUNCTION_LOCATION_OPENER = " (";
const LOCATION_PARTS = 3;
const LINE_AND_COLUMN_PARTS = -2;
const FIRST_LINE = 1;
const START_INDEX = 0;
const NO_MATCHES = 0;
const ONE_MATCH = 1;
const DECIMAL = 10;
const CLOSING_PARENTHESIS_WIDTH = -1;
const EDGE_SLASHES_RE = /^\/+|\/+$/gu;

/**
 * @param {string} stackFrame
 * @returns {{ readonly functionName: string | undefined, readonly location: string }}
 */
function splitStackFrame(stackFrame) {
  const trimmed = stackFrame.trim();
  const line = trimmed.startsWith(FRAME_PREFIX) ? trimmed.slice(FRAME_PREFIX.length).trim() : trimmed;
  if (!line.endsWith(")") || !line.includes(FUNCTION_LOCATION_OPENER)) {
    return { functionName: undefined, location: line };
  }
  const marker = line.lastIndexOf(FUNCTION_LOCATION_OPENER);
  return {
    functionName: line.slice(START_INDEX, marker),
    location: line.slice(marker + FUNCTION_LOCATION_OPENER.length, CLOSING_PARENTHESIS_WIDTH)
  };
}

/**
 * @param {readonly string[]} parts
 * @returns {{ readonly column: number, readonly line: number }}
 */
function framePosition(parts) {
  const [lineText = "", columnText = ""] = parts.slice(LINE_AND_COLUMN_PARTS);
  const line = Number.parseInt(lineText, DECIMAL);
  const column = Number.parseInt(columnText, DECIMAL);
  const integers = Number.isInteger(line) && Number.isInteger(column);
  if (!integers) {
    throw new Error("stack frame line and column must be integers");
  }
  if (line < FIRST_LINE || column < FIRST_LINE) {
    throw new Error("stack frame line and column must be one-based positive integers");
  }
  return { column, line };
}

/**
 * @param {string} stackFrame
 * @returns {StackFrame}
 */
function parseStackFrame(stackFrame) {
  const { functionName, location } = splitStackFrame(stackFrame);
  const parts = location.split(":");
  if (parts.length < LOCATION_PARTS) {
    throw new Error("stack frame must end with :line:column");
  }
  const { column, line } = framePosition(parts);
  return {
    column,
    filename: parts.slice(START_INDEX, LINE_AND_COLUMN_PARTS).join(":"),
    ...(functionName === undefined || functionName === "" ? {} : { function: functionName }),
    line
  };
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeReference(value) {
  const normalized = fileReference(value.trim());
  return normalized.startsWith("file://") ? normalized.slice("file://".length) : normalized;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function objectField(value, key) {
  return isJsonObject(value) ? value[key] : undefined;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function jsonText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return isJsonList(value) ? value.map((item) => jsonText(item)).join(",") : "[object Object]";
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {string}
 */
function fieldText(value, key) {
  return jsonText(objectField(value, key));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {string} normalizedFrame
 * @param {string} artifactPath
 * @param {string} buildDir
 * @returns {Promise<boolean>}
 */
async function pathMatchesArtifact(normalizedFrame, artifactPath, buildDir) {
  const resolved = path.isAbsolute(normalizedFrame) ? await safeResolve(normalizedFrame, buildDir) : undefined;
  return resolved !== undefined && relativeTo(buildDir, resolved) === artifactPath;
}

/**
 * @param {JsonObject} artifact
 * @param {StackFrame} frame
 * @param {string} buildDir
 * @returns {Promise<boolean>}
 */
async function artifactMatchesFrame(artifact, frame, buildDir) {
  const { minifiedSource } = artifact;
  if (!isObjectLike(minifiedSource)) {
    return false;
  }
  const artifactPath = fieldText(minifiedSource, "path");
  const normalizedFrame = normalizeReference(frame.filename);
  if (normalizedFrame === normalizeReference(fieldText(minifiedSource, "minifiedUrl"))) {
    return true;
  }
  if (normalizedFrame.replaceAll(EDGE_SLASHES_RE, "") === artifactPath.replaceAll(EDGE_SLASHES_RE, "")) {
    return true;
  }
  return pathMatchesArtifact(normalizedFrame, artifactPath, buildDir);
}

/**
 * @param {JsonObject} manifest
 * @returns {readonly JsonObject[]}
 */
function requireReadyArtifacts(manifest) {
  const { artifacts } = manifest;
  if (manifest["artifactType"] !== "javascript_source_map_manifest") {
    throw new Error("only javascript_source_map_manifest symbolication proof is supported");
  }
  if (objectField(manifest["validation"], "status") !== "ready") {
    throw new Error("manifest validation status must be ready");
  }
  if (!Array.isArray(artifacts) || artifacts.length === NO_MATCHES) {
    throw new Error("manifest must contain at least one JavaScript source-map artifact");
  }
  /** @type {readonly unknown[]} */
  const entries = artifacts;
  return entries.map((artifact) => {
    if (!isJsonObject(artifact)) {
      throw new Error("artifact entries must be JSON objects");
    }
    if (objectField(artifact["validation"], "status") !== "ready") {
      throw new Error("all artifact validation statuses must be ready");
    }
    return artifact;
  });
}

/**
 * @param {JsonObject} manifest
 * @param {string} debugId
 * @returns {JsonObject}
 */
function findArtifactByDebugId(manifest, debugId) {
  const matches = requireReadyArtifacts(manifest).filter((candidate) => {
    const candidateDebugId = candidate["debugId"];
    return typeof candidateDebugId === "string" && candidateDebugId.toLowerCase() === debugId;
  });
  const [match] = matches;
  if (match === undefined) {
    throw new Error("no manifest artifact matches the issue event debug ID");
  }
  if (matches.length > ONE_MATCH) {
    throw new Error("multiple manifest artifacts match the issue event debug ID");
  }
  return match;
}

/**
 * @param {JsonObject} artifact
 * @param {string} buildDir
 * @returns {Promise<string>}
 */
async function resolveManifestSourceMapPath(artifact, buildDir) {
  const { sourceMap } = artifact;
  const hasPath = Boolean(objectField(sourceMap, "path"));
  if (!isObjectLike(sourceMap) || !hasPath) {
    throw new Error("matched artifact is missing source map metadata");
  }
  const joined = path.join(buildDir, fieldText(sourceMap, "path"));
  const sourceMapPath = await safeResolve(joined, buildDir);
  if (sourceMapPath === undefined) {
    throw new Error("source map path resolves outside the build directory");
  }
  return sourceMapPath;
}

/**
 * @param {JsonObject} artifact
 * @param {JsonObject} payload
 * @returns {void}
 */
function requireMatchingSourceMap(artifact, payload) {
  if ("sourcesContent" in payload) {
    throw new Error("source map still contains sourcesContent; strip it before symbolication proof");
  }
  const artifactDebugId = artifact["debugId"];
  const mapDebugId = sourceMapDebugId(payload);
  if (Boolean(artifactDebugId) && mapDebugId !== undefined && artifactDebugId !== mapDebugId) {
    throw new Error("matched artifact debug ID does not match source map debug ID");
  }
}

/**
 * @param {JsonObject} artifact
 * @param {string} buildDir
 * @returns {Promise<{ readonly path: string, readonly payload: ValidSourceMap }>}
 */
async function loadManifestSourceMap(artifact, buildDir) {
  const sourceMapPath = await resolveManifestSourceMapPath(artifact, buildDir);
  const payload = await readJsonObject(sourceMapPath, "source map");
  requireMatchingSourceMap(artifact, payload);
  const { mappings, names, sources } = payload;
  if (!Array.isArray(sources) || sources.length === NO_MATCHES) {
    throw new Error("source map sources must be a non-empty array");
  }
  if (typeof mappings !== "string" || mappings === "") {
    throw new Error("source map mappings must be a non-empty string");
  }
  return { path: sourceMapPath, payload: { mappings, names, sources } };
}

/**
 * @param {ArtifactSymbolicationInput} input
 * @returns {Promise<JsonObject>}
 */
async function symbolicationReportForArtifact({ artifact, buildDir, frame, manifest, sourceContext }) {
  const sourceMap = await loadManifestSourceMap(artifact, buildDir);
  const original = originalPositionFor(sourceMap.payload, frame.line, frame.column);
  const resolvedSourceContext = await sourceContextForOriginalPosition(
    original,
    sourceContext === undefined ? undefined : { ...sourceContext, sourceMapPath: sourceMap.path }
  );
  const { minifiedSource } = artifact;
  if (minifiedSource === undefined || minifiedSource === null) {
    throw new Error("matched artifact is missing minified source metadata");
  }
  return {
    debugId: artifact["debugId"],
    environment: manifest["environment"],
    generated: {
      column: frame.column,
      ...(frame.function === undefined ? {} : { function: frame.function }),
      line: frame.line,
      minifiedUrl: objectField(minifiedSource, "minifiedUrl"),
      path: objectField(minifiedSource, "path")
    },
    original,
    release: manifest["release"],
    service: manifest["service"],
    ...(resolvedSourceContext === undefined ? {} : { sourceContext: resolvedSourceContext }),
    sourceMap: { hasSourcesContent: false, path: objectField(artifact["sourceMap"], "path") },
    status: "resolved",
    verifier: { name: "logbrew-js-release-artifact-symbolication-verifier", version: SCRIPT_VERSION }
  };
}

/**
 * @param {SymbolicationInput & { readonly stackFrame: string }} input
 * @returns {Promise<JsonObject>}
 */
async function verifyJavaScriptSymbolication({ buildDir, manifest, sourceContext, stackFrame }) {
  const frame = parseStackFrame(stackFrame);
  const artifact = await findInOrder(requireReadyArtifacts(manifest), async (candidate) =>
    artifactMatchesFrame(candidate, frame, buildDir));
  if (artifact === undefined) {
    throw new Error("no manifest artifact matches the minified stack frame filename");
  }
  return symbolicationReportForArtifact({ artifact, buildDir, frame, manifest, sourceContext });
}

/**
 * @param {SymbolicationInput & { readonly issueEvent: JsonObject }} input
 * @returns {Promise<JsonObject>}
 */
async function verifyJavaScriptIssueSymbolication({ buildDir, issueEvent, manifest, sourceContext }) {
  const { input, metadata } = metadataFromIssueEvent(issueEvent);
  requireMetadataMatchesManifest(metadata, manifest);
  const expectedDebugId = requireMetadataString(metadata, "releaseArtifactDebugId").toLowerCase();
  const artifact = findArtifactByDebugId(manifest, expectedDebugId);
  const report = await symbolicationReportForArtifact({
    artifact,
    buildDir,
    frame: parseStackFrame(stackFrameFromIssueMetadata(metadata)),
    manifest,
    sourceContext
  });
  const { debugId } = report;
  if (typeof debugId !== "string" || debugId.toLowerCase() !== expectedDebugId) {
    throw new Error("issue event releaseArtifactDebugId does not match the resolved artifact");
  }
  return { ...report, input };
}

export { verifyJavaScriptIssueSymbolication, verifyJavaScriptSymbolication };
