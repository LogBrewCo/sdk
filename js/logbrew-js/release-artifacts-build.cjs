"use strict";

const { spawnSync } = require("node:child_process");
const net = require("node:net");

/**
 * @typedef {{
 *   readonly allowHostedUpload: boolean,
 *   readonly dryRun: boolean,
 *   readonly endpoint: string,
 *   readonly maxRetries: number | undefined,
 *   readonly retryDelay: number | undefined,
 *   readonly timeout: number | undefined,
 *   readonly tokenEnv: string | undefined
 * }} ReleaseArtifactUploadOptions
 * @typedef {{ readonly integer: boolean, readonly integration: string, readonly maximum: number, readonly minimum: number }} NumberBounds
 * @typedef {{ readonly report: unknown, readonly stdout: string }} ReleaseArtifactCliResult
 */

const HOSTED_UPLOAD_ENDPOINT = "https://api.logbrew.co/api/release-artifacts";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ENVIRONMENT_VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const REPORT_STATUS_RE = /^[a-z][a-z0-9_]{0,63}$/u;
const WHITESPACE_RUN_RE = /\s+/gu;
const UPLOAD_OPTION_NAMES = new Set([
  "allowHostedUpload",
  "dryRun",
  "endpoint",
  "maxRetries",
  "retryDelay",
  "timeout",
  "tokenEnv"
]);
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_RETRIES = 10;
const MAX_RETRY_DELAY_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 300;
const MIN_UPLOAD_SETTING = 0;
const LAST_CONTROL_CHARACTER = 31;
const DELETE_CHARACTER = 127;
const MAX_DIAGNOSTIC_LENGTH = 200;
const MAX_DIAGNOSTICS = 3;
const START = 0;
const NOT_AN_IP = 0;
const ONE_ARTIFACT = 1;
const SUCCESS_EXIT_CODE = 0;

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} options
 * @param {string} name
 * @param {string} integration
 * @returns {boolean}
 */
function optionalBoolean(options, name, integration) {
  const value = field(options, name);
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`LogBrew ${integration} release-artifact upload option ${name} must be a boolean`);
}

/**
 * @param {unknown} options
 * @param {string} name
 * @param {string} integration
 * @returns {string | undefined}
 */
function optionalString(options, name, integration) {
  const value = field(options, name);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew ${integration} release-artifact upload option ${name} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * @param {unknown} options
 * @param {string} name
 * @param {string} integration
 * @returns {string}
 */
function requiredString(options, name, integration) {
  const value = optionalString(options, name, integration);
  if (value === undefined) {
    throw new Error(`LogBrew ${integration} release-artifact upload requires ${name}`);
  }
  return value;
}

/**
 * @param {unknown} options
 * @param {string} name
 * @param {NumberBounds} bounds
 * @returns {number | undefined}
 */
function optionalBoundedNumber(options, name, { integer, integration, maximum, minimum }) {
  const value = field(options, name);
  if (value === undefined || value === null) {
    return undefined;
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
      `LogBrew ${integration} release-artifact upload option ${name} must be ${kind} from ${String(minimum)} to ${String(maximum)}`
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} integration
 * @returns {string | undefined}
 */
function normalizeReleaseArtifactProjectId(value, integration) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !UUID_RE.test(value.trim())) {
    throw new Error(`LogBrew ${integration} release-artifact option projectId must be a UUID`);
  }
  return value.trim().toLowerCase();
}

/**
 * @param {string} endpoint
 * @param {string} integration
 * @returns {URL}
 */
function parseUploadEndpoint(endpoint, integration) {
  try {
    return new URL(endpoint);
  } catch {
    throw new Error(`LogBrew ${integration} release-artifact upload endpoint must be a valid URL`);
  }
}

/**
 * @param {string} endpoint
 * @param {string} integration
 * @returns {string}
 */
function uploadEndpointHostname(endpoint, integration) {
  const { hostname, protocol } = parseUploadEndpoint(endpoint, integration);
  if (!HTTP_PROTOCOLS.has(protocol)) {
    throw new Error(`LogBrew ${integration} release-artifact upload endpoint must use http or https`);
  }
  return hostname;
}

/**
 * @param {string} endpointHostname
 * @returns {boolean}
 */
function isLoopbackEndpoint(endpointHostname) {
  const hostname = endpointHostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    (net.isIP(hostname) !== NOT_AN_IP && (hostname.startsWith("127.") || hostname === "::1"))
  );
}

/**
 * @param {string} endpoint
 * @param {boolean} allowHostedUpload
 * @param {Readonly<{ integration: string, projectId: string | null | undefined }>} context
 * @returns {void}
 */
function requireHostedUpload(endpoint, allowHostedUpload, { integration, projectId }) {
  if (!allowHostedUpload) {
    throw new Error(`LogBrew ${integration} release-artifact hosted upload requires allowHostedUpload`);
  }
  if (endpoint !== HOSTED_UPLOAD_ENDPOINT) {
    throw new Error(`LogBrew ${integration} hosted release-artifact uploads must use ${HOSTED_UPLOAD_ENDPOINT}`);
  }
  if (projectId === undefined || projectId === null || projectId === "") {
    throw new Error(`LogBrew ${integration} release-artifact hosted upload requires projectId`);
  }
}

/**
 * @param {unknown} upload
 * @param {string} integration
 * @param {string | null | undefined} projectId
 * @returns {{ readonly allowHostedUpload: boolean, readonly endpoint: string }}
 */
function requireUploadTarget(upload, integration, projectId) {
  const endpoint = requiredString(upload, "endpoint", integration);
  const hostname = uploadEndpointHostname(endpoint, integration);
  const allowHostedUpload = optionalBoolean(upload, "allowHostedUpload", integration);
  if (!isLoopbackEndpoint(hostname)) {
    requireHostedUpload(endpoint, allowHostedUpload, { integration, projectId });
  }
  return { allowHostedUpload, endpoint };
}

/**
 * @param {unknown} upload
 * @param {string} integration
 * @returns {string | undefined}
 */
function optionalTokenEnv(upload, integration) {
  const tokenEnv = optionalString(upload, "tokenEnv", integration);
  if (tokenEnv !== undefined && !ENVIRONMENT_VARIABLE_NAME_RE.test(tokenEnv)) {
    throw new Error(`LogBrew ${integration} release-artifact upload option tokenEnv must be an environment variable name`);
  }
  return tokenEnv;
}

/**
 * @param {unknown} upload
 * @param {string} integration
 * @returns {void}
 */
function requireKnownUploadOptions(upload, integration) {
  const uploadObject = typeof upload === "object" && upload !== null && !Array.isArray(upload);
  if (!uploadObject) {
    throw new Error(`LogBrew ${integration} release-artifact option upload must be an object`);
  }
  const unknownOption = Object.keys(upload).find((name) => !UPLOAD_OPTION_NAMES.has(name));
  if (unknownOption !== undefined && unknownOption !== "") {
    throw new Error(`LogBrew ${integration} release-artifact unknown upload option ${unknownOption}`);
  }
}

/**
 * @param {unknown} upload
 * @param {Readonly<{ integration: string, projectId: string | null | undefined }>} context
 * @returns {ReleaseArtifactUploadOptions | undefined}
 */
function normalizeReleaseArtifactUploadOptions(upload, { integration, projectId }) {
  if (upload === undefined || upload === null) {
    return undefined;
  }
  requireKnownUploadOptions(upload, integration);
  const { allowHostedUpload, endpoint } = requireUploadTarget(upload, integration, projectId);
  const tokenEnv = optionalTokenEnv(upload, integration);
  const dryRun = optionalBoolean(upload, "dryRun", integration);
  const maxRetries = optionalBoundedNumber(upload, "maxRetries", { integer: true, integration, maximum: MAX_RETRIES, minimum: MIN_UPLOAD_SETTING });
  const retryDelay = optionalBoundedNumber(upload, "retryDelay", { integer: false, integration, maximum: MAX_RETRY_DELAY_SECONDS, minimum: MIN_UPLOAD_SETTING });
  const timeout = optionalBoundedNumber(upload, "timeout", { integer: false, integration, maximum: MAX_TIMEOUT_SECONDS, minimum: MIN_UPLOAD_SETTING });
  return { allowHostedUpload, dryRun, endpoint, maxRetries, retryDelay, timeout, tokenEnv };
}

/**
 * @param {string} name
 * @param {number | string | undefined} value
 * @returns {string[]}
 */
function optionArgs(name, value) {
  return value === undefined ? [] : [name, String(value)];
}

/**
 * @param {string} buildDir
 * @param {string} manifestPath
 * @param {ReleaseArtifactUploadOptions} upload
 * @returns {string[]}
 */
function createReleaseArtifactUploadArgs(buildDir, manifestPath, upload) {
  return [
    "--build-dir",
    buildDir,
    "--manifest",
    manifestPath,
    "--endpoint",
    upload.endpoint,
    ...optionArgs("--token-env", upload.tokenEnv),
    ...(upload.allowHostedUpload ? ["--allow-hosted"] : []),
    ...(upload.dryRun ? ["--dry-run"] : []),
    ...optionArgs("--max-retries", upload.maxRetries),
    ...optionArgs("--retry-delay", upload.retryDelay),
    ...optionArgs("--timeout", upload.timeout)
  ];
}

/**
 * @param {string} stdout
 * @param {string} command
 * @returns {unknown}
 */
function parseJson(stdout, command) {
  try {
    /** @type {unknown} */
    const report = JSON.parse(stdout);
    return report;
  } catch (error) {
    throw new Error(`LogBrew release-artifact ${command} did not return JSON`, { cause: error });
  }
}

/**
 * @param {string} message
 * @returns {string}
 */
function sanitizeValidationDiagnostic(message) {
  const printable = Array.from(message, (character) => {
    const codePoint = character.codePointAt(START) ?? START;
    return codePoint <= LAST_CONTROL_CHARACTER || codePoint === DELETE_CHARACTER ? " " : character;
  }).join("");
  return printable.replaceAll(WHITESPACE_RUN_RE, " ").trim().slice(START, MAX_DIAGNOSTIC_LENGTH);
}

/**
 * @param {unknown} report
 * @returns {string[]}
 */
function validationErrors(report) {
  const errors = field(field(report, "validation"), "errors");
  if (!Array.isArray(errors)) {
    return [];
  }
  /** @type {readonly unknown[]} */
  const messages = errors;
  return messages
    .filter((message) => typeof message === "string")
    .map((message) => sanitizeValidationDiagnostic(message))
    .filter((message) => message !== "")
    .slice(START, MAX_DIAGNOSTICS);
}

/**
 * @param {unknown} report
 * @returns {string | undefined}
 */
function safeReportStatus(report) {
  const status = field(report, "status");
  return typeof status === "string" && REPORT_STATUS_RE.test(status) ? status : undefined;
}

/**
 * @param {unknown} output
 * @returns {string}
 */
function textOutput(output) {
  return typeof output === "string" ? output : "";
}

/**
 * @param {string} cliPath
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {ReleaseArtifactCliResult}
 */
function runReleaseArtifactCli(cliPath, command, args) {
  const result = spawnSync(process.execPath, [cliPath, command, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  const stdout = textOutput(result.stdout);
  const report = stdout === "" ? undefined : parseJson(stdout, command);
  if (result.status !== SUCCESS_EXIT_CODE) {
    const errors = validationErrors(report).join("; ");
    const details = errors === "" ? safeReportStatus(report) ?? "execution_failed" : errors;
    throw new Error(`LogBrew release-artifact ${command} failed: ${details}`);
  }
  return { report, stdout };
}

/**
 * @param {unknown} report
 * @returns {string}
 */
function formatReleaseArtifactUploadSummary(report) {
  const count = field(report, "artifactCount");
  const artifactCount = typeof count === "number" && Number.isSafeInteger(count) && count >= START ? count : START;
  const artifactLabel = artifactCount === ONE_ARTIFACT ? "artifact" : "artifacts";
  return `LogBrew release artifacts: ${safeReportStatus(report) ?? "unknown"} (${String(artifactCount)} ${artifactLabel})`;
}

module.exports = {
  createReleaseArtifactUploadArgs,
  formatReleaseArtifactUploadSummary,
  normalizeReleaseArtifactProjectId,
  normalizeReleaseArtifactUploadOptions,
  runReleaseArtifactCli
};
