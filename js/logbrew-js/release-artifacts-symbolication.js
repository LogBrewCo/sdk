import fs from "node:fs";
import path from "node:path";

const SCRIPT_VERSION = "0.1.0";
const MAX_SOURCE_CONTEXT_FILE_BYTES = 1024 * 1024;
const SOURCE_MAP_DEBUG_ID_KEYS = ["debug_id", "debugId", "debugID", "x_debug_id"];
const VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ_VALUES = new Map([...VLQ_CHARS].map((char, index) => [char, index]));

function fileReference(value) {
  return value.split("?", 1)[0].split("#", 1)[0];
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function relativeTo(root, filePath) {
  return toPosix(path.relative(root, filePath));
}

function safeResolve(candidate, root) {
  const resolvedRoot = fs.realpathSync(root);
  const resolved = path.resolve(candidate);
  const comparable = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  const relative = path.relative(resolvedRoot, comparable);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return comparable;
  }
  return null;
}

function readJsonObject(filePath, label) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return payload;
}

function sourceMapDebugId(payload) {
  for (const key of SOURCE_MAP_DEBUG_ID_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

function parseStackFrame(stackFrame) {
  let line = stackFrame.trim();
  if (line.startsWith("at ")) {
    line = line.slice(3).trim();
  }
  let functionName = null;
  let location = line;
  if (line.endsWith(")") && line.includes(" (")) {
    const marker = line.lastIndexOf(" (");
    functionName = line.slice(0, marker);
    location = line.slice(marker + 2, -1);
  }
  const parts = location.split(":");
  if (parts.length < 3) {
    throw new Error("stack frame must end with :line:column");
  }
  const columnText = parts.pop();
  const lineText = parts.pop();
  const filename = parts.join(":");
  const generatedLine = Number.parseInt(lineText, 10);
  const generatedColumn = Number.parseInt(columnText, 10);
  if (!Number.isInteger(generatedLine) || !Number.isInteger(generatedColumn)) {
    throw new Error("stack frame line and column must be integers");
  }
  if (generatedLine < 1 || generatedColumn < 1) {
    throw new Error("stack frame line and column must be one-based positive integers");
  }
  return {
    filename,
    line: generatedLine,
    column: generatedColumn,
    ...(functionName ? { function: functionName } : {})
  };
}

function normalizeReference(value) {
  let normalized = fileReference(value.trim());
  if (normalized.startsWith("file://")) {
    normalized = normalized.slice("file://".length);
  }
  return normalized;
}

function artifactMatchesFrame(artifact, frame, buildDir) {
  if (!artifact.minifiedSource || typeof artifact.minifiedSource !== "object") {
    return false;
  }
  const artifactPath = String(artifact.minifiedSource.path ?? "");
  const artifactUrl = String(artifact.minifiedSource.minifiedUrl ?? "");
  const normalizedFrame = normalizeReference(String(frame.filename));
  if (normalizedFrame === normalizeReference(artifactUrl)) {
    return true;
  }
  if (normalizedFrame.replace(/^\/+|\/+$/gu, "") === artifactPath.replace(/^\/+|\/+$/gu, "")) {
    return true;
  }
  if (path.isAbsolute(normalizedFrame)) {
    const resolved = safeResolve(normalizedFrame, buildDir);
    if (resolved) {
      return relativeTo(buildDir, resolved) === artifactPath;
    }
  }
  return false;
}

function requireReadyArtifacts(manifest) {
  if (manifest.artifactType !== "javascript_source_map_manifest") {
    throw new Error("only javascript_source_map_manifest symbolication proof is supported");
  }
  if (!manifest.validation || manifest.validation.status !== "ready") {
    throw new Error("manifest validation status must be ready");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("manifest must contain at least one JavaScript source-map artifact");
  }
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("artifact entries must be JSON objects");
    }
    if (!artifact.validation || artifact.validation.status !== "ready") {
      throw new Error("all artifact validation statuses must be ready");
    }
  }
  return manifest.artifacts;
}

function findMatchingArtifact(manifest, frame, buildDir) {
  const artifact = requireReadyArtifacts(manifest).find((candidate) => artifactMatchesFrame(candidate, frame, buildDir));
  if (!artifact) {
    throw new Error("no manifest artifact matches the minified stack frame filename");
  }
  return artifact;
}

function loadManifestSourceMap(artifact, buildDir) {
  if (!artifact.sourceMap || typeof artifact.sourceMap !== "object" || !artifact.sourceMap.path) {
    throw new Error("matched artifact is missing source map metadata");
  }
  const sourceMapPath = safeResolve(path.join(buildDir, String(artifact.sourceMap.path)), buildDir);
  if (!sourceMapPath) {
    throw new Error("source map path resolves outside the build directory");
  }
  const payload = readJsonObject(sourceMapPath, "source map");
  if ("sourcesContent" in payload) {
    throw new Error("source map still contains sourcesContent; strip it before symbolication proof");
  }
  const artifactDebugId = artifact.debugId;
  const mapDebugId = sourceMapDebugId(payload);
  if (artifactDebugId && mapDebugId && artifactDebugId !== mapDebugId) {
    throw new Error("matched artifact debug ID does not match source map debug ID");
  }
  if (!Array.isArray(payload.sources) || payload.sources.length === 0) {
    throw new Error("source map sources must be a non-empty array");
  }
  if (typeof payload.mappings !== "string" || payload.mappings === "") {
    throw new Error("source map mappings must be a non-empty string");
  }
  return { path: sourceMapPath, payload };
}

function decodeVlqValues(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = VLQ_VALUES.get(char);
    if (digit === undefined) {
      throw new Error("source map mappings contain an invalid base64 VLQ character");
    }
    const continuation = digit & 32;
    value += (digit & 31) << shift;
    if (continuation) {
      shift += 5;
      continue;
    }
    values.push((value & 1 ? -1 : 1) * (value >> 1));
    value = 0;
    shift = 0;
  }
  if (shift) {
    throw new Error("source map mappings contain an unterminated base64 VLQ value");
  }
  return values;
}

function decodedMappingSegments(mappings) {
  const lines = [];
  let previousSource = 0;
  let previousOriginalLine = 0;
  let previousOriginalColumn = 0;
  let previousName = 0;
  for (const rawLine of mappings.split(";")) {
    let generatedColumn = 0;
    const lineSegments = [];
    if (rawLine) {
      for (const rawSegment of rawLine.split(",")) {
        if (!rawSegment) {
          continue;
        }
        const values = decodeVlqValues(rawSegment);
        if (![1, 4, 5].includes(values.length)) {
          throw new Error("source map segment must contain 1, 4, or 5 VLQ fields");
        }
        generatedColumn += values[0];
        if (values.length === 1) {
          lineSegments.push([generatedColumn, null, null, null, null]);
          continue;
        }
        previousSource += values[1];
        previousOriginalLine += values[2];
        previousOriginalColumn += values[3];
        let nameIndex = null;
        if (values.length === 5) {
          previousName += values[4];
          nameIndex = previousName;
        }
        lineSegments.push([generatedColumn, previousSource, previousOriginalLine, previousOriginalColumn, nameIndex]);
      }
    }
    lines.push(lineSegments);
  }
  return lines;
}

function safeOriginalSourceForReport(source) {
  if (typeof source !== "string") {
    throw new Error("source map segment references an invalid source value");
  }
  const value = fileReference(source.trim());
  if (!value) {
    throw new Error("source map segment references an invalid source value");
  }
  if (value.startsWith("file://") || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) {
    throw new Error("source map source path must be stripped before symbolication proof");
  }
  return value;
}

function originalPositionFor(payload, generatedLine, generatedColumn) {
  const generatedLineIndex = generatedLine - 1;
  const generatedColumnIndex = generatedColumn - 1;
  const lines = decodedMappingSegments(payload.mappings);
  if (generatedLineIndex >= lines.length) {
    throw new Error("generated line is outside source map mappings");
  }
  let bestSegment = null;
  for (const segment of lines[generatedLineIndex]) {
    if (segment[0] <= generatedColumnIndex) {
      bestSegment = segment;
    } else {
      break;
    }
  }
  if (!bestSegment || bestSegment[1] === null || bestSegment[2] === null || bestSegment[3] === null) {
    throw new Error("no original source mapping found for generated frame");
  }
  const sourceIndex = bestSegment[1];
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= payload.sources.length) {
    throw new Error("source map segment references an invalid source index");
  }
  const original = {
    source: safeOriginalSourceForReport(payload.sources[sourceIndex]),
    line: bestSegment[2] + 1,
    column: bestSegment[3] + 1
  };
  const nameIndex = bestSegment[4];
  if (Array.isArray(payload.names) && Number.isInteger(nameIndex) && nameIndex >= 0 && nameIndex < payload.names.length) {
    const name = payload.names[nameIndex];
    if (typeof name === "string" && name) {
      original.name = name;
    }
  }
  return original;
}

function requireContextLineCount(value) {
  if (value === undefined || value === null) {
    return 2;
  }
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new Error("source context line count must be an integer from 0 to 10");
  }
  return value;
}

function sourceRootRelativeCandidates(source) {
  const values = [];
  const add = (candidate) => {
    const cleaned = fileReference(String(candidate ?? "").trim()).replace(/\\/gu, "/");
    if (!cleaned || cleaned.startsWith("file://") || /^[A-Za-z]:[\\/]/u.test(cleaned)) {
      return;
    }
    const normalized = path.posix.normalize(cleaned.replace(/^\/+/u, ""));
    if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
      return;
    }
    values.push(normalized);
  };
  const addBundlerSuffixes = (candidate) => {
    const cleaned = fileReference(String(candidate ?? "").trim()).replace(/\\/gu, "/");
    for (const marker of ["/./", "!./"]) {
      const markerIndex = cleaned.lastIndexOf(marker);
      if (markerIndex >= 0) {
        add(cleaned.slice(markerIndex + marker.length));
      }
    }
    const parts = cleaned.replace(/^\/+/u, "").split("/");
    if (parts.length > 1 && /^\[[^\]/]+\]$/u.test(parts[0])) {
      add(parts.slice(1).join("/"));
    }
  };

  add(source);
  addBundlerSuffixes(source);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(source)) {
    try {
      const url = new URL(source);
      add(url.pathname);
      addBundlerSuffixes(url.pathname);
    } catch {
      // Non-standard bundler schemes should still use the direct candidate.
    }
  }
  return [...new Set(values)];
}

function sourceContextPathCandidates(source, sourceRoot, sourceMapPath) {
  const candidates = [];
  if (sourceMapPath) {
    candidates.push(path.resolve(path.dirname(sourceMapPath), source));
  }
  candidates.push(path.join(sourceRoot, source));
  for (const relativeSource of sourceRootRelativeCandidates(source)) {
    candidates.push(path.join(sourceRoot, relativeSource));
  }
  return [...new Set(candidates)];
}

function sourceContextForOriginalPosition(original, options = {}) {
  if (!options.sourceRoot) {
    return null;
  }
  if (typeof options.sourceRoot !== "string" || options.sourceRoot.trim() === "") {
    throw new Error("source context root must be a non-empty directory path");
  }
  const requestedSourceRoot = path.resolve(options.sourceRoot);
  if (!fs.existsSync(requestedSourceRoot) || !fs.statSync(requestedSourceRoot).isDirectory()) {
    throw new Error("source context root must resolve to an existing directory");
  }
  const sourceRoot = fs.realpathSync(requestedSourceRoot);
  let sourcePath = null;
  for (const candidate of sourceContextPathCandidates(original.source, sourceRoot, options.sourceMapPath)) {
    const resolved = safeResolve(candidate, sourceRoot);
    if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      sourcePath = resolved;
      break;
    }
  }
  if (!sourcePath) {
    throw new Error("original source file is not readable under the source context root");
  }

  const contextLines = requireContextLineCount(options.contextLines);
  if (fs.statSync(sourcePath).size > MAX_SOURCE_CONTEXT_FILE_BYTES) {
    throw new Error("source context file is too large for local report output");
  }
  const sourceLines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/u);
  const startLine = Math.max(1, original.line - contextLines);
  const endLine = Math.min(sourceLines.length, original.line + contextLines);
  const lines = [];
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    lines.push({
      line: lineNumber,
      text: sourceLines[lineNumber - 1] ?? "",
      highlighted: lineNumber === original.line
    });
  }

  return {
    source: relativeTo(sourceRoot, sourcePath),
    startLine,
    lines
  };
}

function isJsonObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function metadataFromIssueEvent(issueEvent) {
  if (!isJsonObject(issueEvent)) {
    throw new Error("issue event must be a JSON object");
  }
  if (isJsonObject(issueEvent.attributes) && isJsonObject(issueEvent.attributes.metadata)) {
    return {
      metadata: issueEvent.attributes.metadata,
      input: {
        type: "sdk_issue_event",
        ...(stringOrNull(issueEvent.id) ? { issueId: stringOrNull(issueEvent.id) } : {}),
        metadataSource: "attributes.metadata"
      }
    };
  }
  if (isJsonObject(issueEvent.metadata)) {
    return {
      metadata: issueEvent.metadata,
      input: {
        type: "issue_attributes",
        metadataSource: "metadata"
      }
    };
  }
  throw new Error("issue event must contain attributes.metadata or metadata");
}

function requireMetadataString(metadata, name) {
  const value = stringOrNull(metadata[name]);
  if (!value) {
    throw new Error(`issue event metadata is missing ${name}`);
  }
  return value;
}

function requireMetadataPositiveInteger(metadata, name) {
  const value = metadata[name];
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`issue event metadata ${name} must be a one-based positive integer`);
  }
  return value;
}

function requireMetadataMatchesManifest(metadata, manifest, name) {
  const value = requireMetadataString(metadata, name);
  if (manifest[name] !== value) {
    throw new Error(`issue event metadata ${name} does not match the manifest`);
  }
}

function stackFrameFromIssueMetadata(metadata) {
  const releaseArtifactType = requireMetadataString(metadata, "releaseArtifactType");
  if (releaseArtifactType !== "sourcemap") {
    throw new Error("issue event releaseArtifactType must be sourcemap");
  }
  const codeFile = stringOrNull(metadata.releaseArtifactCodeFile) ?? stringOrNull(metadata.errorFrameFile);
  if (!codeFile) {
    throw new Error("issue event metadata is missing releaseArtifactCodeFile");
  }
  const line = requireMetadataPositiveInteger(metadata, "errorFrameLine");
  const column = requireMetadataPositiveInteger(metadata, "errorFrameColumn");
  return `${codeFile}:${line}:${column}`;
}

export function verifyJavaScriptSymbolication({ buildDir, manifest, stackFrame, sourceContext }) {
  const frame = parseStackFrame(stackFrame);
  const artifact = findMatchingArtifact(manifest, frame, buildDir);
  const sourceMap = loadManifestSourceMap(artifact, buildDir);
  const original = originalPositionFor(sourceMap.payload, frame.line, frame.column);
  const resolvedSourceContext = sourceContextForOriginalPosition(original, {
    ...sourceContext,
    sourceMapPath: sourceMap.path
  });
  return {
    status: "resolved",
    verifier: { name: "logbrew-js-release-artifact-symbolication-verifier", version: SCRIPT_VERSION },
    release: manifest.release,
    environment: manifest.environment,
    service: manifest.service,
    debugId: artifact.debugId,
    generated: {
      path: artifact.minifiedSource.path,
      minifiedUrl: artifact.minifiedSource.minifiedUrl,
      line: frame.line,
      column: frame.column,
      ...(frame.function ? { function: frame.function } : {})
    },
    sourceMap: {
      path: artifact.sourceMap.path,
      hasSourcesContent: false
    },
    original,
    ...(resolvedSourceContext ? { sourceContext: resolvedSourceContext } : {})
  };
}

export function verifyJavaScriptIssueSymbolication({ buildDir, manifest, issueEvent, sourceContext }) {
  const { metadata, input } = metadataFromIssueEvent(issueEvent);
  requireMetadataMatchesManifest(metadata, manifest, "release");
  requireMetadataMatchesManifest(metadata, manifest, "environment");
  requireMetadataMatchesManifest(metadata, manifest, "service");

  const expectedDebugId = requireMetadataString(metadata, "releaseArtifactDebugId").toLowerCase();
  const report = verifyJavaScriptSymbolication({
    buildDir,
    manifest,
    stackFrame: stackFrameFromIssueMetadata(metadata),
    sourceContext
  });
  if (typeof report.debugId !== "string" || report.debugId.toLowerCase() !== expectedDebugId) {
    throw new Error("issue event releaseArtifactDebugId does not match the resolved artifact");
  }
  return {
    ...report,
    input
  };
}
