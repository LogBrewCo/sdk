/* global AbortController, clearTimeout */

import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  byteSize,
  printJson,
  readJsonObject,
  requireBuildDir,
  safeResolve,
  sha256File,
  stableJson
} from "./release-artifacts-common.js";

const DEFAULT_UPLOAD_TOKEN_ENV = "LOGBREW_RELEASE_ARTIFACT_TOKEN";
const NON_RETRYABLE_UPLOAD_STATUSES = new Set([400, 401, 403, 413]);
const RETRYABLE_UPLOAD_STATUSES = new Set([408, 429]);
const SCRIPT_VERSION = "0.1.0";

function parseOptions(args) {
  const spec = {
    "build-dir": "string",
    manifest: "string",
    endpoint: "string",
    "token-env": "string",
    "dry-run": "boolean",
    "allow-hosted": "boolean",
    "max-retries": "string",
    "retry-delay": "string",
    timeout: "string"
  };
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
    options[name] = value;
    index += 1;
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

function parseNonNegativeInteger(value, label) {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number.parseInt(trimmed, 10);
}

function parseNonNegativeNumber(value, label) {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

function endpointWithoutQuery(endpoint) {
  const parsed = new URL(endpoint);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname || "/"}`;
}

function parseEndpoint(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (error) {
    throw new Error(`upload endpoint is not a valid URL: ${error.message}`, { cause: error });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("release artifact upload proof endpoint must use http or https");
  }
  return parsed;
}

function isLoopbackEndpoint(parsed) {
  const hostname = parsed.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    (net.isIP(hostname) !== 0 && (hostname.startsWith("127.") || hostname === "::1"))
  );
}

function requireUploadEndpoint(endpoint, allowHosted) {
  const parsed = parseEndpoint(endpoint);
  if (isLoopbackEndpoint(parsed)) {
    return;
  }
  if (!allowHosted) {
    throw new Error("release artifact hosted upload requires explicit --allow-hosted; use loopback endpoints for local proof");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("hosted release artifact upload endpoints must use https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("hosted release artifact upload endpoints must not include embedded auth values");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("hosted release artifact upload endpoints must not include query strings or fragments");
  }
}

function quoteMultipartValue(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function encodeMultipart(manifest, files) {
  const boundary = `logbrew-${crypto.randomUUID().replaceAll("-", "")}`;
  const chunks = [];
  const appendPart = (name, filename, contentType, bytes) => {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "ascii"));
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${quoteMultipartValue(name)}"; filename="${quoteMultipartValue(filename)}"\r\n`,
        "utf8"
      )
    );
    chunks.push(Buffer.from(`Content-Type: ${contentType}\r\n\r\n`, "ascii"));
    chunks.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    chunks.push(Buffer.from("\r\n", "ascii"));
  };

  appendPart("manifest", "manifest.json", "application/json", Buffer.from(stableJson(manifest), "utf8"));
  for (const [name, filePath] of files) {
    appendPart(name, path.basename(filePath), "application/octet-stream", fs.readFileSync(filePath));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "ascii"));
  return { body: Buffer.concat(chunks), boundary };
}

function classifyUploadStatus(status) {
  if (status >= 200 && status < 300) {
    return "uploaded";
  }
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  if (NON_RETRYABLE_UPLOAD_STATUSES.has(status)) {
    return "validation_failed";
  }
  if (RETRYABLE_UPLOAD_STATUSES.has(status) || status >= 500) {
    return "retryable_error";
  }
  return "upload_failed";
}

function sleep(seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

async function postMultipart(endpoint, token, body, boundary, timeoutSeconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "User-Agent": `logbrew-release-artifact-verifier/${SCRIPT_VERSION}`
      },
      body,
      signal: controller.signal
    });
    await response.arrayBuffer();
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadWithRetries({ endpoint, token, body, boundary, maxRetries, retryDelaySeconds, timeoutSeconds }) {
  const attempts = [];
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    let result;
    try {
      const httpStatus = await postMultipart(endpoint, token, body, boundary, timeoutSeconds);
      result = classifyUploadStatus(httpStatus);
      attempts.push({ attempt, httpStatus, result });
    } catch {
      result = "retryable_error";
      attempts.push({ attempt, result });
    }

    if (result === "uploaded") {
      break;
    }
    if (result !== "retryable_error" || attempt > maxRetries) {
      break;
    }
    if (retryDelaySeconds > 0) {
      await sleep(retryDelaySeconds);
    }
  }
  const finalResult = attempts.at(-1)?.result ?? "upload_failed";
  return {
    status: finalResult,
    attempts,
    retryCount: Math.max(0, attempts.length - 1)
  };
}

function requireReadyJavaScriptManifest(manifest) {
  if (manifest.artifactType !== "javascript_source_map_manifest") {
    throw new Error("only javascript_source_map_manifest uploads are supported by this verifier");
  }
  if (!manifest.validation || manifest.validation.status !== "ready") {
    throw new Error("manifest validation status must be ready before upload");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("manifest must contain at least one JavaScript release artifact");
  }
}

function requireArtifactFile(artifact, buildDir, section, requiredFields) {
  const payload = artifact[section];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`artifact is missing ${section}`);
  }
  for (const field of requiredFields) {
    if (payload[field] === undefined || payload[field] === "") {
      throw new Error(`${section} is missing ${field}`);
    }
  }
  const filePath = safeResolve(path.join(buildDir, String(payload.path)), buildDir);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${section} file is missing: ${payload.path}`);
  }
  if (byteSize(filePath) !== Number(payload.byteSize)) {
    throw new Error(`${section} byte size changed after manifest creation: ${payload.path}`);
  }
  if (sha256File(filePath) !== String(payload.artifactSha256)) {
    throw new Error(`${section} sha256 changed after manifest creation: ${payload.path}`);
  }
  return filePath;
}

function collectUploadFiles(manifest, buildDir) {
  requireReadyJavaScriptManifest(manifest);
  const files = [];
  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("artifact entries must be JSON objects");
    }
    files.push([
      `minified_source_${index}`,
      requireArtifactFile(artifact, buildDir, "minifiedSource", ["path", "artifactSha256", "byteSize"])
    ]);
    files.push([
      `source_map_${index}`,
      requireArtifactFile(artifact, buildDir, "sourceMap", ["path", "artifactSha256", "byteSize"])
    ]);
  }
  return files;
}

function buildUploadReport({ endpoint, manifest, files, dryRun }) {
  return {
    uploader: { name: "logbrew-js-release-artifact-upload-verifier", version: SCRIPT_VERSION },
    endpoint: endpointWithoutQuery(endpoint),
    dryRun,
    release: manifest.release,
    environment: manifest.environment,
    service: manifest.service,
    artifactType: manifest.artifactType,
    artifactCount: manifest.artifacts.length,
    filePartCount: files.length
  };
}

function exitCodeForUploadStatus(status) {
  return {
    uploaded: 0,
    dry_run: 0,
    auth_missing: 2,
    auth_failed: 3,
    validation_failed: 4
  }[status] ?? 5;
}

export async function runUploadJs(args) {
  const options = parseOptions(args);
  try {
    const endpoint = requireOption(options, "endpoint");
    requireUploadEndpoint(endpoint, Boolean(options["allow-hosted"]));
    const buildDir = requireBuildDir(requireOption(options, "build-dir"));
    const manifestPath = path.resolve(requireOption(options, "manifest"));
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`manifest file does not exist: ${options.manifest}`);
    }
    const manifest = readJsonObject(manifestPath, "manifest");
    const files = collectUploadFiles(manifest, buildDir);
    const dryRun = Boolean(options["dry-run"]);
    const report = buildUploadReport({ endpoint, manifest, files, dryRun });

    if (dryRun) {
      printJson({ ...report, status: "dry_run", attempts: [], retryCount: 0 });
      return 0;
    }

    const tokenEnv = (options["token-env"] ?? DEFAULT_UPLOAD_TOKEN_ENV).trim();
    if (tokenEnv === "") {
      throw new Error("--token-env must not be empty");
    }
    const token = (process.env[tokenEnv] ?? "").trim();
    if (!token) {
      printJson({ ...report, status: "auth_missing", attempts: [], retryCount: 0, auth: { tokenEnv } });
      return exitCodeForUploadStatus("auth_missing");
    }

    const maxRetries = parseNonNegativeInteger(options["max-retries"] ?? "2", "--max-retries");
    const retryDelaySeconds = parseNonNegativeNumber(options["retry-delay"] ?? "0.25", "--retry-delay");
    const timeoutSeconds = parseNonNegativeNumber(options.timeout ?? "5", "--timeout");
    const { body, boundary } = encodeMultipart(manifest, files);
    const uploadReport = await uploadWithRetries({
      endpoint,
      token,
      body,
      boundary,
      maxRetries,
      retryDelaySeconds,
      timeoutSeconds
    });
    printJson({ ...report, ...uploadReport });
    return exitCodeForUploadStatus(uploadReport.status);
  } catch (error) {
    printJson({
      status: "validation_failed",
      uploader: { name: "logbrew-js-release-artifact-upload-verifier", version: SCRIPT_VERSION },
      validation: { errors: [error.message] }
    });
    return exitCodeForUploadStatus("validation_failed");
  }
}
