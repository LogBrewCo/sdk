"use strict";

const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const {
  createReleaseArtifactUploadArgs,
  formatReleaseArtifactUploadSummary,
  normalizeReleaseArtifactProjectId,
  normalizeReleaseArtifactUploadOptions,
  runReleaseArtifactCli
} = require("./release-artifacts-build.cjs");
const { viteConfigChanges } = require("./vite-release-artifacts-config.cjs");

/**
 * @import { ReleaseArtifactUploadOptions } from "./release-artifacts-build.cjs"
 * @import { ViteConfigChanges, ViteUserConfig } from "./vite-release-artifacts-config.cjs"
 * @typedef {{ readonly info: (message: string) => void }} ViteLogger
 * @typedef {{
 *   readonly build?: { readonly outDir?: string | null } | null,
 *   readonly logger?: ViteLogger | null,
 *   readonly root?: string | null
 * }} ViteResolvedConfig
 * @typedef {{
 *   readonly commitSha: string | undefined,
 *   readonly enableSourceMaps: boolean,
 *   readonly environment: string,
 *   readonly explicitBuildDir: string | undefined,
 *   readonly explicitManifestPath: string | undefined,
 *   readonly minifiedPathPrefix: string,
 *   readonly projectId: string | undefined,
 *   readonly release: string,
 *   readonly repositoryUrl: string | undefined,
 *   readonly service: string,
 *   readonly stripSourcesContent: boolean,
 *   readonly upload: ReleaseArtifactUploadOptions | undefined,
 *   readonly userSourcePrefixes: readonly string[]
 * }} PluginSettings
 * @typedef {{ readonly logger: ViteLogger | undefined, readonly outDir: string, readonly root: string }} ViteBuildContext
 */

const PACKAGE_DIR = path.dirname(require.resolve("./package.json"));
const CLI_PATH = path.join(PACKAGE_DIR, "release-artifacts.js");
const DEFAULT_MANIFEST_NAME = "logbrew-release-artifacts.json";
const DEFAULT_OUT_DIR = "dist";
const NO_PREFIXES = 0;

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
  return (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} options
 * @param {string} name
 * @returns {string}
 */
function requiredString(options, name) {
  const value = field(options, name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew Vite release-artifact plugin requires ${name}`);
  }
  return value.trim();
}

/**
 * @param {unknown} options
 * @param {string} name
 * @returns {string | undefined}
 */
function optionalString(options, name) {
  const value = field(options, name);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`LogBrew Vite release-artifact plugin option ${name} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string[]}
 */
function normalizeStringArray(value, name) {
  if (value === undefined || value === null) {
    return [];
  }
  /** @type {readonly unknown[]} */
  const items = Array.isArray(value) ? value : [value];
  const valid = Array.isArray(value) && items.every((item) => typeof item === "string" && item.trim() !== "");
  if (!valid) {
    throw new Error(`LogBrew Vite release-artifact plugin option ${name} must be an array of non-empty strings`);
  }
  return items.map((item) => String(item).trim());
}

/**
 * @param {string} root
 * @param {string} value
 * @returns {string}
 */
function resolvePathFromRoot(root, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

/**
 * @param {unknown} options
 * @returns {Pick<PluginSettings, "environment" | "minifiedPathPrefix" | "projectId" | "release" | "service">}
 */
function releaseIdentity(options) {
  const release = requiredString(options, "release");
  const environment = requiredString(options, "environment");
  const service = requiredString(options, "service");
  const projectId = normalizeReleaseArtifactProjectId(field(options, "projectId"), "Vite");
  const minifiedPathPrefix = requiredString(options, "minifiedPathPrefix");
  return { environment, minifiedPathPrefix, projectId, release, service };
}

/**
 * @param {unknown} options
 * @returns {PluginSettings}
 */
function pluginSettings(options) {
  const identity = releaseIdentity(options);
  const repositoryUrl = optionalString(options, "repositoryUrl");
  const commitSha = optionalString(options, "commitSha");
  const explicitBuildDir = optionalString(options, "buildDir");
  const explicitManifestPath = optionalString(options, "manifestPath");
  const stripSourcesContent = field(options, "stripSourcesContent") !== false;
  const enableSourceMaps = field(options, "enableSourceMaps") !== false;
  const userSourcePrefixes = normalizeStringArray(field(options, "stripSourcePrefix"), "stripSourcePrefix");
  return {
    ...identity,
    commitSha,
    enableSourceMaps,
    explicitBuildDir,
    explicitManifestPath,
    repositoryUrl,
    stripSourcesContent,
    upload: normalizeReleaseArtifactUploadOptions(field(options, "upload"), { integration: "Vite", projectId: identity.projectId }),
    userSourcePrefixes
  };
}

/**
 * @param {PluginSettings} settings
 * @param {string} buildDir
 * @param {string} root
 * @returns {string[]}
 */
function prepareArgs({ stripSourcesContent, userSourcePrefixes }, buildDir, root) {
  const sourcePrefixes = userSourcePrefixes.length > NO_PREFIXES ? userSourcePrefixes : [root];
  return [
    "--build-dir",
    buildDir,
    "--write",
    ...(stripSourcesContent ? ["--strip-sources-content"] : []),
    ...sourcePrefixes.flatMap((prefix) => ["--strip-source-prefix", prefix])
  ];
}

/**
 * @param {PluginSettings} settings
 * @param {string} buildDir
 * @returns {string[]}
 */
function manifestArgs({ commitSha, environment, minifiedPathPrefix, projectId, release, repositoryUrl, service }, buildDir) {
  return [
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
    ...(repositoryUrl === undefined ? [] : ["--repository-url", repositoryUrl]),
    ...(commitSha === undefined ? [] : ["--commit-sha", commitSha]),
    ...(projectId === undefined ? [] : ["--project-id", projectId])
  ];
}

/**
 * @param {PluginSettings} settings
 * @param {ViteBuildContext} context
 * @returns {Promise<void>}
 */
async function writeReleaseArtifacts(settings, { logger, outDir, root }) {
  const buildDir = resolvePathFromRoot(root, settings.explicitBuildDir ?? outDir);
  const manifestPath = settings.explicitManifestPath === undefined
    ? path.join(buildDir, DEFAULT_MANIFEST_NAME)
    : resolvePathFromRoot(root, settings.explicitManifestPath);
  runReleaseArtifactCli(CLI_PATH, "prepare-js", prepareArgs(settings, buildDir, root));
  const { stdout } = runReleaseArtifactCli(CLI_PATH, "manifest-js", manifestArgs(settings, buildDir));
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, stdout, "utf8");
  if (settings.upload !== undefined) {
    const { report } = runReleaseArtifactCli(
      CLI_PATH,
      "upload-js",
      createReleaseArtifactUploadArgs(buildDir, manifestPath, settings.upload)
    );
    logger?.info(formatReleaseArtifactUploadSummary(report));
  }
}

/**
 * @param {ViteResolvedConfig | null | undefined} config
 * @returns {ViteBuildContext}
 */
function resolvedContext(config) {
  const root = config?.root;
  const outDir = config?.build?.outDir;
  const logger = config?.logger;
  return {
    logger: typeof logger?.info === "function" ? logger : undefined,
    outDir: outDir === undefined || outDir === null || outDir === "" ? DEFAULT_OUT_DIR : outDir,
    root: root === undefined || root === null || root === "" ? process.cwd() : path.resolve(root)
  };
}

/**
 * @param {unknown} options
 * @returns {{
 *   readonly apply: "build",
 *   readonly config: (config?: ViteUserConfig) => ViteConfigChanges | null,
 *   readonly configResolved: (config: ViteResolvedConfig | null | undefined) => void,
 *   readonly enforce: "post",
 *   readonly name: "logbrew-vite-release-artifacts",
 *   readonly writeBundle: () => Promise<void>
 * }}
 */
function createLogBrewViteReleaseArtifactsPlugin(options) {
  const settings = pluginSettings(options);
  /** @type {ViteBuildContext} */
  let context = { logger: undefined, outDir: DEFAULT_OUT_DIR, root: process.cwd() };
  return {
    name: "logbrew-vite-release-artifacts",

    apply: "build",

    enforce: "post",

    config(config = {}) {
      return viteConfigChanges(config, settings.enableSourceMaps);
    },
    configResolved(config) {
      context = resolvedContext(config);
    },
    async writeBundle() {
      await writeReleaseArtifacts(settings, context);
    }
  };
}

module.exports = {
  createLogBrewViteReleaseArtifactsPlugin,
  default: createLogBrewViteReleaseArtifactsPlugin
};
