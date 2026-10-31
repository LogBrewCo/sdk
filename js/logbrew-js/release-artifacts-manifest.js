import { buildManifestArtifact } from "./release-artifacts-manifest-artifact.js";
import { iterMinifiedSourceFiles } from "./release-artifacts-inspect.js";
import { mapInOrder } from "./release-artifacts-common.js";
import { normalizeUrlOrPath } from "./release-artifacts-urls.js";

/**
 * @import { JsonObject } from "./release-artifacts-common.js"
 * @import { ManifestArtifact, Validation } from "./release-artifacts-manifest-artifact.js"
 * @typedef {{
 *   readonly allowSourcesContent: boolean,
 *   readonly buildDir: string,
 *   readonly commitSha: string | undefined,
 *   readonly environment: string,
 *   readonly minifiedPathPrefix: string,
 *   readonly projectId: string | undefined,
 *   readonly release: string,
 *   readonly repositoryUrl: string | undefined,
 *   readonly service: string
 * }} ManifestOptions
 */

const MANIFEST_VERSION = 1;
const NO_ITEMS = 0;
const SCRIPT_VERSION = "0.1.0";

/**
 * @param {readonly ManifestArtifact[]} artifacts
 * @param {(artifact: ManifestArtifact) => readonly string[]} messages
 * @returns {string[]}
 */
function prefixedMessages(artifacts, messages) {
  return artifacts.flatMap((artifact) => messages(artifact).map((message) => `${artifact.minifiedSource.path}: ${message}`));
}

/**
 * @param {string | undefined} repositoryUrl
 * @param {string | undefined} commitSha
 * @returns {JsonObject}
 */
function gitMetadata(repositoryUrl, commitSha) {
  return {
    ...(commitSha === undefined || commitSha === "" ? {} : { commitSha: commitSha.trim() }),
    ...(repositoryUrl === undefined || repositoryUrl === "" ? {} : { repositoryUrl: repositoryUrl.trim() })
  };
}

/**
 * @param {ManifestOptions} options
 * @returns {Promise<JsonObject & { readonly validation: Validation }>}
 */
async function createManifest(options) {
  const { allowSourcesContent, buildDir, environment, projectId, release, service } = options;
  const minifiedPathPrefix = normalizeUrlOrPath(options.minifiedPathPrefix.trim());
  const artifacts = await mapInOrder(await iterMinifiedSourceFiles(buildDir), async (filePath) =>
    buildManifestArtifact(filePath, { allowSourcesContent, buildDir, minifiedPathPrefix }));
  const errors = [
    ...(artifacts.length === NO_ITEMS ? ["no JavaScript release artifact files found in build directory"] : []),
    ...prefixedMessages(artifacts, (artifact) => artifact.validation.errors)
  ];
  const warnings = prefixedMessages(artifacts, (artifact) => artifact.validation.warnings);
  const git = gitMetadata(options.repositoryUrl, options.commitSha);
  return {
    artifactType: "javascript_source_map_manifest",
    artifacts,
    environment,
    ...(Object.keys(git).length > NO_ITEMS ? { git } : {}),
    manifestVersion: MANIFEST_VERSION,
    minifiedPathPrefix,
    ...(projectId === undefined ? {} : { projectId }),
    release,
    service,
    uploader: { name: "logbrew-js-release-artifact-manifest", version: SCRIPT_VERSION },
    validation: { errors, status: errors.length > NO_ITEMS ? "blocked" : "ready", warnings }
  };
}

export { createManifest };
