import {
  byteSize,
  isFile,
  isJsonObject,
  mapInOrder,
  normalizeProjectId,
  pathExists,
  safeResolve,
  sha256File
} from "./release-artifacts-common.js";
import path from "node:path";

/**
 * @import { JsonObject } from "./release-artifacts-common.js"
 * @import { UploadFile } from "./release-artifacts-upload-request.js"
 * @typedef {{ readonly artifacts: readonly unknown[], readonly manifest: JsonObject }} ReadyManifest
 */

const REQUIRED_FILE_FIELDS = ["path", "artifactSha256", "byteSize"];
const NO_ARTIFACTS = 0;

/**
 * @param {JsonObject} manifest
 * @param {boolean} requireProjectId
 * @returns {ReadyManifest}
 */
function requireReadyJavaScriptManifest(manifest, requireProjectId) {
  const { artifacts, validation } = manifest;
  if (manifest["artifactType"] !== "javascript_source_map_manifest") {
    throw new Error("only javascript_source_map_manifest uploads are supported by this verifier");
  }
  if ((isJsonObject(validation) ? validation["status"] : undefined) !== "ready") {
    throw new Error("manifest validation status must be ready before upload");
  }
  if (!Array.isArray(artifacts) || artifacts.length === NO_ARTIFACTS) {
    throw new Error("manifest must contain at least one JavaScript release artifact");
  }
  normalizeProjectId(
    manifest["projectId"],
    requireProjectId
      ? "hosted release artifact uploads require manifest projectId as a UUID"
      : "manifest projectId must be a UUID when provided",
    requireProjectId
  );
  return { artifacts, manifest };
}

/**
 * @param {JsonObject} artifact
 * @param {string} section
 * @returns {JsonObject}
 */
function requireFileMetadata(artifact, section) {
  const payload = artifact[section];
  if (!isJsonObject(payload)) {
    throw new Error(`artifact is missing ${section}`);
  }
  const missingField = REQUIRED_FILE_FIELDS.find((field) => payload[field] === undefined || payload[field] === "");
  if (missingField !== undefined) {
    throw new Error(`${section} is missing ${missingField}`);
  }
  return payload;
}

/**
 * @param {string | undefined} filePath
 * @param {JsonObject} payload
 * @param {string} section
 * @returns {Promise<string>}
 */
async function requireUnchangedFile(filePath, payload, section) {
  const recordedPath = String(payload["path"]);
  if (filePath === undefined || !(await pathExists(filePath)) || !(await isFile(filePath))) {
    throw new Error(`${section} file is missing: ${recordedPath}`);
  }
  const size = await byteSize(filePath);
  if (size !== Number(payload["byteSize"])) {
    throw new Error(`${section} byte size changed after manifest creation: ${recordedPath}`);
  }
  const digest = await sha256File(filePath);
  if (digest !== String(payload["artifactSha256"])) {
    throw new Error(`${section} sha256 changed after manifest creation: ${recordedPath}`);
  }
  return filePath;
}

/**
 * @param {JsonObject} artifact
 * @param {string} buildDir
 * @param {string} section
 * @returns {Promise<string>}
 */
async function requireArtifactFile(artifact, buildDir, section) {
  const payload = requireFileMetadata(artifact, section);
  const filePath = await safeResolve(path.join(buildDir, String(payload["path"])), buildDir);
  return requireUnchangedFile(filePath, payload, section);
}

/**
 * @param {JsonObject} manifest
 * @param {string} buildDir
 * @param {boolean} requireProjectId
 * @returns {Promise<{ readonly artifactCount: number, readonly files: readonly UploadFile[] }>}
 */
async function collectUploadFiles(manifest, buildDir, requireProjectId) {
  const { artifacts } = requireReadyJavaScriptManifest(manifest, requireProjectId);
  const files = await mapInOrder([...artifacts.keys()], async (index) => {
    const artifact = artifacts[index];
    if (!isJsonObject(artifact)) {
      throw new Error("artifact entries must be JSON objects");
    }
    /** @type {UploadFile[]} */
    const pair = [
      [`minified_source_${String(index)}`, await requireArtifactFile(artifact, buildDir, "minifiedSource")],
      [`source_map_${String(index)}`, await requireArtifactFile(artifact, buildDir, "sourceMap")]
    ];
    return pair;
  });
  return { artifactCount: artifacts.length, files: files.flat() };
}

export { collectUploadFiles };
