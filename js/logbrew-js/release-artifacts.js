#!/usr/bin/env node
import {
  errorMessage,
  normalizeProjectId,
  parseOptions,
  pathExists,
  printJson,
  readJsonObject,
  requireBuildDir,
  requireOption
} from "./release-artifacts-common.js";
import { verifyJavaScriptIssueSymbolication, verifyJavaScriptSymbolication } from "./release-artifacts-symbolication.js";
import { createDebugIdPlan } from "./release-artifacts-prepare.js";
import { createManifest } from "./release-artifacts-manifest.js";
import path from "node:path";
import { runUploadJs } from "./release-artifacts-upload.js";

/**
 * @import { CliOptions } from "./release-artifacts-common.js"
 * @import { SourceContextOptions } from "./release-artifacts-source-context.js"
 */

const SCRIPT_VERSION = "0.1.0";
const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 10;
const MIN_CONTEXT_LINES = 0;
const DECIMAL = 10;
const EXIT_OK = 0;
const EXIT_BLOCKED = 1;
const EXIT_USAGE = 2;
const ARGUMENT_OFFSET = 2;
const NON_NEGATIVE_INTEGER_RE = /^\d+$/u;
const VERIFIER = { name: "logbrew-js-release-artifact-symbolication-verifier", version: SCRIPT_VERSION };

/**
 * @returns {string}
 */
function usage() {
  return [
    "Usage:",
    "  logbrew-release-artifacts prepare-js --build-dir <dir> [--write] [--strip-sources-content] [--strip-source-prefix <path>...]",
    "  logbrew-release-artifacts manifest-js --build-dir <dir> [--project-id <uuid>] --release <id> --environment <env> --service <name> --minified-path-prefix <url-or-path> [--repository-url <url>] [--commit-sha <sha>] [--allow-sources-content]",
    "  logbrew-release-artifacts symbolicate-js --build-dir <dir> --manifest <file> (--stack-frame <frame> | --issue-event <file>) [--source-root <dir>] [--context-lines <n>]",
    "  logbrew-release-artifacts upload-js --build-dir <dir> --manifest <file> --endpoint <url> [--allow-hosted] [--token-env <env>] [--dry-run] [--max-retries <n>] [--retry-delay <seconds>] [--timeout <seconds>]",
    "",
    "This installed-package helper prepares, validates, resolves, and uploads JavaScript source-map artifacts.",
    "upload-js is loopback-only by default; pass --allow-hosted for explicit HTTPS release-artifact endpoints."
  ].join("\n");
}

/**
 * @param {CliOptions} options
 * @param {string} name
 * @returns {string | undefined}
 */
function optionalOption(options, name) {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {CliOptions} options
 * @param {string} name
 * @returns {boolean}
 */
function hasOption(options, name) {
  const value = options[name];
  return typeof value === "string" && value.trim() !== "";
}

/**
 * @param {string} value
 * @returns {number}
 */
function parseContextLines(value) {
  const trimmed = value.trim();
  if (!NON_NEGATIVE_INTEGER_RE.test(trimmed)) {
    throw new Error("--context-lines must be an integer from 0 to 10");
  }
  const contextLines = Number.parseInt(trimmed, DECIMAL);
  if (contextLines < MIN_CONTEXT_LINES || contextLines > MAX_CONTEXT_LINES) {
    throw new Error("--context-lines must be an integer from 0 to 10");
  }
  return contextLines;
}

/**
 * @param {CliOptions} options
 * @returns {SourceContextOptions | undefined}
 */
function optionalSourceContextOptions(options) {
  const hasSourceRoot = hasOption(options, "source-root");
  const contextLinesOption = optionalOption(options, "context-lines");
  const hasContextLines = hasOption(options, "context-lines");
  if (!hasSourceRoot && !hasContextLines) {
    return undefined;
  }
  if (!hasSourceRoot) {
    throw new Error("--source-root is required when --context-lines is provided");
  }
  return {
    contextLines: hasContextLines ? parseContextLines(contextLinesOption ?? "") : DEFAULT_CONTEXT_LINES,
    sourceRoot: path.resolve(requireOption(options, "source-root"))
  };
}

/**
 * @param {readonly string[]} args
 * @returns {Promise<number>}
 */
async function runPrepareJs(args) {
  const options = parseOptions(args, {
    "build-dir": "string",
    "strip-source-prefix": "repeat",
    "strip-sources-content": "boolean",
    write: "boolean"
  });
  const buildDir = await requireBuildDir(requireOption(options, "build-dir"));
  const stripSourcePrefixes = options["strip-source-prefix"];
  const plan = await createDebugIdPlan({
    buildDir,
    stripSourcePrefixes: Array.isArray(stripSourcePrefixes) ? stripSourcePrefixes : [],
    stripSourcesContent: options["strip-sources-content"] === true,
    write: options["write"] === true
  });
  printJson(plan);
  return plan.validation.status === "blocked" ? EXIT_BLOCKED : EXIT_OK;
}

/**
 * @param {readonly string[]} args
 * @returns {Promise<number>}
 */
async function runManifestJs(args) {
  const options = parseOptions(args, {
    "allow-sources-content": "boolean",
    "build-dir": "string",
    "commit-sha": "string",
    environment: "string",
    "minified-path-prefix": "string",
    "project-id": "string",
    release: "string",
    "repository-url": "string",
    service: "string"
  });
  const buildDir = await requireBuildDir(requireOption(options, "build-dir"));
  const projectId = normalizeProjectId(options["project-id"], "--project-id must be a UUID");
  const release = requireOption(options, "release");
  const environment = requireOption(options, "environment");
  const service = requireOption(options, "service");
  const minifiedPathPrefix = requireOption(options, "minified-path-prefix");
  const manifest = await createManifest({
    allowSourcesContent: options["allow-sources-content"] === true,
    buildDir,
    commitSha: optionalOption(options, "commit-sha"),
    environment,
    minifiedPathPrefix,
    projectId,
    release,
    repositoryUrl: optionalOption(options, "repository-url"),
    service
  });
  printJson(manifest);
  return manifest.validation.status === "blocked" ? EXIT_BLOCKED : EXIT_OK;
}

/**
 * @param {CliOptions} options
 * @param {string} name
 * @param {string} label
 * @returns {Promise<string>}
 */
async function requireExistingFile(options, name, label) {
  const filePath = path.resolve(requireOption(options, name));
  if (!(await pathExists(filePath))) {
    throw new Error(`${label} file does not exist: ${String(options[name])}`);
  }
  return filePath;
}

/**
 * @param {CliOptions} options
 * @returns {Promise<number>}
 */
async function symbolicateFromOptions(options) {
  const buildDir = await requireBuildDir(requireOption(options, "build-dir"));
  const manifestPath = await requireExistingFile(options, "manifest", "manifest");
  const issueEvent = hasOption(options, "issue-event");
  if (hasOption(options, "stack-frame") === issueEvent) {
    throw new Error("provide exactly one of --stack-frame or --issue-event");
  }
  const manifest = await readJsonObject(manifestPath, "manifest");
  const sourceContext = optionalSourceContextOptions(options);
  const report = issueEvent
    ? await verifyJavaScriptIssueSymbolication({
      buildDir,
      issueEvent: await readJsonObject(await requireExistingFile(options, "issue-event", "issue event"), "issue event"),
      manifest,
      sourceContext
    })
    : await verifyJavaScriptSymbolication({ buildDir, manifest, sourceContext, stackFrame: requireOption(options, "stack-frame") });
  printJson(report);
  return EXIT_OK;
}

/**
 * @param {readonly string[]} args
 * @returns {Promise<number>}
 */
async function runSymbolicateJs(args) {
  const options = parseOptions(args, {
    "build-dir": "string",
    "context-lines": "string",
    "issue-event": "string",
    manifest: "string",
    "source-root": "string",
    "stack-frame": "string"
  });
  try {
    return await symbolicateFromOptions(options);
  } catch (error) {
    printJson({ status: "validation_failed", validation: { errors: [errorMessage(error)] }, verifier: VERIFIER });
    return EXIT_BLOCKED;
  }
}

const COMMANDS = new Map([
  ["manifest-js", runManifestJs],
  ["prepare-js", runPrepareJs],
  ["symbolicate-js", runSymbolicateJs],
  ["upload-js", runUploadJs]
]);

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {Promise<number>}
 */
async function runCommand(command, args) {
  const run = COMMANDS.get(command);
  if (run === undefined) {
    throw new Error(`unknown command: ${command}`);
  }
  return run(args);
}

/**
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  const [command = "", ...args] = argv;
  if (command === "" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return command === "" ? EXIT_BLOCKED : EXIT_OK;
  }
  try {
    return await runCommand(command, args);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${usage()}\n`);
    return EXIT_USAGE;
  }
}

process.exitCode = await main(process.argv.slice(ARGUMENT_OFFSET));
