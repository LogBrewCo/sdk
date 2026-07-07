#!/usr/bin/env node
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  byteSize,
  printJson,
  readJsonObject,
  requireBuildDir,
  safeResolve,
  sha256File,
  sortJson,
  stableJson
} from "./release-artifacts-common.js";
import { runUploadJs } from "./release-artifacts-upload.js";
import { verifyJavaScriptIssueSymbolication, verifyJavaScriptSymbolication } from "./release-artifacts-symbolication.js";

const DEBUG_ID_NAMESPACE = "16f4a837-7e0b-4d7c-97d9-8a7af1fd2768";
const DEBUG_ID_RE = /(?:\/\/#|\/\*#)\s*debugId=([A-Za-z0-9._:-]+)/giu;
const MINIFIED_SOURCE_SUFFIXES = [".js", ".mjs", ".bundle", ".jsbundle"];
const SCRIPT_VERSION = "0.1.0";
const SOURCE_MAP_DEBUG_ID_KEYS = ["debug_id", "debugId", "debugID", "x_debug_id"];
const SOURCE_MAPPING_COMMENT_RE = /(?:\/\/#|\/\*#)\s*sourceMappingURL=[^\r\n]*/giu;
const SOURCE_MAPPING_RE = /(?:\/\/#|\/\*#)\s*sourceMappingURL=([^\s*]+)/iu;

function usage() {
  return [
    "Usage:",
    "  logbrew-release-artifacts prepare-js --build-dir <dir> [--write] [--strip-sources-content] [--strip-source-prefix <path>...]",
    "  logbrew-release-artifacts manifest-js --build-dir <dir> --release <id> --environment <env> --service <name> --minified-path-prefix <url-or-path> [--repository-url <url>] [--commit-sha <sha>] [--allow-sources-content]",
    "  logbrew-release-artifacts symbolicate-js --build-dir <dir> --manifest <file> (--stack-frame <frame> | --issue-event <file>) [--source-root <dir>] [--context-lines <n>]",
    "  logbrew-release-artifacts upload-js --build-dir <dir> --manifest <file> --endpoint <url> [--allow-hosted] [--token-env <env>] [--dry-run] [--max-retries <n>] [--retry-delay <seconds>] [--timeout <seconds>]",
    "",
    "This installed-package helper prepares, validates, resolves, and uploads JavaScript source-map artifacts.",
    "upload-js is loopback-only by default; pass --allow-hosted for explicit HTTPS release-artifact endpoints."
  ].join("\n");
}

function parseOptions(args, spec) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = spec[name];
    if (!kind) {
      throw new Error(`unknown option: --${name}`);
    }
    if (kind === "boolean") {
      options[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${name}`);
    }
    index += 1;
    if (kind === "repeat") {
      options[name] = [...(options[name] ?? []), value];
    } else {
      options[name] = value;
    }
  }
  if (positionals.length > 0) {
    throw new Error(`unexpected positional argument: ${positionals[0]}`);
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

function optionalSourceContextOptions(options) {
  const hasSourceRoot = typeof options["source-root"] === "string" && options["source-root"].trim() !== "";
  const hasContextLines = typeof options["context-lines"] === "string" && options["context-lines"].trim() !== "";
  if (!hasSourceRoot && !hasContextLines) {
    return undefined;
  }
  if (!hasSourceRoot) {
    throw new Error("--source-root is required when --context-lines is provided");
  }
  let contextLines = 2;
  if (hasContextLines) {
    const value = options["context-lines"].trim();
    if (!/^\d+$/u.test(value)) {
      throw new Error("--context-lines must be an integer from 0 to 10");
    }
    contextLines = Number.parseInt(value, 10);
    if (contextLines < 0 || contextLines > 10) {
      throw new Error("--context-lines must be an integer from 0 to 10");
    }
  }
  return {
    sourceRoot: path.resolve(requireOption(options, "source-root")),
    contextLines
  };
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function relativeTo(root, filePath) {
  return toPosix(path.relative(root, filePath));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, value) {
  fs.writeFileSync(filePath, value, "utf8");
}

function readSourceMap(filePath) {
  let payload;
  try {
    payload = JSON.parse(readText(filePath));
  } catch (error) {
    return [null, [`source map is not valid JSON: ${error.message}`]];
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [null, ["source map must be a JSON object"]];
  }
  return [payload, []];
}

function findLastMatch(source, regex) {
  let result = null;
  regex.lastIndex = 0;
  for (const match of source.matchAll(regex)) {
    result = match[1]?.trim() ?? null;
  }
  return result;
}

function findDebugId(source) {
  return findLastMatch(source, DEBUG_ID_RE);
}

function findSourceMappingUrl(source) {
  const match = source.match(SOURCE_MAPPING_RE);
  return match?.[1]?.trim() ?? null;
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

function fileReference(value) {
  return value.split("?", 1)[0].split("#", 1)[0];
}

function resolveSourceMapPath(jsPath, buildDir, sourceMappingUrl) {
  const warnings = [];
  const errors = [];
  if (!sourceMappingUrl) {
    const fallback = `${jsPath}.map`;
    warnings.push("sourceMappingURL comment missing; checked sibling .map fallback");
    return [fs.existsSync(fallback) ? fallback : null, warnings, errors];
  }

  const reference = fileReference(sourceMappingUrl);
  if (reference.startsWith("data:")) {
    errors.push("inline source maps are not accepted for release artifact manifests");
    return [null, warnings, errors];
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(reference)) {
    errors.push("external sourceMappingURL cannot be validated from the local build directory");
    return [null, warnings, errors];
  }

  const candidate = reference.startsWith("/")
    ? path.join(buildDir, reference.slice(1))
    : path.join(path.dirname(jsPath), reference);
  const resolved = safeResolve(candidate, buildDir);
  if (!resolved) {
    errors.push("sourceMappingURL resolves outside the build directory");
  }
  return [resolved, warnings, errors];
}

function isMinifiedSource(filePath) {
  return !filePath.endsWith(".map") && MINIFIED_SOURCE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function walkFiles(root) {
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      results.push(entryPath);
    }
  }
  return results.sort();
}

function iterMinifiedSourceFiles(buildDir) {
  return walkFiles(buildDir).filter(isMinifiedSource);
}

function canonicalSourceWithoutDebugId(source) {
  return source.replace(DEBUG_ID_RE, "");
}

function canonicalSourceMapWithoutDebugId(payload) {
  const copy = { ...payload };
  for (const key of SOURCE_MAP_DEBUG_ID_KEYS) {
    delete copy[key];
  }
  return stableJson(copy);
}

function uuidBytes(value) {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function formatUuid(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidV5(namespace, name) {
  const bytes = crypto
    .createHash("sha1")
    .update(uuidBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function generateDebugId(relativeJsPath, jsSource, sourceMapPayload) {
  const digest = crypto.createHash("sha256");
  digest.update(relativeJsPath);
  digest.update("\0");
  digest.update(canonicalSourceWithoutDebugId(jsSource));
  digest.update("\0");
  digest.update(canonicalSourceMapWithoutDebugId(sourceMapPayload));
  return uuidV5(DEBUG_ID_NAMESPACE, digest.digest("hex"));
}

function sourceWithDebugId(source, debugId) {
  if (findDebugId(source)) {
    return source;
  }
  const debugLine = `//# debugId=${debugId}\n`;
  const matches = [...source.matchAll(SOURCE_MAPPING_COMMENT_RE)];
  if (matches.length === 0) {
    return `${source}${source.endsWith("\n") ? "" : "\n"}${debugLine}`;
  }
  const last = matches.at(-1);
  const prefix = source.slice(0, last.index);
  const separator = prefix.endsWith("\n") || prefix.endsWith("\r") ? "" : "\n";
  return `${prefix}${separator}${debugLine}${source.slice(last.index)}`;
}

function normalizeSourcePrefixes(values) {
  const prefixes = [];
  for (const value of values ?? []) {
    for (const candidate of [path.resolve(value), fs.existsSync(value) ? fs.realpathSync(value) : path.resolve(value)]) {
      const normalized = toPosix(candidate).replace(/\/+$/u, "");
      if (normalized && !prefixes.includes(normalized)) {
        prefixes.push(normalized);
      }
    }
  }
  return prefixes;
}

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

function sourceMapSourcesWithoutPrefixes(payload, prefixes) {
  if (prefixes.length === 0 || !Array.isArray(payload.sources)) {
    return null;
  }
  const updated = payload.sources.map((source) => (typeof source === "string" ? sourceWithoutPrefix(source, prefixes) : source));
  return JSON.stringify(updated) === JSON.stringify(payload.sources) ? null : updated;
}

function sourceMapPayloadForDebugId(payload, { stripSourcesContent, sourcePrefixes }) {
  const updatedSources = sourceMapSourcesWithoutPrefixes(payload, sourcePrefixes);
  if (!stripSourcesContent && !updatedSources) {
    return payload;
  }
  const updated = { ...payload };
  if (stripSourcesContent) {
    delete updated.sourcesContent;
  }
  if (updatedSources) {
    updated.sources = updatedSources;
  }
  return updated;
}

function sourceMapWithPrivacyUpdates(payload, debugId, { stripSourcesContent, sourcePrefixes }) {
  const updatedSources = sourceMapSourcesWithoutPrefixes(payload, sourcePrefixes);
  if (sourceMapDebugId(payload) && (!stripSourcesContent || !("sourcesContent" in payload)) && !updatedSources) {
    return payload;
  }
  const updated = { ...payload };
  if (!sourceMapDebugId(updated)) {
    updated.debug_id = debugId;
  }
  if (stripSourcesContent) {
    delete updated.sourcesContent;
  }
  if (updatedSources) {
    updated.sources = updatedSources;
  }
  return updated;
}

function inspectArtifactFiles(jsPath, buildDir) {
  const errors = [];
  const warnings = [];
  const relJs = relativeTo(buildDir, jsPath);
  const jsSize = byteSize(jsPath);

  if (jsSize === 0) {
    errors.push("minified source file is empty");
  }

  const jsSource = readText(jsPath);
  const jsDebugId = findDebugId(jsSource);
  const sourceMappingUrl = findSourceMappingUrl(jsSource);
  const [sourceMapPath, mapWarnings, mapErrors] = resolveSourceMapPath(jsPath, buildDir, sourceMappingUrl);
  warnings.push(...mapWarnings);
  errors.push(...mapErrors);

  let sourceMapPayload = null;
  let mapDebugId = null;
  let sourceMapRel = null;
  let sourceMapSize = null;
  if (!sourceMapPath) {
    errors.push("source map file is missing");
  } else if (!fs.existsSync(sourceMapPath)) {
    errors.push(`source map file is missing: ${relativeTo(buildDir, sourceMapPath)}`);
  } else if (byteSize(sourceMapPath) === 0) {
    errors.push(`source map file is empty: ${relativeTo(buildDir, sourceMapPath)}`);
  } else {
    sourceMapRel = relativeTo(buildDir, sourceMapPath);
    sourceMapSize = byteSize(sourceMapPath);
    const [payload, sourceMapErrors] = readSourceMap(sourceMapPath);
    errors.push(...sourceMapErrors);
    if (payload) {
      sourceMapPayload = payload;
      mapDebugId = sourceMapDebugId(payload);
    }
  }

  if (jsDebugId && mapDebugId && jsDebugId !== mapDebugId) {
    errors.push("minified source debugId does not match source map debugId");
  }

  return {
    errors,
    warnings,
    relJs,
    jsSize,
    jsSource,
    jsDebugId,
    sourceMappingUrl,
    sourceMapPath,
    sourceMapPayload,
    sourceMapRel,
    sourceMapSize,
    mapDebugId
  };
}

function buildArtifactPlan(jsPath, buildDir, options) {
  const {
    errors,
    warnings,
    relJs,
    jsSource,
    jsDebugId,
    sourceMapPayload,
    sourceMapRel,
    mapDebugId
  } = inspectArtifactFiles(jsPath, buildDir);
  const changes = [];
  let debugId = jsDebugId || mapDebugId;
  if (errors.length === 0 && sourceMapPayload) {
    if (!debugId) {
      debugId = generateDebugId(
        relJs,
        jsSource,
        sourceMapPayloadForDebugId(sourceMapPayload, options)
      );
      changes.push("minifiedSource.debugId", "sourceMap.debug_id");
    } else {
      if (!jsDebugId) {
        changes.push("minifiedSource.debugId");
      }
      if (!mapDebugId) {
        changes.push("sourceMap.debug_id");
      }
    }
    if (options.stripSourcesContent && "sourcesContent" in sourceMapPayload) {
      changes.push("sourceMap.sourcesContent");
    }
    if (sourceMapSourcesWithoutPrefixes(sourceMapPayload, options.sourcePrefixes)) {
      changes.push("sourceMap.sources");
    }
  }

  return {
    path: relJs,
    ...(sourceMapRel ? { sourceMapPath: sourceMapRel } : {}),
    ...(debugId ? { debugId } : {}),
    changes,
    validation: {
      status: errors.length > 0 ? "blocked" : "ready",
      errors,
      warnings
    }
  };
}

function applyArtifactPlan(artifact, buildDir, options) {
  const debugId = artifact.debugId;
  const jsPath = path.join(buildDir, artifact.path);
  const sourceMapPath = path.join(buildDir, artifact.sourceMapPath);
  const jsSource = readText(jsPath);
  const updatedSource = sourceWithDebugId(jsSource, debugId);
  if (updatedSource !== jsSource) {
    writeText(jsPath, updatedSource);
  }
  const [payload, errors] = readSourceMap(sourceMapPath);
  if (!payload || errors.length > 0) {
    throw new Error(`${artifact.path}: source map became unreadable before write`);
  }
  const updatedPayload = sourceMapWithPrivacyUpdates(payload, debugId, options);
  if (stableJson(updatedPayload) !== stableJson(payload)) {
    writeText(sourceMapPath, `${JSON.stringify(sortJson(updatedPayload), null, 2)}\n`);
  }
}

function createDebugIdPlan({ buildDir, write, stripSourcesContent, stripSourcePrefixes }) {
  const sourcePrefixes = normalizeSourcePrefixes(stripSourcePrefixes);
  const artifactOptions = { stripSourcesContent, sourcePrefixes };
  const artifacts = iterMinifiedSourceFiles(buildDir).map((filePath) => buildArtifactPlan(filePath, buildDir, artifactOptions));
  const errors = artifacts.length === 0 ? ["no JavaScript release artifact files found in build directory"] : [];
  const warnings = [];
  for (const artifact of artifacts) {
    errors.push(...artifact.validation.errors.map((message) => `${artifact.path}: ${message}`));
    warnings.push(...artifact.validation.warnings.map((message) => `${artifact.path}: ${message}`));
  }
  const status = errors.length > 0 ? "blocked" : "ready";
  if (write && status === "ready") {
    for (const artifact of artifacts) {
      applyArtifactPlan(artifact, buildDir, artifactOptions);
    }
  }
  return {
    manifestVersion: 1,
    tool: { name: "logbrew-js-release-artifact-debug-id-prep", version: SCRIPT_VERSION },
    stripSourcesContent,
    stripSourcePrefixCount: stripSourcePrefixes?.length ?? 0,
    writeApplied: Boolean(write && status === "ready"),
    artifacts,
    validation: { status, errors, warnings }
  };
}

function validateSourceMapPayload(payload, allowSourcesContent) {
  const errors = [];
  const warnings = [];
  if (payload.version === undefined) {
    errors.push("source map version is required");
  }
  if (!Array.isArray(payload.sources) || payload.sources.length === 0) {
    errors.push("source map sources must be a non-empty array");
  }
  if (typeof payload.mappings !== "string" || payload.mappings === "") {
    errors.push("source map mappings must be a non-empty string");
  }
  if ("sourcesContent" in payload) {
    if (allowSourcesContent) {
      warnings.push("source map contains sourcesContent; ensure app policy permits source upload");
    } else {
      errors.push("source map contains sourcesContent; rerun with --allow-sources-content only if policy permits it");
    }
  }
  return [errors, warnings];
}

function normalizeUrlOrPath(value) {
  const trimmed = value.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed)) {
    const parsed = new URL(trimmed);
    const normalizedPath = path.posix.normalize(parsed.pathname || "/").replace(/\/+$/u, "") || "/";
    return parsed.host
      ? `${parsed.protocol}//${parsed.host}${normalizedPath}`
      : `${parsed.protocol}//${normalizedPath}`;
  }
  return trimmed.split("?", 1)[0].split("#", 1)[0].trim().replace(/\/+$/u, "");
}

function joinUrlOrPath(prefix, relativePath) {
  const normalizedPrefix = normalizeUrlOrPath(prefix);
  const normalizedRelative = relativePath.replaceAll("\\", "/").replace(/^\/+/u, "");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(normalizedPrefix)) {
    const parsed = new URL(normalizedPrefix);
    const joinedPath = path.posix.join(parsed.pathname.replace(/\/+$/u, ""), normalizedRelative);
    const finalPath = joinedPath.startsWith("/") ? joinedPath : `/${joinedPath}`;
    return parsed.host
      ? `${parsed.protocol}//${parsed.host}${finalPath}`
      : `${parsed.protocol}//${finalPath}`;
  }
  return normalizedPrefix ? `${normalizedPrefix.replace(/\/+$/u, "")}/${normalizedRelative}` : normalizedRelative;
}

function buildManifestArtifact(jsPath, buildDir, minifiedPathPrefix, allowSourcesContent) {
  const {
    errors,
    warnings,
    relJs,
    jsSize,
    jsDebugId,
    sourceMappingUrl,
    sourceMapPath,
    sourceMapPayload,
    sourceMapRel,
    sourceMapSize,
    mapDebugId
  } = inspectArtifactFiles(jsPath, buildDir);
  let sourceMapEntry = null;
  if (sourceMapPayload && sourceMapPath && sourceMapRel) {
    const [payloadErrors, payloadWarnings] = validateSourceMapPayload(sourceMapPayload, allowSourcesContent);
    errors.push(...payloadErrors);
    warnings.push(...payloadWarnings);
    sourceMapEntry = {
      path: sourceMapRel,
      artifactSha256: sha256File(sourceMapPath),
      byteSize: sourceMapSize,
      sourceCount: Array.isArray(sourceMapPayload.sources) ? sourceMapPayload.sources.length : 0,
      hasSourcesContent: "sourcesContent" in sourceMapPayload,
      ...(mapDebugId ? { debugId: mapDebugId } : {})
    };
  }
  if (!jsDebugId && !mapDebugId) {
    warnings.push("no debugId found; backend matching must rely on release/environment/service and minified path");
  }

  const debugId = jsDebugId || mapDebugId;
  return {
    artifactType: "javascript_source_map",
    ...(debugId ? { debugId } : {}),
    minifiedSource: {
      path: relJs,
      minifiedUrl: joinUrlOrPath(minifiedPathPrefix, relJs),
      artifactSha256: sha256File(jsPath),
      byteSize: jsSize,
      ...(jsDebugId ? { debugId: jsDebugId } : {}),
      ...(sourceMappingUrl ? { sourceMappingUrl } : {})
    },
    sourceMap: sourceMapEntry,
    validation: {
      status: errors.length > 0 ? "blocked" : "ready",
      errors,
      warnings
    }
  };
}

function createManifest({ buildDir, release, environment, service, minifiedPathPrefix, allowSourcesContent, repositoryUrl, commitSha }) {
  const normalizedPrefix = normalizeUrlOrPath(minifiedPathPrefix.trim());
  const artifacts = iterMinifiedSourceFiles(buildDir).map((filePath) =>
    buildManifestArtifact(filePath, buildDir, normalizedPrefix, allowSourcesContent)
  );
  const errors = artifacts.length === 0 ? ["no JavaScript release artifact files found in build directory"] : [];
  const warnings = [];
  for (const artifact of artifacts) {
    const relPath = artifact.minifiedSource.path;
    errors.push(...artifact.validation.errors.map((message) => `${relPath}: ${message}`));
    warnings.push(...artifact.validation.warnings.map((message) => `${relPath}: ${message}`));
  }
  const git = {};
  if (repositoryUrl) {
    git.repositoryUrl = repositoryUrl.trim();
  }
  if (commitSha) {
    git.commitSha = commitSha.trim();
  }
  return {
    manifestVersion: 1,
    release,
    environment,
    service,
    artifactType: "javascript_source_map_manifest",
    minifiedPathPrefix: normalizedPrefix,
    uploader: { name: "logbrew-js-release-artifact-manifest", version: SCRIPT_VERSION },
    ...(Object.keys(git).length > 0 ? { git } : {}),
    artifacts,
    validation: {
      status: errors.length > 0 ? "blocked" : "ready",
      errors,
      warnings
    }
  };
}

function runPrepareJs(args) {
  const options = parseOptions(args, {
    "build-dir": "string",
    write: "boolean",
    "strip-sources-content": "boolean",
    "strip-source-prefix": "repeat"
  });
  const buildDir = requireBuildDir(requireOption(options, "build-dir"));
  const plan = createDebugIdPlan({
    buildDir,
    write: Boolean(options.write),
    stripSourcesContent: Boolean(options["strip-sources-content"]),
    stripSourcePrefixes: options["strip-source-prefix"] ?? []
  });
  printJson(plan);
  return plan.validation.status === "blocked" ? 1 : 0;
}

function runManifestJs(args) {
  const options = parseOptions(args, {
    "build-dir": "string",
    release: "string",
    environment: "string",
    service: "string",
    "minified-path-prefix": "string",
    "repository-url": "string",
    "commit-sha": "string",
    "allow-sources-content": "boolean"
  });
  const manifest = createManifest({
    buildDir: requireBuildDir(requireOption(options, "build-dir")),
    release: requireOption(options, "release"),
    environment: requireOption(options, "environment"),
    service: requireOption(options, "service"),
    minifiedPathPrefix: requireOption(options, "minified-path-prefix"),
    allowSourcesContent: Boolean(options["allow-sources-content"]),
    repositoryUrl: options["repository-url"],
    commitSha: options["commit-sha"]
  });
  printJson(manifest);
  return manifest.validation.status === "blocked" ? 1 : 0;
}

function runSymbolicateJs(args) {
  const options = parseOptions(args, {
    "build-dir": "string",
    manifest: "string",
    "stack-frame": "string",
    "issue-event": "string",
    "source-root": "string",
    "context-lines": "string"
  });
  try {
    const buildDir = requireBuildDir(requireOption(options, "build-dir"));
    const manifestPath = path.resolve(requireOption(options, "manifest"));
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`manifest file does not exist: ${options.manifest}`);
    }
    const stackFrame = typeof options["stack-frame"] === "string" && options["stack-frame"].trim() !== "";
    const issueEvent = typeof options["issue-event"] === "string" && options["issue-event"].trim() !== "";
    if (stackFrame === issueEvent) {
      throw new Error("provide exactly one of --stack-frame or --issue-event");
    }
    const manifest = readJsonObject(manifestPath, "manifest");
    const sourceContext = optionalSourceContextOptions(options);
    if (issueEvent) {
      const issueEventPath = path.resolve(requireOption(options, "issue-event"));
      if (!fs.existsSync(issueEventPath)) {
        throw new Error(`issue event file does not exist: ${options["issue-event"]}`);
      }
      const report = verifyJavaScriptIssueSymbolication({
        buildDir,
        manifest,
        issueEvent: readJsonObject(issueEventPath, "issue event"),
        sourceContext
      });
      printJson(report);
      return 0;
    }
    const report = verifyJavaScriptSymbolication({
      buildDir,
      manifest,
      stackFrame: requireOption(options, "stack-frame"),
      sourceContext
    });
    printJson(report);
    return 0;
  } catch (error) {
    printJson({
      status: "validation_failed",
      verifier: { name: "logbrew-js-release-artifact-symbolication-verifier", version: SCRIPT_VERSION },
      validation: { errors: [error.message] }
    });
    return 1;
  }
}

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return command ? 0 : 1;
  }
  try {
    if (command === "prepare-js") {
      return runPrepareJs(args);
    }
    if (command === "manifest-js") {
      return runManifestJs(args);
    }
    if (command === "symbolicate-js") {
      return runSymbolicateJs(args);
    }
    if (command === "upload-js") {
      return await runUploadJs(args);
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
