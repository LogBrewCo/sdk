"use strict";

const { spawnSync } = require("node:child_process");
const net = require("node:net");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UPLOAD_OPTION_NAMES = new Set([
  "allowHostedUpload",
  "dryRun",
  "endpoint",
  "maxRetries",
  "retryDelay",
  "timeout",
  "tokenEnv",
]);

function optionalBoolean(options, name, integration, defaultValue = false) {
  const value = options?.[name];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new Error(`LogBrew ${integration} release-artifact upload option ${name} must be a boolean`);
  }
  return value;
}

function optionalString(options, name, integration) {
  const value = options?.[name];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew ${integration} release-artifact upload option ${name} must be a non-empty string`);
  }
  return value.trim();
}

function requiredString(options, name, integration) {
  const value = optionalString(options, name, integration);
  if (!value) {
    throw new Error(`LogBrew ${integration} release-artifact upload requires ${name}`);
  }
  return value;
}

function optionalBoundedNumber(options, name, integration, minimum, maximum, integer = false) {
  const value = options?.[name];
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) {
    const kind = integer ? "an integer" : "a number";
    throw new Error(
      `LogBrew ${integration} release-artifact upload option ${name} must be ${kind} from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function normalizeReleaseArtifactProjectId(value, integration) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !UUID_RE.test(value.trim())) {
    throw new Error(`LogBrew ${integration} release-artifact option projectId must be a UUID`);
  }
  return value.trim().toLowerCase();
}

function parseUploadEndpoint(endpoint, integration) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`LogBrew ${integration} release-artifact upload endpoint must be a valid URL`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error(`LogBrew ${integration} release-artifact upload endpoint must use http or https`);
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

function normalizeReleaseArtifactUploadOptions(upload, { integration, projectId }) {
  if (upload === undefined || upload === null) {
    return null;
  }
  if (typeof upload !== "object" || Array.isArray(upload)) {
    throw new Error(`LogBrew ${integration} release-artifact option upload must be an object`);
  }
  const unknownOption = Object.keys(upload).find((name) => !UPLOAD_OPTION_NAMES.has(name));
  if (unknownOption) {
    throw new Error(`LogBrew ${integration} release-artifact unknown upload option ${unknownOption}`);
  }

  const endpoint = requiredString(upload, "endpoint", integration);
  const parsedEndpoint = parseUploadEndpoint(endpoint, integration);
  const allowHostedUpload = optionalBoolean(upload, "allowHostedUpload", integration);
  const hosted = !isLoopbackEndpoint(parsedEndpoint);
  if (hosted && !allowHostedUpload) {
    throw new Error(`LogBrew ${integration} release-artifact hosted upload requires allowHostedUpload`);
  }
  if (hosted && parsedEndpoint.protocol !== "https:") {
    throw new Error(`LogBrew ${integration} hosted release-artifact upload endpoint must use https`);
  }
  if (hosted && (parsedEndpoint.username || parsedEndpoint.password)) {
    throw new Error(`LogBrew ${integration} hosted release-artifact upload endpoint must not include embedded auth values`);
  }
  if (hosted && (parsedEndpoint.search || parsedEndpoint.hash)) {
    throw new Error(`LogBrew ${integration} hosted release-artifact upload endpoint must not include query strings or fragments`);
  }
  if (hosted && !projectId) {
    throw new Error(`LogBrew ${integration} release-artifact hosted upload requires projectId`);
  }

  const tokenEnv = optionalString(upload, "tokenEnv", integration);
  if (tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnv)) {
    throw new Error(`LogBrew ${integration} release-artifact upload option tokenEnv must be an environment variable name`);
  }

  return {
    endpoint,
    allowHostedUpload,
    tokenEnv,
    dryRun: optionalBoolean(upload, "dryRun", integration),
    maxRetries: optionalBoundedNumber(upload, "maxRetries", integration, 0, 10, true),
    retryDelay: optionalBoundedNumber(upload, "retryDelay", integration, 0, 60),
    timeout: optionalBoundedNumber(upload, "timeout", integration, 0, 300),
  };
}

function appendOption(args, name, value) {
  if (value !== null) {
    args.push(name, String(value));
  }
}

function createReleaseArtifactUploadArgs(buildDir, manifestPath, upload) {
  const args = ["--build-dir", buildDir, "--manifest", manifestPath, "--endpoint", upload.endpoint];
  appendOption(args, "--token-env", upload.tokenEnv);
  if (upload.allowHostedUpload) {
    args.push("--allow-hosted");
  }
  if (upload.dryRun) {
    args.push("--dry-run");
  }
  appendOption(args, "--max-retries", upload.maxRetries);
  appendOption(args, "--retry-delay", upload.retryDelay);
  appendOption(args, "--timeout", upload.timeout);
  return args;
}

function parseJson(stdout, command) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`LogBrew release-artifact ${command} did not return JSON`, { cause: error });
  }
}

function sanitizeValidationDiagnostic(message) {
  const printable = Array.from(message, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
  return printable.replace(/\s+/gu, " ").trim().slice(0, 200);
}

function validationErrors(report) {
  if (!report?.validation || !Array.isArray(report.validation.errors)) {
    return [];
  }
  return report.validation.errors
    .filter((message) => typeof message === "string")
    .map(sanitizeValidationDiagnostic)
    .filter((message) => message !== "")
    .slice(0, 3);
}

function safeReportStatus(report) {
  const status = report?.status;
  return typeof status === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(status) ? status : null;
}

function runReleaseArtifactCli(cliPath, command, args) {
  const result = spawnSync(process.execPath, [cliPath, command, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  const report = result.stdout ? parseJson(result.stdout, command) : null;
  if (result.status !== 0) {
    const details = validationErrors(report).join("; ") || safeReportStatus(report) || "execution_failed";
    throw new Error(`LogBrew release-artifact ${command} failed: ${details}`);
  }
  return { report, stdout: result.stdout };
}

function formatReleaseArtifactUploadSummary(report) {
  const artifactCount = Number.isSafeInteger(report?.artifactCount) && report.artifactCount >= 0 ? report.artifactCount : 0;
  const artifactLabel = artifactCount === 1 ? "artifact" : "artifacts";
  return `LogBrew release artifacts: ${safeReportStatus(report) ?? "unknown"} (${artifactCount} ${artifactLabel})`;
}

module.exports = {
  createReleaseArtifactUploadArgs,
  formatReleaseArtifactUploadSummary,
  normalizeReleaseArtifactProjectId,
  normalizeReleaseArtifactUploadOptions,
  runReleaseArtifactCli,
};
