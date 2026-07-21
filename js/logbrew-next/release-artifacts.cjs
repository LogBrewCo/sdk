"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_DIR = path.dirname(require.resolve("./package.json"));
const DEFAULT_MANIFEST_NAME = "logbrew-release-artifacts.json";
const DEFAULT_MINIFIED_PATH_PREFIX = "app:///_next/static/chunks";

function requiredString(options, name) {
  const value = options?.[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew Next release-artifact helper requires ${name}`);
  }
  return value.trim();
}

function optionalString(options, name) {
  const value = options?.[name];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew Next release-artifact helper option ${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeStringArray(value, name) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`LogBrew Next release-artifact helper option ${name} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function resolveLogBrewSdkFile(fileName) {
  try {
    const sdkEntry = require.resolve("@logbrew/sdk", { paths: [PACKAGE_DIR, process.cwd()] });
    return path.join(path.dirname(sdkEntry), fileName);
  } catch {
    const sourceTreeFile = path.resolve(PACKAGE_DIR, `../logbrew-js/${fileName}`);
    if (fs.existsSync(sourceTreeFile)) {
      return sourceTreeFile;
    }
    throw new Error("LogBrew Next release-artifact helper requires @logbrew/sdk to be installed");
  }
}

function resolvePathFromRoot(root, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function resolveBuildDir(root, distDir, explicitBuildDir) {
  if (explicitBuildDir) {
    return resolvePathFromRoot(root, explicitBuildDir);
  }
  return path.join(resolvePathFromRoot(root, distDir || ".next"), "static", "chunks");
}

function resolveManifestPath(root, distDir, explicitManifestPath) {
  if (explicitManifestPath) {
    return resolvePathFromRoot(root, explicitManifestPath);
  }
  return path.join(resolvePathFromRoot(root, distDir || ".next"), DEFAULT_MANIFEST_NAME);
}

function materializeConfig(nextConfig, args) {
  if (typeof nextConfig === "function") {
    const result = nextConfig(...args);
    if (result && typeof result.then === "function") {
      return result.then((resolvedConfig) => resolvedConfig || {});
    }
    return result || {};
  }
  return nextConfig || {};
}

function patchNextConfig(config, options) {
  const {
    createReleaseArtifactUploadArgs,
    formatReleaseArtifactUploadSummary,
    normalizeReleaseArtifactProjectId,
    normalizeReleaseArtifactUploadOptions,
    runReleaseArtifactCli,
  } = require(resolveLogBrewSdkFile("release-artifacts-build.cjs"));
  const releaseArtifactsCli = resolveLogBrewSdkFile("release-artifacts.js");
  const release = requiredString(options, "release");
  const environment = requiredString(options, "environment");
  const service = requiredString(options, "service");
  const projectId = normalizeReleaseArtifactProjectId(options?.projectId, "Next");
  const minifiedPathPrefix = optionalString(options, "minifiedPathPrefix") || DEFAULT_MINIFIED_PATH_PREFIX;
  const repositoryUrl = optionalString(options, "repositoryUrl");
  const commitSha = optionalString(options, "commitSha");
  const explicitBuildDir = optionalString(options, "buildDir");
  const explicitManifestPath = optionalString(options, "manifestPath");
  const stripSourcesContent = options?.stripSourcesContent !== false;
  const enableSourceMaps = options?.enableSourceMaps !== false;
  const userSourcePrefixes = normalizeStringArray(options?.stripSourcePrefix, "stripSourcePrefix");
  const upload = normalizeReleaseArtifactUploadOptions(options?.upload, { integration: "Next", projectId });
  const root = path.resolve(optionalString(options, "root") || process.cwd());
  const distDir = config.distDir || ".next";
  const compiler = { ...(config.compiler || {}) };
  const existingHook = compiler.runAfterProductionCompile;

  const patchedConfig = {
    ...config,
    compiler,
  };
  if (enableSourceMaps && patchedConfig.productionBrowserSourceMaps === undefined) {
    patchedConfig.productionBrowserSourceMaps = true;
  }

  if (existingHook !== undefined && typeof existingHook !== "function") {
    if (upload) {
      throw new Error(
        "LogBrew Next release-artifact runAfterProductionCompile must be a function when upload is enabled",
      );
    }
    return patchedConfig;
  }

  compiler.runAfterProductionCompile = async function logBrewRunAfterProductionCompile(context = {}) {
    if (typeof existingHook === "function") {
      await existingHook.apply(this, arguments);
    }

    const hookDistDir = context.distDir || distDir;
    const buildDir = resolveBuildDir(root, hookDistDir, explicitBuildDir);
    const manifestPath = resolveManifestPath(root, hookDistDir, explicitManifestPath);
    const sourcePrefixes = userSourcePrefixes.length > 0 ? userSourcePrefixes : [root];
    const prepareArgs = ["--build-dir", buildDir, "--write"];
    if (stripSourcesContent) {
      prepareArgs.push("--strip-sources-content");
    }
    for (const prefix of sourcePrefixes) {
      prepareArgs.push("--strip-source-prefix", prefix);
    }

    runReleaseArtifactCli(releaseArtifactsCli, "prepare-js", prepareArgs);

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
    if (projectId) {
      manifestArgs.push("--project-id", projectId);
    }

    const { stdout } = runReleaseArtifactCli(releaseArtifactsCli, "manifest-js", manifestArgs);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, stdout, "utf8");
    if (upload) {
      const { report } = runReleaseArtifactCli(
        releaseArtifactsCli,
        "upload-js",
        createReleaseArtifactUploadArgs(buildDir, manifestPath, upload),
      );
      console.info(formatReleaseArtifactUploadSummary(report));
    }
  };

  return patchedConfig;
}

function withLogBrewNextReleaseArtifacts(nextConfig = {}, options = {}) {
  if (typeof nextConfig === "function") {
    return function logBrewNextConfigWithReleaseArtifacts() {
      const args = Array.from(arguments);
      const materialized = materializeConfig(nextConfig, args);
      if (materialized && typeof materialized.then === "function") {
        return materialized.then((config) => patchNextConfig(config, options));
      }
      return patchNextConfig(materialized, options);
    };
  }
  return patchNextConfig(nextConfig, options);
}

module.exports = {
  withLogBrewNextReleaseArtifacts,
  default: withLogBrewNextReleaseArtifacts,
};
