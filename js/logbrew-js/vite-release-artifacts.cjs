"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  createReleaseArtifactUploadArgs,
  formatReleaseArtifactUploadSummary,
  normalizeReleaseArtifactProjectId,
  normalizeReleaseArtifactUploadOptions,
  runReleaseArtifactCli,
} = require("./release-artifacts-build.cjs");

const PACKAGE_DIR = path.dirname(require.resolve("./package.json"));
const CLI_PATH = path.join(PACKAGE_DIR, "release-artifacts.js");
const DEFAULT_MANIFEST_NAME = "logbrew-release-artifacts.json";

function requiredString(options, name) {
  const value = options?.[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew Vite release-artifact plugin requires ${name}`);
  }
  return value.trim();
}

function optionalString(options, name) {
  const value = options?.[name];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew Vite release-artifact plugin option ${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeStringArray(value, name) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`LogBrew Vite release-artifact plugin option ${name} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function resolvePathFromRoot(root, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function resolveBuildDir(root, outDir, explicitBuildDir) {
  if (explicitBuildDir) {
    return resolvePathFromRoot(root, explicitBuildDir);
  }
  return resolvePathFromRoot(root, outDir || "dist");
}

function resolveManifestPath(root, buildDir, explicitManifestPath) {
  if (explicitManifestPath) {
    return resolvePathFromRoot(root, explicitManifestPath);
  }
  return path.join(buildDir, DEFAULT_MANIFEST_NAME);
}

function createLogBrewViteReleaseArtifactsPlugin(options) {
  const release = requiredString(options, "release");
  const environment = requiredString(options, "environment");
  const service = requiredString(options, "service");
  const projectId = normalizeReleaseArtifactProjectId(options?.projectId, "Vite");
  const minifiedPathPrefix = requiredString(options, "minifiedPathPrefix");
  const repositoryUrl = optionalString(options, "repositoryUrl");
  const commitSha = optionalString(options, "commitSha");
  const explicitBuildDir = optionalString(options, "buildDir");
  const explicitManifestPath = optionalString(options, "manifestPath");
  const stripSourcesContent = options?.stripSourcesContent !== false;
  const enableSourceMaps = options?.enableSourceMaps !== false;
  const userSourcePrefixes = normalizeStringArray(options?.stripSourcePrefix, "stripSourcePrefix");
  const upload = normalizeReleaseArtifactUploadOptions(options?.upload, { integration: "Vite", projectId });
  let viteRoot = process.cwd();
  let viteOutDir = "dist";
  let viteLogger = null;

  return {
    name: "logbrew-vite-release-artifacts",
    apply: "build",
    enforce: "post",
    config(config = {}) {
      if (!enableSourceMaps || config.build?.sourcemap !== undefined) {
        return null;
      }
      return { build: { sourcemap: "hidden" } };
    },
    configResolved(config) {
      viteRoot = config?.root ? path.resolve(config.root) : process.cwd();
      viteOutDir = config?.build?.outDir || "dist";
      viteLogger = config?.logger && typeof config.logger.info === "function" ? config.logger : null;
    },
    async closeBundle() {
      const buildDir = resolveBuildDir(viteRoot, viteOutDir, explicitBuildDir);
      const manifestPath = resolveManifestPath(viteRoot, buildDir, explicitManifestPath);
      const sourcePrefixes = userSourcePrefixes.length > 0 ? userSourcePrefixes : [viteRoot];
      const prepareArgs = ["--build-dir", buildDir, "--write"];
      if (stripSourcesContent) {
        prepareArgs.push("--strip-sources-content");
      }
      for (const prefix of sourcePrefixes) {
        prepareArgs.push("--strip-source-prefix", prefix);
      }

      runReleaseArtifactCli(CLI_PATH, "prepare-js", prepareArgs);

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
      if (repositoryUrl) {
        manifestArgs.push("--repository-url", repositoryUrl);
      }
      if (commitSha) {
        manifestArgs.push("--commit-sha", commitSha);
      }
      if (projectId) {
        manifestArgs.push("--project-id", projectId);
      }

      const { stdout } = runReleaseArtifactCli(CLI_PATH, "manifest-js", manifestArgs);
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, stdout, "utf8");
      if (upload) {
        const { report } = runReleaseArtifactCli(
          CLI_PATH,
          "upload-js",
          createReleaseArtifactUploadArgs(buildDir, manifestPath, upload)
        );
        viteLogger?.info(formatReleaseArtifactUploadSummary(report));
      }
    }
  };
}

module.exports = {
  createLogBrewViteReleaseArtifactsPlugin,
  default: createLogBrewViteReleaseArtifactsPlugin
};
