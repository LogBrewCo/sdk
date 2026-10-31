import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";

/**
 * @typedef {{ readonly status: number | null, readonly stderr: string, readonly stdout: string }} CliResult
 * @typedef {{ readonly appRoot: string, readonly buildDir: string, readonly root: string }} Build
 * @typedef {{ readonly manifest: unknown, readonly manifestPath: string, readonly result: CliResult }} WrittenManifest
 */

const CLI_PATH = fileURLToPath(new URL("../release-artifacts.js", import.meta.url));
const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000";
const CDN_PREFIX = "https://cdn.example/assets";
const HOSTED_ENDPOINT = "https://api.logbrew.co/api/release-artifacts";
const SOURCE_TEXT = "export function checkout() { return 'source-fixture-marker'; }\n";
const MINIFIED_TEXT = "function checkout(){throw new Error('source-fixture-marker')}checkout();\n//# sourceMappingURL=app.js.map\n";
const MANIFEST_IDENTITY = ["--release", "web@1.2.3", "--environment", "production", "--service", "checkout-web"];
const EXIT_OK = 0;
const EXIT_BLOCKED = 1;
const EXIT_USAGE = 2;
const EXIT_VALIDATION_FAILED = 4;

/**
 * @param {string} sourcePath
 * @returns {Readonly<Record<string, unknown>>}
 */
function sourceMapFor(sourcePath) {
  return {
    file: "app.js",
    mappings: "AAAA",
    names: ["checkout"],
    sources: [sourcePath],
    sourcesContent: [SOURCE_TEXT],
    version: 3
  };
}

/**
 * @returns {Promise<Build>}
 */
async function makeBuild() {
  const root = await mkdtemp(path.join(os.tmpdir(), "logbrew-release-artifacts-"));
  const appRoot = path.join(root, "app");
  const assets = path.join(appRoot, "dist", "assets");
  const sourcePath = path.join(appRoot, "src", "main.js");
  await mkdir(assets, { recursive: true });
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, SOURCE_TEXT, "utf8");
  await writeFile(path.join(assets, "app.js"), MINIFIED_TEXT, "utf8");
  await writeFile(path.join(assets, "app.js.map"), `${JSON.stringify(sourceMapFor(sourcePath))}\n`, "utf8");
  return { appRoot, buildDir: path.join(appRoot, "dist"), root };
}

/**
 * @param {(build: Build) => Promise<void>} run
 * @returns {Promise<void>}
 */
async function withBuild(run) {
  const build = await makeBuild();
  try {
    await run(build);
  } finally {
    await rm(build.root, { force: true, recursive: true });
  }
}

/**
 * @param {Build} build
 * @returns {string}
 */
function jsPath(build) {
  return path.join(build.buildDir, "assets", "app.js");
}

/**
 * @param {Build} build
 * @returns {string}
 */
function mapPath(build) {
  return path.join(build.buildDir, "assets", "app.js.map");
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readText(filePath) {
  return readFile(filePath, "utf8");
}

/**
 * @param {string} value
 * @returns {unknown}
 */
function parseJson(value) {
  /** @type {unknown} */
  const parsed = JSON.parse(value);
  return parsed;
}

/**
 * @param {string} filePath
 * @returns {Promise<unknown>}
 */
async function readJson(filePath) {
  return parseJson(await readText(filePath));
}

/**
 * @param {unknown} value
 * @param {string} keyPath
 * @returns {unknown}
 */
function pick(value, keyPath) {
  let current = value;
  for (const key of keyPath.split(".")) {
    current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  }
  return current;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function strings(value) {
  assert.ok(Array.isArray(value), "expected an array");
  /** @type {readonly unknown[]} */
  const items = value;
  const texts = items.filter((item) => typeof item === "string");
  assert.equal(texts.length, items.length, "expected an array of strings");
  return texts;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function joinedErrors(value) {
  return strings(pick(value, "validation.errors")).join("\n");
}

/**
 * @param {string} output
 * @param {readonly string[]} needles
 * @returns {void}
 */
function assertExcludes(output, needles) {
  for (const needle of needles) {
    assert.equal(output.includes(needle), false, `output must not include ${needle}`);
  }
}

/**
 * @param {readonly string[]} args
 * @returns {Promise<CliResult>}
 */
async function runCli(args) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const [stdout, stderr] = await Promise.all([text(child.stdout), text(child.stderr)]);
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "close");
  }
  return { status: child.exitCode, stderr, stdout };
}

/**
 * @param {CliResult} result
 * @returns {unknown}
 */
function succeeded(result) {
  assert.equal(result.status, EXIT_OK, result.stderr);
  return parseJson(result.stdout);
}

/**
 * @param {Build} build
 * @param {boolean} stripPrefix
 * @returns {readonly string[]}
 */
function prepareArgs(build, stripPrefix) {
  return [
    "prepare-js",
    "--build-dir",
    build.buildDir,
    "--strip-sources-content",
    ...(stripPrefix ? ["--strip-source-prefix", build.appRoot] : []),
    "--write"
  ];
}

/**
 * @param {Build} build
 * @param {boolean} stripPrefix
 * @returns {Promise<void>}
 */
async function prepareBuild(build, stripPrefix) {
  succeeded(await runCli(prepareArgs(build, stripPrefix)));
}

/**
 * @param {Build} build
 * @param {readonly string[]} extraArgs
 * @returns {readonly string[]}
 */
function manifestArgs(build, extraArgs) {
  return ["manifest-js", "--build-dir", build.buildDir, ...extraArgs, ...MANIFEST_IDENTITY];
}

/**
 * @param {Build} build
 * @param {readonly string[]} extraArgs
 * @returns {Promise<WrittenManifest>}
 */
async function writeManifest(build, extraArgs) {
  const hasPrefix = extraArgs.includes("--minified-path-prefix");
  const result = await runCli(manifestArgs(build, hasPrefix ? extraArgs : [...extraArgs, "--minified-path-prefix", CDN_PREFIX]));
  const manifest = succeeded(result);
  const manifestPath = path.join(build.root, "manifest.json");
  await writeFile(manifestPath, result.stdout, "utf8");
  return { manifest, manifestPath, result };
}

/**
 * @param {Build} build
 * @param {string} command
 * @param {readonly string[]} extraArgs
 * @returns {Promise<CliResult>}
 */
async function runWithManifest(build, command, extraArgs) {
  const { manifestPath } = await writeManifest(build, []);
  return runCli([command, "--build-dir", build.buildDir, "--manifest", manifestPath, ...extraArgs]);
}

export {
  CDN_PREFIX,
  EXIT_BLOCKED,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_VALIDATION_FAILED,
  HOSTED_ENDPOINT,
  PROJECT_ID,
  assertExcludes,
  jsPath,
  joinedErrors,
  makeBuild,
  manifestArgs,
  mapPath,
  parseJson,
  pick,
  prepareArgs,
  prepareBuild,
  readJson,
  readText,
  runCli,
  runWithManifest,
  strings,
  succeeded,
  withBuild,
  writeManifest
};
