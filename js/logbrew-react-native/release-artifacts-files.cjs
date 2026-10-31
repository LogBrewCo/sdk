"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HERMES_MAGIC = Buffer.from("c61fbc03c103191f", "hex");
const HERMES_RUNTIME_DEBUG_ID_RE =
  /\/\*logbrew-runtime-debug-id\*\/\/\/# debugId=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;
const SOURCE_MAPPING_COMMENT_RE = /(?:\/\/#|\/\*#)\s*sourceMappingURL=[^\r\n]*/giu;
const TRAILING_WHITESPACE_RE = /[ \t\r\n]*$/u;
const START = 0;

/**
 * @param {string} root
 * @param {string} value
 * @returns {string}
 */
function resolvePathFromRoot(root, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

/**
 * @param {string} label
 * @param {string} filePath
 * @returns {void}
 */
function requireExistingFile(label, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`LogBrew React Native release-artifact helper ${label} does not exist: ${filePath}`);
  }
}

/**
 * @param {string} label
 * @param {string} filePath
 * @param {string} buildDir
 * @returns {string}
 */
function ensureInsideBuildDir(label, filePath, buildDir) {
  const relative = path.relative(buildDir, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`LogBrew React Native release-artifact helper ${label} must stay inside buildDir`);
  }
  return relative.split(path.sep).join("/");
}

/**
 * @param {string} source
 * @param {string} reference
 * @returns {string}
 */
function sourceWithSourceMappingUrl(source, reference) {
  const sourceWithoutMapComments = source.replaceAll(SOURCE_MAPPING_COMMENT_RE, "").replace(TRAILING_WHITESPACE_RE, "");
  return `${sourceWithoutMapComments}${sourceWithoutMapComments === "" ? "" : "\n"}//# sourceMappingURL=${reference}\n`;
}

/**
 * @param {Buffer} bundle
 * @param {string} bundlePath
 * @param {string} sourcemapPath
 * @returns {boolean}
 */
function isHermesBytecode(bundle, bundlePath, sourcemapPath) {
  if (!bundle.subarray(START, HERMES_MAGIC.length).equals(HERMES_MAGIC)) {
    return false;
  }
  if (!HERMES_RUNTIME_DEBUG_ID_RE.test(bundle.toString("latin1"))) {
    throw new Error("LogBrew React Native Hermes bytecode requires the LogBrew Metro wrapper");
  }
  if (sourcemapPath !== `${bundlePath}.map`) {
    throw new Error("LogBrew React Native Hermes source map must use the bundle's sibling .map path");
  }
  return true;
}

/**
 * @param {string} bundlePath
 * @param {string} sourcemapPath
 * @returns {void}
 */
function applyExplicitSourceMapReference(bundlePath, sourcemapPath) {
  const bundle = fs.readFileSync(bundlePath);
  if (isHermesBytecode(bundle, bundlePath, sourcemapPath)) {
    return;
  }
  const reference = path.relative(path.dirname(bundlePath), sourcemapPath).split(path.sep).join("/");
  const source = bundle.toString("utf8");
  const updated = sourceWithSourceMappingUrl(source, reference);
  if (updated !== source) {
    fs.writeFileSync(bundlePath, updated, "utf8");
  }
}

module.exports = { applyExplicitSourceMapReference, ensureInsideBuildDir, requireExistingFile, resolvePathFromRoot };
