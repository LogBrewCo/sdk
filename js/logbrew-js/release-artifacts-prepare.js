import { RUNTIME_DEBUG_ID_MARKER, generateDebugId, sourceStartsWithDirective, sourceWithDebugId } from "./release-artifacts-debug-id.js";
import { inspectArtifactFiles, iterMinifiedSourceFiles, readSourceMap } from "./release-artifacts-inspect.js";
import { mapInOrder, pathExists, readText, realPath, sortJson, sourceMapDebugId, stableJson } from "./release-artifacts-common.js";
import path from "node:path";
import { writeFile } from "node:fs/promises";

/**
 * @import { JsonObject } from "./release-artifacts-common.js"
 * @import { ArtifactInspection } from "./release-artifacts-inspect.js"
 * @typedef {{ readonly sourcePrefixes: readonly string[], readonly stripSourcesContent: boolean }} PrivacyOptions
 * @typedef {{ readonly errors: readonly string[], readonly status: "blocked" | "ready", readonly warnings: readonly string[] }} Validation
 * @typedef {{
 *   readonly changes: readonly string[],
 *   readonly debugId?: string,
 *   readonly path: string,
 *   readonly sourceMapPath?: string,
 *   readonly validation: Validation
 * }} ArtifactPlan
 * @typedef {{
 *   readonly buildDir: string,
 *   readonly stripSourcePrefixes: readonly string[],
 *   readonly stripSourcesContent: boolean,
 *   readonly write: boolean
 * }} DebugIdPlanOptions
 */

const JSON_INDENT = 2;
const SCRIPT_VERSION = "0.1.0";
const NO_ITEMS = 0;
const TRAILING_SLASHES_RE = /\/+$/u;

/**
 * @param {readonly string[]} values
 * @returns {Promise<string[]>}
 */
async function normalizeSourcePrefixes(values) {
  const candidates = await mapInOrder(values, async (value) => [
    path.resolve(value),
    (await pathExists(value)) ? await realPath(value) : path.resolve(value)
  ]);
  /** @type {string[]} */
  const prefixes = [];
  for (const candidate of candidates.flat()) {
    const normalized = candidate.split(path.sep).join("/").replace(TRAILING_SLASHES_RE, "");
    if (normalized !== "" && !prefixes.includes(normalized)) {
      prefixes.push(normalized);
    }
  }
  return prefixes;
}

/**
 * @param {string} source
 * @param {readonly string[]} prefixes
 * @returns {string}
 */
function sourceWithoutPrefix(source, prefixes) {
  const normalized = source.replaceAll("\\", "/");
  for (const prefix of prefixes) {
    const marker = `${prefix}/`;
    if (normalized === prefix) {
      return path.posix.basename(prefix);
    }
    if (normalized.startsWith(marker)) {
      return normalized.slice(marker.length);
    }
  }
  return source;
}

/**
 * @param {JsonObject} payload
 * @param {readonly string[]} prefixes
 * @returns {unknown[] | undefined}
 */
function sourceMapSourcesWithoutPrefixes(payload, prefixes) {
  const { sources } = payload;
  if (prefixes.length === NO_ITEMS || !Array.isArray(sources)) {
    return undefined;
  }
  /** @type {readonly unknown[]} */
  const original = sources;
  const updated = original.map((source) => (typeof source === "string" ? sourceWithoutPrefix(source, prefixes) : source));
  return JSON.stringify(updated) === JSON.stringify(original) ? undefined : updated;
}

/**
 * @param {JsonObject} payload
 * @param {PrivacyOptions} options
 * @returns {JsonObject}
 */
function sourceMapPayloadForDebugId(payload, { sourcePrefixes, stripSourcesContent }) {
  const updatedSources = sourceMapSourcesWithoutPrefixes(payload, sourcePrefixes);
  if (!stripSourcesContent && updatedSources === undefined) {
    return payload;
  }
  const updated = updatedSources === undefined ? payload : { ...payload, sources: updatedSources };
  if (!stripSourcesContent) {
    return { ...updated };
  }
  const keys = Object.keys(updated).filter((key) => key !== "sourcesContent");
  return Object.fromEntries(keys.map((key) => [key, updated[key]]));
}

/**
 * @param {JsonObject} payload
 * @param {string} debugId
 * @param {PrivacyOptions & { readonly shiftGeneratedLines: boolean }} options
 * @returns {JsonObject}
 */
function sourceMapWithPrivacyUpdates(payload, debugId, options) {
  const privacyUpdated = sourceMapPayloadForDebugId(payload, options);
  const { shiftGeneratedLines } = options;
  if (sourceMapDebugId(payload) !== undefined && privacyUpdated === payload && !shiftGeneratedLines) {
    return payload;
  }
  const { mappings } = privacyUpdated;
  return {
    ...privacyUpdated,
    ...(sourceMapDebugId(privacyUpdated) === undefined ? { debug_id: debugId } : {}),
    ...(shiftGeneratedLines && typeof mappings === "string" ? { mappings: `;${mappings}` } : {})
  };
}

/**
 * @param {ArtifactInspection} inspection
 * @param {boolean} needsRuntimeDebugId
 * @returns {string[]}
 */
function runtimeInjectionErrors({ jsSource, sourceMapPayload }, needsRuntimeDebugId) {
  /** @type {string[]} */
  const errors = [];
  if (needsRuntimeDebugId && sourceStartsWithDirective(jsSource)) {
    errors.push("runtime Debug ID injection cannot precede a script directive");
  }
  const mappings = sourceMapPayload?.["mappings"];
  if (needsRuntimeDebugId && sourceMapPayload !== undefined && (typeof mappings !== "string" || mappings === "")) {
    errors.push("source map mappings must be a non-empty string before runtime Debug ID injection");
  }
  return errors;
}

/**
 * @param {ArtifactInspection} inspection
 * @param {JsonObject} payload
 * @param {PrivacyOptions} options
 * @returns {{ readonly changes: readonly string[], readonly debugId: string }}
 */
function debugIdChanges({ jsDebugId, jsSource, mapDebugId, relJs }, payload, options) {
  const existing = jsDebugId ?? mapDebugId;
  if (existing === undefined) {
    return {
      changes: ["minifiedSource.debugId", "sourceMap.debug_id"],
      debugId: generateDebugId(relJs, jsSource, sourceMapPayloadForDebugId(payload, options))
    };
  }
  return {
    changes: [
      ...(jsDebugId === undefined ? ["minifiedSource.debugId"] : []),
      ...(mapDebugId === undefined ? ["sourceMap.debug_id"] : [])
    ],
    debugId: existing
  };
}

/**
 * @param {ArtifactInspection} inspection
 * @param {JsonObject} payload
 * @param {PrivacyOptions & { readonly needsRuntimeDebugId: boolean }} options
 * @returns {{ readonly changes: readonly string[], readonly debugId: string }}
 */
function plannedChanges(inspection, payload, options) {
  const { changes, debugId } = debugIdChanges(inspection, payload, options);
  return {
    changes: [
      ...(options.needsRuntimeDebugId ? ["minifiedSource.runtimeDebugId"] : []),
      ...changes,
      ...(options.stripSourcesContent && "sourcesContent" in payload ? ["sourceMap.sourcesContent"] : []),
      ...(sourceMapSourcesWithoutPrefixes(payload, options.sourcePrefixes) === undefined ? [] : ["sourceMap.sources"])
    ],
    debugId
  };
}

/**
 * @param {string} jsPath
 * @param {string} buildDir
 * @param {PrivacyOptions} options
 * @returns {Promise<ArtifactPlan>}
 */
async function buildArtifactPlan(jsPath, buildDir, options) {
  const inspection = await inspectArtifactFiles(jsPath, buildDir);
  const { relJs, sourceMapPayload, sourceMapRel } = inspection;
  const needsRuntimeDebugId = !inspection.jsSource.includes(RUNTIME_DEBUG_ID_MARKER);
  const errors = [...inspection.errors, ...runtimeInjectionErrors(inspection, needsRuntimeDebugId)];
  const { changes, debugId } =
    errors.length === NO_ITEMS && sourceMapPayload !== undefined
      ? plannedChanges(inspection, sourceMapPayload, { ...options, needsRuntimeDebugId })
      : { changes: [], debugId: inspection.jsDebugId ?? inspection.mapDebugId };
  return {
    changes,
    ...(debugId === undefined ? {} : { debugId }),
    path: relJs,
    ...(sourceMapRel === undefined ? {} : { sourceMapPath: sourceMapRel }),
    validation: { errors, status: errors.length > NO_ITEMS ? "blocked" : "ready", warnings: inspection.warnings }
  };
}

/**
 * @param {string} jsPath
 * @param {string} debugId
 * @param {string} relativePath
 * @returns {Promise<string>}
 */
async function writeSourceDebugId(jsPath, debugId, relativePath) {
  const jsSource = await readText(jsPath);
  const updatedSource = sourceWithDebugId(jsSource, debugId, relativePath);
  if (updatedSource !== jsSource) {
    await writeFile(jsPath, updatedSource, "utf8");
  }
  return jsSource;
}

/**
 * @param {string} mapPath
 * @param {string} relativePath
 * @returns {Promise<JsonObject>}
 */
async function readSourceMapForWrite(mapPath, relativePath) {
  const { errors, payload } = await readSourceMap(mapPath);
  if (payload === undefined || errors.length > NO_ITEMS) {
    throw new Error(`${relativePath}: source map became unreadable before write`);
  }
  return payload;
}

/**
 * @param {ArtifactPlan} artifact
 * @param {string} buildDir
 * @param {PrivacyOptions} options
 * @returns {Promise<void>}
 */
async function applyArtifactPlan(artifact, buildDir, options) {
  const { debugId, sourceMapPath } = artifact;
  if (debugId === undefined || sourceMapPath === undefined) {
    return;
  }
  const mapPath = path.join(buildDir, sourceMapPath);
  const jsSource = await writeSourceDebugId(path.join(buildDir, artifact.path), debugId, artifact.path);
  const payload = await readSourceMapForWrite(mapPath, artifact.path);
  const shiftGeneratedLines = !jsSource.includes(RUNTIME_DEBUG_ID_MARKER);
  const updatedPayload = sourceMapWithPrivacyUpdates(payload, debugId, { ...options, shiftGeneratedLines });
  if (stableJson(updatedPayload) !== stableJson(payload)) {
    await writeFile(mapPath, `${JSON.stringify(sortJson(updatedPayload), undefined, JSON_INDENT)}\n`, "utf8");
  }
}

/**
 * @param {readonly ArtifactPlan[]} artifacts
 * @param {(artifact: ArtifactPlan) => readonly string[]} messages
 * @returns {string[]}
 */
function prefixedMessages(artifacts, messages) {
  return artifacts.flatMap((artifact) => messages(artifact).map((message) => `${artifact.path}: ${message}`));
}

/**
 * @param {DebugIdPlanOptions} options
 * @returns {Promise<Readonly<Record<string, unknown>> & { readonly validation: Validation }>}
 */
async function createDebugIdPlan({ buildDir, stripSourcePrefixes, stripSourcesContent, write }) {
  const sourcePrefixes = await normalizeSourcePrefixes(stripSourcePrefixes);
  const artifactOptions = { sourcePrefixes, stripSourcesContent };
  const artifacts = await mapInOrder(await iterMinifiedSourceFiles(buildDir), async (filePath) =>
    buildArtifactPlan(filePath, buildDir, artifactOptions));
  const errors = [
    ...(artifacts.length === NO_ITEMS ? ["no JavaScript release artifact files found in build directory"] : []),
    ...prefixedMessages(artifacts, (artifact) => artifact.validation.errors)
  ];
  const warnings = prefixedMessages(artifacts, (artifact) => artifact.validation.warnings);
  const status = errors.length > NO_ITEMS ? "blocked" : "ready";
  const writeApplied = write && status === "ready";
  if (writeApplied) {
    await mapInOrder(artifacts, async (artifact) => applyArtifactPlan(artifact, buildDir, artifactOptions));
  }
  return {
    artifacts,
    manifestVersion: 1,
    stripSourcePrefixCount: stripSourcePrefixes.length,
    stripSourcesContent,
    tool: { name: "logbrew-js-release-artifact-debug-id-prep", version: SCRIPT_VERSION },
    validation: { errors, status, warnings },
    writeApplied
  };
}

export { createDebugIdPlan };
