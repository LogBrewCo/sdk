import { isJsonObject } from "./release-artifacts-common.js";

/**
 * @import { JsonObject } from "./release-artifacts-common.js"
 * @typedef {{ readonly issueId?: string, readonly metadataSource: string, readonly type: string }} IssueEventInput
 */

const FIRST_LINE = 1;

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function trimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * @param {JsonObject} issueEvent
 * @returns {{ readonly input: IssueEventInput, readonly metadata: JsonObject }}
 */
function metadataFromIssueEvent(issueEvent) {
  const { attributes, metadata } = issueEvent;
  const attributesMetadata = isJsonObject(attributes) ? attributes["metadata"] : undefined;
  if (isJsonObject(attributesMetadata)) {
    const issueId = trimmedString(issueEvent["id"]);
    return {
      input: {
        ...(issueId === undefined ? {} : { issueId }),
        metadataSource: "attributes.metadata",
        type: "sdk_issue_event"
      },
      metadata: attributesMetadata
    };
  }
  if (isJsonObject(metadata)) {
    return { input: { metadataSource: "metadata", type: "issue_attributes" }, metadata };
  }
  throw new Error("issue event must contain attributes.metadata or metadata");
}

/**
 * @param {JsonObject} metadata
 * @param {string} name
 * @returns {string}
 */
function requireMetadataString(metadata, name) {
  const value = trimmedString(metadata[name]);
  if (value === undefined) {
    throw new Error(`issue event metadata is missing ${name}`);
  }
  return value;
}

/**
 * @param {JsonObject} metadata
 * @param {string} name
 * @returns {number}
 */
function requireMetadataPositiveInteger(metadata, name) {
  const value = metadata[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < FIRST_LINE) {
    throw new Error(`issue event metadata ${name} must be a one-based positive integer`);
  }
  return value;
}

/**
 * @param {JsonObject} metadata
 * @param {JsonObject} manifest
 * @returns {void}
 */
function requireMetadataMatchesManifest(metadata, manifest) {
  for (const name of ["release", "environment", "service"]) {
    if (manifest[name] !== requireMetadataString(metadata, name)) {
      throw new Error(`issue event metadata ${name} does not match the manifest`);
    }
  }
}

/**
 * @param {JsonObject} metadata
 * @returns {string}
 */
function stackFrameFromIssueMetadata(metadata) {
  const releaseArtifactType = requireMetadataString(metadata, "releaseArtifactType");
  if (releaseArtifactType !== "sourcemap") {
    throw new Error("issue event releaseArtifactType must be sourcemap");
  }
  const codeFile = trimmedString(metadata["releaseArtifactCodeFile"]) ?? trimmedString(metadata["errorFrameFile"]);
  if (codeFile === undefined) {
    throw new Error("issue event metadata is missing releaseArtifactCodeFile");
  }
  const line = requireMetadataPositiveInteger(metadata, "errorFrameLine");
  const column = requireMetadataPositiveInteger(metadata, "errorFrameColumn");
  return `${codeFile}:${String(line)}:${String(column)}`;
}

export { metadataFromIssueEvent, requireMetadataMatchesManifest, requireMetadataString, stackFrameFromIssueMetadata };
