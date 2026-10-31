"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {{ readonly build?: unknown, readonly esbuild?: unknown, readonly root?: unknown }} ViteUserConfig
 * @typedef {{
 *   build?: { rolldownOptions?: { output: { keepNames: true } }, sourcemap?: "hidden" },
 *   esbuild?: { keepNames: true }
 * }} ViteConfigChanges
 */

const ROLLDOWN_VITE_MAJOR = 8;
const UNKNOWN_VITE_MAJOR = 0;
const DECIMAL = 10;

/**
 * @param {unknown} manifest
 * @returns {unknown}
 */
function packageVersion(manifest) {
  return typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "version") : undefined;
}

/**
 * @param {unknown} root
 * @returns {string | undefined}
 */
function lookupRoot(root) {
  const hasRoot = Boolean(root);
  if (!hasRoot) {
    return process.cwd();
  }
  return typeof root === "string" ? path.resolve(root) : undefined;
}

/**
 * @param {unknown} root
 * @returns {number}
 */
function viteMajorVersion(root) {
  const lookup = lookupRoot(root);
  if (lookup === undefined) {
    return UNKNOWN_VITE_MAJOR;
  }
  try {
    const manifestPath = require.resolve("vite/package.json", { paths: [lookup] });
    /** @type {unknown} */
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const major = Number.parseInt(String(packageVersion(manifest)), DECIMAL);
    return Number.isNaN(major) ? UNKNOWN_VITE_MAJOR : major;
  } catch {
    return UNKNOWN_VITE_MAJOR;
  }
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} build
 * @param {number} viteMajor
 * @returns {boolean}
 */
function needsRolldownKeepNames(build, viteMajor) {
  const output = field(field(build, "rolldownOptions"), "output");
  return viteMajor >= ROLLDOWN_VITE_MAJOR && !Array.isArray(output) && field(output, "keepNames") === undefined;
}

/**
 * @param {unknown} esbuild
 * @param {number} viteMajor
 * @returns {boolean}
 */
function needsEsbuildKeepNames(esbuild, viteMajor) {
  return viteMajor < ROLLDOWN_VITE_MAJOR && esbuild !== false && field(esbuild, "keepNames") === undefined;
}

/**
 * @param {boolean} sourceMap
 * @param {boolean} modernNames
 * @returns {ViteConfigChanges}
 */
function buildChanges(sourceMap, modernNames) {
  if (!sourceMap && !modernNames) {
    return {};
  }
  return {
    build: {
      ...(sourceMap ? { sourcemap: "hidden" } : {}),
      ...(modernNames ? { rolldownOptions: { output: { keepNames: true } } } : {})
    }
  };
}

/**
 * @param {ViteUserConfig} config
 * @param {boolean} enableSourceMaps
 * @returns {ViteConfigChanges | null}
 */
function viteConfigChanges(config, enableSourceMaps) {
  const sourceMap = enableSourceMaps && field(config.build, "sourcemap") === undefined;
  const keepNames = field(config.build, "minify") === undefined;
  const viteMajor = viteMajorVersion(config.root);
  const modernNames = keepNames && needsRolldownKeepNames(config.build, viteMajor);
  const legacyNames = keepNames && needsEsbuildKeepNames(config.esbuild, viteMajor);
  if (!sourceMap && !modernNames && !legacyNames) {
    return null;
  }
  return { ...buildChanges(sourceMap, modernNames), ...(legacyNames ? { esbuild: { keepNames: true } } : {}) };
}

module.exports = { viteConfigChanges };
