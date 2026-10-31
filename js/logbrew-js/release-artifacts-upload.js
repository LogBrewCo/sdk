import {
  encodeMultipart,
  endpointWithoutQuery,
  requireUploadEndpoint,
  uploadWithRetries
} from "./release-artifacts-upload-request.js";
import {
  errorMessage,
  parseOptions,
  pathExists,
  printJson,
  readJsonObject,
  requireBuildDir,
  requireOption
} from "./release-artifacts-common.js";
import { collectUploadFiles } from "./release-artifacts-upload-files.js";
import path from "node:path";

/**
 * @import { CliOptions, JsonObject } from "./release-artifacts-common.js"
 * @import { UploadFile } from "./release-artifacts-upload-request.js"
 * @typedef {{ readonly endpoint: string, readonly files: readonly UploadFile[], readonly manifest: JsonObject, readonly report: JsonObject }} PreparedUpload
 */

const DEFAULT_UPLOAD_TOKEN_ENV = "LOGBREW_RELEASE_ARTIFACT_TOKEN";
const SCRIPT_VERSION = "0.1.0";
const NO_RETRIES = 0;
const DECIMAL = 10;
const NON_NEGATIVE_INTEGER_RE = /^\d+$/u;
const UPLOADER = { name: "logbrew-js-release-artifact-upload-verifier", version: SCRIPT_VERSION };
const EXIT_OK = 0;
const EXIT_AUTH_MISSING = 2;
const EXIT_AUTH_FAILED = 3;
const EXIT_VALIDATION_FAILED = 4;
const EXIT_CODES = new Map([
  ["auth_failed", EXIT_AUTH_FAILED],
  ["auth_missing", EXIT_AUTH_MISSING],
  ["dry_run", EXIT_OK],
  ["uploaded", EXIT_OK],
  ["validation_failed", EXIT_VALIDATION_FAILED]
]);
const UNKNOWN_FAILURE_EXIT_CODE = 5;

/**
 * @param {string} value
 * @param {string} label
 * @returns {number}
 */
function parseNonNegativeInteger(value, label) {
  const trimmed = value.trim();
  if (!NON_NEGATIVE_INTEGER_RE.test(trimmed)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number.parseInt(trimmed, DECIMAL);
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {number}
 */
function parseNonNegativeNumber(value, label) {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < NO_RETRIES) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

/**
 * @param {string} status
 * @returns {number}
 */
function exitCodeForUploadStatus(status) {
  return EXIT_CODES.get(status) ?? UNKNOWN_FAILURE_EXIT_CODE;
}

/**
 * @param {CliOptions} options
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function optionOrDefault(options, name, fallback) {
  const value = options[name];
  return typeof value === "string" ? value : fallback;
}

/**
 * @param {CliOptions} options
 * @returns {Promise<PreparedUpload>}
 */
async function prepareUpload(options) {
  const endpoint = requireOption(options, "endpoint");
  const loopback = requireUploadEndpoint(endpoint, options["allow-hosted"] === true);
  const buildDir = await requireBuildDir(requireOption(options, "build-dir"));
  const manifestPath = path.resolve(requireOption(options, "manifest"));
  if (!(await pathExists(manifestPath))) {
    throw new Error(`manifest file does not exist: ${String(options["manifest"])}`);
  }
  const manifest = await readJsonObject(manifestPath, "manifest");
  const { artifactCount, files } = await collectUploadFiles(manifest, buildDir, !loopback);
  return {
    endpoint,
    files,
    manifest,
    report: {
      artifactCount,
      artifactType: manifest["artifactType"],
      dryRun: options["dry-run"] === true,
      endpoint: endpointWithoutQuery(endpoint),
      environment: manifest["environment"],
      filePartCount: files.length,
      release: manifest["release"],
      service: manifest["service"],
      uploader: UPLOADER
    }
  };
}

/**
 * @param {CliOptions} options
 * @param {PreparedUpload} prepared
 * @param {string} token
 * @returns {Promise<number>}
 */
async function sendUpload(options, { endpoint, files, manifest, report }, token) {
  const maxRetries = parseNonNegativeInteger(optionOrDefault(options, "max-retries", "2"), "--max-retries");
  const retryDelaySeconds = parseNonNegativeNumber(optionOrDefault(options, "retry-delay", "0.25"), "--retry-delay");
  const timeoutSeconds = parseNonNegativeNumber(optionOrDefault(options, "timeout", "5"), "--timeout");
  const { body, boundary } = await encodeMultipart(manifest, files);
  const uploadReport = await uploadWithRetries({ body, boundary, endpoint, maxRetries, retryDelaySeconds, timeoutSeconds, token });
  printJson({ ...report, ...uploadReport });
  return exitCodeForUploadStatus(uploadReport.status);
}

/**
 * @param {CliOptions} options
 * @returns {string}
 */
function requireTokenEnv(options) {
  const tokenEnv = optionOrDefault(options, "token-env", DEFAULT_UPLOAD_TOKEN_ENV).trim();
  if (tokenEnv === "") {
    throw new Error("--token-env must not be empty");
  }
  return tokenEnv;
}

/**
 * @param {CliOptions} options
 * @returns {Promise<number>}
 */
async function uploadFromOptions(options) {
  const prepared = await prepareUpload(options);
  if (options["dry-run"] === true) {
    printJson({ ...prepared.report, attempts: [], retryCount: NO_RETRIES, status: "dry_run" });
    return exitCodeForUploadStatus("dry_run");
  }
  const tokenEnv = requireTokenEnv(options);
  const token = (process.env[tokenEnv] ?? "").trim();
  if (token === "") {
    printJson({ ...prepared.report, attempts: [], auth: { tokenEnv }, retryCount: NO_RETRIES, status: "auth_missing" });
    return exitCodeForUploadStatus("auth_missing");
  }
  return sendUpload(options, prepared, token);
}

/**
 * @param {readonly string[]} args
 * @returns {Promise<number>}
 */
async function runUploadJs(args) {
  const options = parseOptions(args, {
    "allow-hosted": "boolean",
    "build-dir": "string",
    "dry-run": "boolean",
    endpoint: "string",
    manifest: "string",
    "max-retries": "string",
    "retry-delay": "string",
    timeout: "string",
    "token-env": "string"
  });
  try {
    return await uploadFromOptions(options);
  } catch (error) {
    printJson({ status: "validation_failed", uploader: UPLOADER, validation: { errors: [errorMessage(error)] } });
    return exitCodeForUploadStatus("validation_failed");
  }
}

export { runUploadJs };
