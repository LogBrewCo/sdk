import fs from "node:fs";
import path from "node:path";

const SCRIPT_VERSION = "0.1.0";
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
  return payload;
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

export function verifyJavaScriptSymbolication({ buildDir, manifest, stackFrame }) {
  const frame = parseStackFrame(stackFrame);
  const artifact = findMatchingArtifact(manifest, frame, buildDir);
  const sourceMap = loadManifestSourceMap(artifact, buildDir);
  const original = originalPositionFor(sourceMap, frame.line, frame.column);
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
    original
  };
}
