import { inspectArtifactFiles } from "./release-artifacts-inspect.js";
import { joinUrlOrPath } from "./release-artifacts-urls.js";
import { sha256File } from "./release-artifacts-common.js";

/**
 * @import { JsonObject } from "./release-artifacts-common.js"
 * @import { ArtifactInspection } from "./release-artifacts-inspect.js"
 * @typedef {{ readonly errors: readonly string[], readonly status: "blocked" | "ready", readonly warnings: readonly string[] }} Validation
 * @typedef {{
 *   readonly allowSourcesContent: boolean,
 *   readonly buildDir: string,
 *   readonly minifiedPathPrefix: string
 * }} ManifestArtifactOptions
 * @typedef {{
 *   readonly minifiedSource: JsonObject & { readonly path: string },
 *   readonly validation: Validation
 * }} ManifestArtifact
 */

const NO_ITEMS = 0;

/**
 * @param {JsonObject} payload
 * @param {boolean} allowSourcesContent
 * @returns {{ readonly errors: readonly string[], readonly warnings: readonly string[] }}
 */
function validateSourceMapPayload(payload, allowSourcesContent) {
  const { mappings, sources, version } = payload;
  const hasSourcesContent = "sourcesContent" in payload;
  return {
    errors: [
      ...(version === undefined ? ["source map version is required"] : []),
      ...(!Array.isArray(sources) || sources.length === NO_ITEMS ? ["source map sources must be a non-empty array"] : []),
      ...(typeof mappings !== "string" || mappings === "" ? ["source map mappings must be a non-empty string"] : []),
      ...(hasSourcesContent && !allowSourcesContent
        ? ["source map contains sourcesContent; rerun with --allow-sources-content only if policy permits it"]
        : [])
    ],
    warnings:
      hasSourcesContent && allowSourcesContent
        ? ["source map contains sourcesContent; ensure app policy permits source upload"]
        : []
  };
}

/**
 * @param {ArtifactInspection} inspection
 * @param {boolean} allowSourcesContent
 * @returns {Promise<{ readonly entry: JsonObject | undefined, readonly errors: readonly string[], readonly warnings: readonly string[] }>}
 */
async function sourceMapEntry(inspection, allowSourcesContent) {
  const { mapDebugId, sourceMapPath, sourceMapPayload, sourceMapRel, sourceMapSize } = inspection;
  if (sourceMapPayload === undefined || sourceMapPath === undefined || sourceMapRel === undefined) {
    return { entry: undefined, errors: [], warnings: [] };
  }
  const { errors, warnings } = validateSourceMapPayload(sourceMapPayload, allowSourcesContent);
  const { sources } = sourceMapPayload;
  return {
    entry: {
      artifactSha256: await sha256File(sourceMapPath),
      byteSize: sourceMapSize,
      ...(mapDebugId === undefined ? {} : { debugId: mapDebugId }),
      hasSourcesContent: "sourcesContent" in sourceMapPayload,
      path: sourceMapRel,
      sourceCount: Array.isArray(sources) ? sources.length : NO_ITEMS
    },
    errors,
    warnings
  };
}

/**
 * @param {string} jsPath
 * @param {ManifestArtifactOptions} options
 * @returns {Promise<ManifestArtifact & JsonObject>}
 */
async function buildManifestArtifact(jsPath, { allowSourcesContent, buildDir, minifiedPathPrefix }) {
  const inspection = await inspectArtifactFiles(jsPath, buildDir);
  const { jsDebugId, jsSize, mapDebugId, relJs, sourceMappingUrl } = inspection;
  const sourceMap = await sourceMapEntry(inspection, allowSourcesContent);
  const errors = [...inspection.errors, ...sourceMap.errors];
  const missingDebugId = jsDebugId === undefined && mapDebugId === undefined;
  const warnings = [
    ...inspection.warnings,
    ...sourceMap.warnings,
    ...(missingDebugId ? ["no debugId found; backend matching must rely on release/environment/service and minified path"] : [])
  ];
  const debugId = jsDebugId ?? mapDebugId;
  const minifiedUrl = joinUrlOrPath(minifiedPathPrefix, relJs);
  const artifactSha256 = await sha256File(jsPath);
  return {
    artifactType: "javascript_source_map",
    ...(debugId === undefined ? {} : { debugId }),
    minifiedSource: {
      artifactSha256,
      byteSize: jsSize,
      ...(jsDebugId === undefined ? {} : { debugId: jsDebugId }),
      minifiedUrl,
      path: relJs,
      ...(sourceMappingUrl === undefined ? {} : { sourceMappingUrl })
    },
    sourceMap: sourceMap.entry ?? null,
    validation: { errors, status: errors.length > NO_ITEMS ? "blocked" : "ready", warnings }
  };
}

export { buildManifestArtifact };
