"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  field,
  normalizePlatform,
  normalizeStringArray,
  optionalString,
  optionalUploadScalar,
  requireUploadEndpoint,
  requiredString
} = require("./release-artifacts-options.cjs");
const {
  applyExplicitSourceMapReference,
  ensureInsideBuildDir,
  requireExistingFile,
  resolvePathFromRoot
} = require("./release-artifacts-files.cjs");

/**
 * @typedef {"android" | "ios"} ReleaseArtifactPlatform
 * @typedef {{ readonly report: unknown, readonly stdout: string }} ReleaseArtifactCliResult
 * @typedef {{
 *   readonly environment: string,
 *   readonly platform: ReleaseArtifactPlatform,
 *   readonly projectId: string | undefined,
 *   readonly release: string,
 *   readonly service: string
 * }} ReleaseIdentity
 * @typedef {{
 *   readonly buildDir: string,
 *   readonly bundlePath: string,
 *   readonly manifestPath: string,
 *   readonly root: string,
 *   readonly sourcemapPath: string
 * }} ReleaseLocations
 * @typedef {{
 *   readonly commitSha: string | undefined,
 *   readonly minifiedPathPrefix: string,
 *   readonly repositoryUrl: string | undefined,
 *   readonly sourcePrefixes: readonly string[],
 *   readonly stripSourcesContent: boolean
 * }} ReleaseManifestSettings
 * @typedef {{ readonly relativeBundlePath: string, readonly relativeSourceMapPath: string }} RelativeBundlePaths
 * @typedef {{
 *   readonly buildDir: string,
 *   readonly bundlePath: string,
 *   readonly sourcemapPath: string,
 *   readonly manifestPath: string,
 *   readonly platform: ReleaseArtifactPlatform,
 *   readonly prepareReport: unknown,
 *   readonly manifestReport: unknown
 * }} PreparedReleaseArtifacts
 * @typedef {{
 *   readonly allowHostedUpload: boolean,
 *   readonly dryRun: unknown,
 *   readonly endpoint: string,
 *   readonly maxRetries: string | undefined,
 *   readonly retryDelay: string | undefined,
 *   readonly timeout: string | undefined,
 *   readonly tokenEnv: string | undefined
 * }} ReleaseUploadSettings
 */

const PACKAGE_DIR = path.dirname(require.resolve("./package.json"));
const DEFAULT_MANIFEST_NAME = "logbrew-release-artifacts.json";
const NONE = 0;
const SUCCESS_EXIT_CODE = 0;

/**
 * @param {string} stdout
 * @param {string} command
 * @returns {unknown}
 */
function parseJson(stdout, command) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`LogBrew release-artifact ${command} did not return JSON`, { cause: error });
  }
}

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isArray(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is (this: unknown, ...args: readonly unknown[]) => unknown}
 */
function isCallable(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} report
 * @returns {unknown[]}
 */
function validationErrors(report) {
  const validation = field(report, "validation");
  const errors = field(validation, "errors");
  if (Boolean(validation) && isArray(errors)) {
    return errors.filter((message) => typeof message === "string" && message.trim() !== "");
  }
  return [];
}

/**
 * @param {unknown} report
 * @param {string} label
 * @param {(artifact: unknown) => boolean} predicate
 * @returns {unknown}
 */
function findReportArtifact(report, label, predicate) {
  const artifacts = field(report, "artifacts");
  if (artifacts === undefined || artifacts === null) {
    return undefined;
  }
  const find = field(artifacts, "find");
  if (!isCallable(find)) {
    throw new TypeError(`${label}?.artifacts?.find is not a function`);
  }
  return find.call(artifacts, predicate);
}

/**
 * @returns {string}
 */
function resolveLogBrewReleaseArtifactsCli() {
  try {
    const sdkEntry = require.resolve("@logbrew/sdk", { paths: [PACKAGE_DIR, process.cwd()] });
    return path.join(path.dirname(sdkEntry), "release-artifacts.js");
  } catch {
    const sourceTreeCli = path.resolve(PACKAGE_DIR, "../logbrew-js/release-artifacts.js");
    if (fs.existsSync(sourceTreeCli)) {
      return sourceTreeCli;
    }
    throw new Error("LogBrew React Native release-artifact helper requires @logbrew/sdk to be installed");
  }
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {ReleaseArtifactCliResult}
 */
function runReleaseArtifactCli(command, args) {
  const result = spawnSync(process.execPath, [resolveLogBrewReleaseArtifactsCli(), command, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  const report = result.stdout ? parseJson(result.stdout, command) : null;
  if (result.status !== SUCCESS_EXIT_CODE) {
    const details = validationErrors(report).join("; ") || result.stderr.trim() || `exit code ${String(result.status)}`;
    throw new Error(`LogBrew release-artifact ${command} failed: ${details}`);
  }
  return { report, stdout: result.stdout };
}

/**
 * @param {unknown} options
 * @returns {ReleaseIdentity}
 */
function readReleaseIdentity(options) {
  const release = requiredString(options, "release");
  const environment = requiredString(options, "environment");
  const service = requiredString(options, "service");
  const projectId = optionalString(options, "projectId");
  const platform = normalizePlatform(options);
  return { environment, platform, projectId, release, service };
}

/**
 * @param {unknown} options
 * @returns {ReleaseLocations}
 */
function readReleaseLocations(options) {
  const root = path.resolve(optionalString(options, "root") ?? process.cwd());
  const bundlePath = resolvePathFromRoot(root, requiredString(options, "bundle"));
  const sourcemapOption = optionalString(options, "sourcemap");
  const sourcemapPath = sourcemapOption === undefined ? `${bundlePath}.map` : resolvePathFromRoot(root, sourcemapOption);
  const buildDirOption = optionalString(options, "buildDir");
  const buildDir = buildDirOption === undefined ? path.dirname(bundlePath) : resolvePathFromRoot(root, buildDirOption);
  const manifestPath = resolvePathFromRoot(
    root,
    optionalString(options, "manifestPath") ?? path.join(buildDir, DEFAULT_MANIFEST_NAME)
  );
  return { buildDir, bundlePath, manifestPath, root, sourcemapPath };
}

/**
 * @param {unknown} options
 * @param {ReleaseArtifactPlatform} platform
 * @param {string} root
 * @returns {ReleaseManifestSettings}
 */
function readManifestSettings(options, platform, root) {
  const minifiedPathPrefix = optionalString(options, "minifiedPathPrefix") ?? `app:///react-native/${platform}`;
  const repositoryUrl = optionalString(options, "repositoryUrl");
  const commitSha = optionalString(options, "commitSha");
  const stripSourcesContent = field(options, "stripSourcesContent") !== false;
  const userSourcePrefixes = normalizeStringArray(field(options, "stripSourcePrefix"), "stripSourcePrefix");
  const sourcePrefixes = userSourcePrefixes.length > NONE ? userSourcePrefixes : [root];
  return { commitSha, minifiedPathPrefix, repositoryUrl, sourcePrefixes, stripSourcesContent };
}

/**
 * @param {ReleaseLocations} locations
 * @returns {RelativeBundlePaths}
 */
function checkBundleFiles({ buildDir, bundlePath, sourcemapPath }) {
  requireExistingFile("bundle", bundlePath);
  requireExistingFile("sourcemap", sourcemapPath);
  const relativeBundlePath = ensureInsideBuildDir("bundle", bundlePath, buildDir);
  const relativeSourceMapPath = ensureInsideBuildDir("sourcemap", sourcemapPath, buildDir);
  applyExplicitSourceMapReference(bundlePath, sourcemapPath);
  return { relativeBundlePath, relativeSourceMapPath };
}

/**
 * @param {ReleaseLocations} locations
 * @param {ReleaseManifestSettings} settings
 * @returns {string[]}
 */
function prepareArguments({ buildDir, root }, { sourcePrefixes, stripSourcesContent }) {
  const prepareArgs = ["--build-dir", buildDir, "--write"];
  if (stripSourcesContent) {
    prepareArgs.push("--strip-sources-content");
  }
  for (const prefix of sourcePrefixes) {
    prepareArgs.push("--strip-source-prefix", resolvePathFromRoot(root, prefix));
  }
  return prepareArgs;
}

/**
 * @param {ReleaseLocations} locations
 * @param {ReleaseManifestSettings} settings
 * @param {RelativeBundlePaths} relative
 * @returns {unknown}
 */
function runPrepare(locations, settings, { relativeBundlePath, relativeSourceMapPath }) {
  const { report } = runReleaseArtifactCli("prepare-js", prepareArguments(locations, settings));
  const preparedArtifact = findReportArtifact(report, "report", (artifact) => field(artifact, "path") === relativeBundlePath);
  if (preparedArtifact === undefined || preparedArtifact === null) {
    throw new Error(`LogBrew React Native release-artifact helper did not find bundle: ${relativeBundlePath}`);
  }
  if (field(preparedArtifact, "sourceMapPath") !== relativeSourceMapPath) {
    throw new Error(
      `LogBrew React Native release-artifact helper expected source map ${relativeSourceMapPath} for ${relativeBundlePath}`
    );
  }
  return report;
}

/**
 * @param {ReleaseIdentity} identity
 * @param {ReleaseLocations} locations
 * @param {ReleaseManifestSettings} settings
 * @returns {string[]}
 */
function manifestArguments({ environment, projectId, release, service }, { buildDir }, { commitSha, minifiedPathPrefix, repositoryUrl }) {
  const manifestArgs = [
    "--build-dir",
    buildDir,
    "--release",
    release,
    "--environment",
    environment,
    "--service",
    service,
    "--minified-path-prefix",
    minifiedPathPrefix
  ];
  if (projectId !== undefined) {
    manifestArgs.push("--project-id", projectId);
  }
  if (repositoryUrl !== undefined) {
    manifestArgs.push("--repository-url", repositoryUrl);
  }
  if (commitSha !== undefined) {
    manifestArgs.push("--commit-sha", commitSha);
  }
  return manifestArgs;
}

/**
 * @param {readonly string[]} manifestArgs
 * @param {RelativeBundlePaths} relative
 * @param {string} manifestPath
 * @returns {unknown}
 */
function runManifest(manifestArgs, { relativeBundlePath }, manifestPath) {
  const { report, stdout } = runReleaseArtifactCli("manifest-js", manifestArgs);
  const manifestArtifact = findReportArtifact(
    report,
    "manifestReport",
    (artifact) => field(field(artifact, "minifiedSource"), "path") === relativeBundlePath
  );
  if (manifestArtifact === undefined || manifestArtifact === null) {
    throw new Error(`LogBrew React Native release-artifact manifest did not include bundle: ${relativeBundlePath}`);
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, stdout, "utf8");
  return report;
}

/**
 * @param {unknown} [options]
 * @returns {PreparedReleaseArtifacts}
 */
function prepareLogBrewReactNativeReleaseArtifacts(options = {}) {
  const identity = readReleaseIdentity(options);
  const locations = readReleaseLocations(options);
  const settings = readManifestSettings(options, identity.platform, locations.root);
  const relative = checkBundleFiles(locations);
  const prepareReport = runPrepare(locations, settings, relative);
  const manifestReport = runManifest(manifestArguments(identity, locations, settings), relative, locations.manifestPath);
  const { buildDir, bundlePath, manifestPath, sourcemapPath } = locations;
  return {
    buildDir,
    bundlePath,

    sourcemapPath,

    manifestPath,
    platform: identity.platform,
    prepareReport,

    manifestReport
  };
}

/**
 * @param {unknown} options
 * @returns {{ readonly allowHostedUpload: boolean, readonly endpoint: string }}
 */
function readUploadEndpoint(options) {
  const endpoint = requiredString(options, "endpoint");
  const allowHostedUpload = field(options, "allowHostedUpload");
  if (allowHostedUpload !== undefined && typeof allowHostedUpload !== "boolean") {
    throw new Error("LogBrew React Native release-artifact helper option allowHostedUpload must be a boolean");
  }
  requireUploadEndpoint(endpoint, allowHostedUpload === true);
  return { allowHostedUpload: allowHostedUpload === true, endpoint };
}

/**
 * @param {unknown} options
 * @returns {ReleaseUploadSettings}
 */
function readUploadSettings(options) {
  const { allowHostedUpload, endpoint } = readUploadEndpoint(options);
  const tokenEnv = optionalString(options, "tokenEnv");
  const maxRetries = optionalUploadScalar(options, "maxRetries");
  const retryDelay = optionalUploadScalar(options, "retryDelay");
  const timeout = optionalUploadScalar(options, "timeout");
  const dryRun = field(options, "dryRun");
  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    throw new Error("LogBrew React Native release-artifact helper option dryRun must be a boolean");
  }
  return { allowHostedUpload, dryRun, endpoint, maxRetries, retryDelay, timeout, tokenEnv };
}

/**
 * @param {PreparedReleaseArtifacts} prepared
 * @param {ReleaseUploadSettings} settings
 * @returns {string[]}
 */
function uploadArguments({ buildDir, manifestPath }, { allowHostedUpload, dryRun, endpoint, maxRetries, retryDelay, timeout, tokenEnv }) {
  const uploadArgs = [
    "--build-dir",
    buildDir,
    "--manifest",
    manifestPath,
    "--endpoint",
    endpoint,
    ...(tokenEnv === undefined ? [] : ["--token-env", tokenEnv]),
    ...(dryRun === true ? ["--dry-run"] : []),
    ...(allowHostedUpload ? ["--allow-hosted"] : [])
  ];
  /** @type {ReadonlyArray<readonly [string, string | undefined]>} */
  const scalarOptions = [["--max-retries", maxRetries], ["--retry-delay", retryDelay], ["--timeout", timeout]];
  for (const [flag, value] of scalarOptions) {
    if (value !== undefined) {
      uploadArgs.push(flag, value);
    }
  }
  return uploadArgs;
}

/**
 * @param {unknown} [options]
 * @returns {PreparedReleaseArtifacts & { uploadReport: unknown }}
 */
function uploadLogBrewReactNativeReleaseArtifacts(options = {}) {
  const settings = readUploadSettings(options);
  const prepared = prepareLogBrewReactNativeReleaseArtifacts(options);
  const { report: uploadReport } = runReleaseArtifactCli("upload-js", uploadArguments(prepared, settings));
  return {
    ...prepared,
    uploadReport
  };
}

module.exports = {
  prepareLogBrewReactNativeReleaseArtifacts,
  uploadLogBrewReactNativeReleaseArtifacts,

  default: prepareLogBrewReactNativeReleaseArtifacts
};
