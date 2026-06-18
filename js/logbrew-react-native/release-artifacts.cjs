"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_DIR = path.dirname(require.resolve("./package.json"));
const DEFAULT_MANIFEST_NAME = "logbrew-release-artifacts.json";
const SUPPORTED_PLATFORMS = new Set(["android", "ios"]);
const SOURCE_MAPPING_COMMENT_RE = /(?:\/\/#|\/\*#)\s*sourceMappingURL=[^\r\n]*/giu;

function requiredString(options, name) {
  const value = options?.[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew React Native release-artifact helper requires ${name}`);
  }
  return value.trim();
}

function optionalString(options, name) {
  const value = options?.[name];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew React Native release-artifact helper option ${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeStringArray(value, name) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`LogBrew React Native release-artifact helper option ${name} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function normalizePlatform(options) {
  const platform = requiredString(options, "platform").toLowerCase();
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error("LogBrew React Native release-artifact helper option platform must be android or ios");
  }
  return platform;
}

function parseJson(stdout, command) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`LogBrew release-artifact ${command} did not return JSON`, { cause: error });
  }
}

function validationErrors(report) {
  if (report?.validation && Array.isArray(report.validation.errors)) {
    return report.validation.errors.filter((message) => typeof message === "string" && message.trim() !== "");
  }
  return [];
}

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

function runReleaseArtifactCli(command, args) {
  const result = spawnSync(process.execPath, [resolveLogBrewReleaseArtifactsCli(), command, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  const report = result.stdout ? parseJson(result.stdout, command) : null;
  if (result.status !== 0) {
    const details = validationErrors(report).join("; ") || result.stderr.trim() || `exit code ${result.status}`;
    throw new Error(`LogBrew release-artifact ${command} failed: ${details}`);
  }
  return { report, stdout: result.stdout };
}

function resolvePathFromRoot(root, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function requireExistingFile(label, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`LogBrew React Native release-artifact helper ${label} does not exist: ${filePath}`);
  }
}

function ensureInsideBuildDir(label, filePath, buildDir) {
  const relative = path.relative(buildDir, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`LogBrew React Native release-artifact helper ${label} must stay inside buildDir`);
  }
  return relative.split(path.sep).join("/");
}

function artifactForBundle(report, relativeBundlePath) {
  return report?.artifacts?.find((artifact) => artifact?.path === relativeBundlePath) || null;
}

function sourceMapReferenceForBundle(bundlePath, sourcemapPath) {
  return path.relative(path.dirname(bundlePath), sourcemapPath).split(path.sep).join("/");
}

function sourceWithSourceMappingUrl(source, reference) {
  const comment = `//# sourceMappingURL=${reference}`;
  const sourceWithoutMapComments = source.replace(SOURCE_MAPPING_COMMENT_RE, "").replace(/[ \t\r\n]*$/u, "");
  return `${sourceWithoutMapComments}${sourceWithoutMapComments === "" ? "" : "\n"}${comment}\n`;
}

function applyExplicitSourceMapReference(bundlePath, sourcemapPath) {
  const reference = sourceMapReferenceForBundle(bundlePath, sourcemapPath);
  const source = fs.readFileSync(bundlePath, "utf8");
  const updated = sourceWithSourceMappingUrl(source, reference);
  if (updated !== source) {
    fs.writeFileSync(bundlePath, updated, "utf8");
  }
}

function defaultMinifiedPathPrefix(platform) {
  return `app:///react-native/${platform}`;
}

function prepareLogBrewReactNativeReleaseArtifacts(options = {}) {
  const release = requiredString(options, "release");
  const environment = requiredString(options, "environment");
  const service = requiredString(options, "service");
  const platform = normalizePlatform(options);
  const root = path.resolve(optionalString(options, "root") || process.cwd());
  const bundlePath = resolvePathFromRoot(root, requiredString(options, "bundle"));
  const sourcemapOption = optionalString(options, "sourcemap");
  const sourcemapPath = sourcemapOption ? resolvePathFromRoot(root, sourcemapOption) : `${bundlePath}.map`;
  const buildDirOption = optionalString(options, "buildDir");
  const buildDir = buildDirOption ? resolvePathFromRoot(root, buildDirOption) : path.dirname(bundlePath);
  const manifestPath = resolvePathFromRoot(
    root,
    optionalString(options, "manifestPath") || path.join(buildDir, DEFAULT_MANIFEST_NAME),
  );
  const minifiedPathPrefix = optionalString(options, "minifiedPathPrefix") || defaultMinifiedPathPrefix(platform);
  const repositoryUrl = optionalString(options, "repositoryUrl");
  const commitSha = optionalString(options, "commitSha");
  const stripSourcesContent = options?.stripSourcesContent !== false;
  const userSourcePrefixes = normalizeStringArray(options?.stripSourcePrefix, "stripSourcePrefix");
  const sourcePrefixes = userSourcePrefixes.length > 0 ? userSourcePrefixes : [root];

  requireExistingFile("bundle", bundlePath);
  requireExistingFile("sourcemap", sourcemapPath);
  const relativeBundlePath = ensureInsideBuildDir("bundle", bundlePath, buildDir);
  const relativeSourceMapPath = ensureInsideBuildDir("sourcemap", sourcemapPath, buildDir);
  applyExplicitSourceMapReference(bundlePath, sourcemapPath);

  const prepareArgs = ["--build-dir", buildDir, "--write"];
  if (stripSourcesContent) {
    prepareArgs.push("--strip-sources-content");
  }
  for (const prefix of sourcePrefixes) {
    prepareArgs.push("--strip-source-prefix", resolvePathFromRoot(root, prefix));
  }

  const { report: prepareReport } = runReleaseArtifactCli("prepare-js", prepareArgs);
  const preparedArtifact = artifactForBundle(prepareReport, relativeBundlePath);
  if (!preparedArtifact) {
    throw new Error(`LogBrew React Native release-artifact helper did not find bundle: ${relativeBundlePath}`);
  }
  if (preparedArtifact.sourceMapPath !== relativeSourceMapPath) {
    throw new Error(
      `LogBrew React Native release-artifact helper expected source map ${relativeSourceMapPath} for ${relativeBundlePath}`,
    );
  }

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
    minifiedPathPrefix,
  ];
  if (repositoryUrl) {
    manifestArgs.push("--repository-url", repositoryUrl);
  }
  if (commitSha) {
    manifestArgs.push("--commit-sha", commitSha);
  }

  const { report: manifestReport, stdout } = runReleaseArtifactCli("manifest-js", manifestArgs);
  const manifestArtifact = manifestReport?.artifacts?.find(
    (artifact) => artifact?.minifiedSource?.path === relativeBundlePath,
  );
  if (!manifestArtifact) {
    throw new Error(`LogBrew React Native release-artifact manifest did not include bundle: ${relativeBundlePath}`);
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, stdout, "utf8");

  return {
    buildDir,
    bundlePath,
    sourcemapPath,
    manifestPath,
    platform,
    prepareReport,
    manifestReport,
  };
}

module.exports = {
  prepareLogBrewReactNativeReleaseArtifacts,
  default: prepareLogBrewReactNativeReleaseArtifacts,
};
