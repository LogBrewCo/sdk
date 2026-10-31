import { access, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { realpath } from "node:fs";

/**
 * @typedef {"boolean" | "repeat" | "string"} OptionKind
 * @typedef {string | true | readonly string[]} OptionValue
 * @typedef {Readonly<Record<string, OptionValue>>} CliOptions
 * @typedef {Readonly<Record<string, OptionKind>>} OptionSpec
 * @typedef {Readonly<Record<string, unknown>>} JsonObject
 * @typedef {{ readonly positional: string, readonly width: number }} PositionalToken
 * @typedef {{ readonly kind: OptionKind, readonly name: string, readonly value: string | true, readonly width: number }} OptionToken
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SOURCE_MAP_DEBUG_ID_KEYS = ["debug_id", "debugId", "debugID", "x_debug_id"];
const OPTION_PREFIX = "--";
const FLAG_WIDTH = 1;
const VALUE_OPTION_WIDTH = 2;
const NO_POSITIONALS = 0;
const FIRST_PART_ONLY = 1;
const JSON_INDENT = 2;
const realPathOf = promisify(realpath);

/**
 * @param {unknown} value
 * @returns {value is JsonObject}
 */
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isJsonList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {OptionSpec} spec
 * @param {string} name
 * @returns {OptionKind}
 */
function optionKind(spec, name) {
  const kind = spec[name];
  if (kind === undefined) {
    throw new Error(`unknown option: --${name}`);
  }
  return kind;
}

/**
 * @param {readonly string[]} window
 * @param {OptionSpec} spec
 * @returns {OptionToken | PositionalToken}
 */
function readToken(window, spec) {
  const [arg = "", value] = window;
  if (!arg.startsWith(OPTION_PREFIX)) {
    return { positional: arg, width: FLAG_WIDTH };
  }
  const name = arg.slice(OPTION_PREFIX.length);
  const kind = optionKind(spec, name);
  if (kind === "boolean") {
    return { kind, name, value: true, width: FLAG_WIDTH };
  }
  if (value === undefined || value.startsWith(OPTION_PREFIX)) {
    throw new Error(`missing value for --${name}`);
  }
  return { kind, name, value, width: VALUE_OPTION_WIDTH };
}

/**
 * @param {readonly string[]} args
 * @param {OptionSpec} spec
 * @returns {readonly (OptionToken | PositionalToken)[]}
 */
function readTokens(args, spec) {
  /** @type {(OptionToken | PositionalToken)[]} */
  const tokens = [];
  let index = 0;
  while (index < args.length) {
    const token = readToken(args.slice(index, index + VALUE_OPTION_WIDTH), spec);
    tokens.push(token);
    index += token.width;
  }
  return tokens;
}

/**
 * @param {OptionValue | undefined} previous
 * @param {OptionToken} token
 * @returns {OptionValue}
 */
function optionValue(previous, token) {
  if (token.kind !== "repeat" || token.value === true) {
    return token.value;
  }
  /** @type {readonly string[]} */
  const earlier = typeof previous === "object" ? previous : [];
  return [...earlier, token.value];
}

/**
 * @param {readonly string[]} args
 * @param {OptionSpec} spec
 * @returns {CliOptions}
 */
function parseOptions(args, spec) {
  const tokens = readTokens(args, spec);
  const positionals = tokens.filter((token) => "positional" in token);
  if (positionals.length > NO_POSITIONALS) {
    throw new Error(`unexpected positional argument: ${String(positionals[NO_POSITIONALS]?.positional)}`);
  }
  /** @type {Record<string, OptionValue>} */
  const options = {};
  for (const token of tokens) {
    if ("name" in token) {
      options[token.name] = optionValue(options[token.name], token);
    }
  }
  return options;
}

/**
 * @param {CliOptions} options
 * @param {string} name
 * @returns {string}
 */
function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortJson(value) {
  if (isJsonList(value)) {
    return value.map((item) => sortJson(item));
  }
  if (isJsonObject(value)) {
    const keys = Object.keys(value);
    keys.sort();
    return Object.fromEntries(keys.map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

/**
 * @param {string} value
 * @returns {string}
 */
function fileReference(value) {
  const [withoutQuery = ""] = value.split("?", FIRST_PART_ONLY);
  const [withoutFragment = ""] = withoutQuery.split("#", FIRST_PART_ONLY);
  return withoutFragment;
}

/**
 * @param {string} root
 * @param {string} filePath
 * @returns {string}
 */
function relativeTo(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

/**
 * @param {JsonObject} payload
 * @returns {string | undefined}
 */
function sourceMapDebugId(payload) {
  for (const key of SOURCE_MAP_DEBUG_ID_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * @param {unknown} payload
 * @returns {void}
 */
function printJson(payload) {
  process.stdout.write(`${JSON.stringify(sortJson(payload), undefined, JSON_INDENT)}\n`);
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function realPath(filePath) {
  return realPathOf(filePath);
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readText(filePath) {
  return readFile(filePath, "utf8");
}

/**
 * @param {string} candidate
 * @param {string} root
 * @returns {Promise<string | undefined>}
 */
async function safeResolve(candidate, root) {
  const resolvedRoot = await realPath(root);
  const resolved = path.resolve(candidate);
  const comparable = (await pathExists(resolved)) ? await realPath(resolved) : resolved;
  const relative = path.relative(resolvedRoot, comparable);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return comparable;
  }
  return undefined;
}

/**
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function byteSize(filePath) {
  const stats = await stat(filePath);
  return stats.size;
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function isFile(filePath) {
  const stats = await stat(filePath);
  return stats.isFile();
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function isDirectory(filePath) {
  const stats = await stat(filePath);
  return stats.isDirectory();
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function sha256File(filePath) {
  const digest = createHash("sha256");
  digest.update(await readFile(filePath));
  return digest.digest("hex");
}

/**
 * @param {string} value
 * @returns {Promise<string>}
 */
async function requireBuildDir(value) {
  const buildDir = path.resolve(value);
  if (!(await pathExists(buildDir)) || !(await isDirectory(buildDir))) {
    throw new Error(`build directory does not exist: ${value}`);
  }
  return realPath(buildDir);
}

/**
 * @param {string} filePath
 * @param {string} label
 * @returns {Promise<unknown>}
 */
async function readJson(filePath, label) {
  try {
    /** @type {unknown} */
    const payload = JSON.parse(await readText(filePath));
    return payload;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * @param {string} filePath
 * @param {string} label
 * @returns {Promise<JsonObject>}
 */
async function readJsonObject(filePath, label) {
  const payload = await readJson(filePath, label);
  if (!isJsonObject(payload)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return payload;
}

/**
 * @template Item, Result
 * @param {readonly Item[]} items
 * @param {(item: Item) => Promise<Result>} mapper
 * @returns {Promise<Result[]>}
 */
async function mapInOrder(items, mapper) {
  /** @type {Result[]} */
  const results = [];
  /**
   * @param {readonly Item[]} remaining
   * @returns {Promise<Result[]>}
   */
  async function mapRemaining(remaining) {
    const [first, ...rest] = remaining;
    if (remaining.length === NO_POSITIONALS || first === undefined) {
      return results;
    }
    results.push(await mapper(first));
    return mapRemaining(rest);
  }
  return mapRemaining(items);
}

/**
 * @template Item
 * @param {readonly Item[]} items
 * @param {(item: Item) => Promise<boolean>} predicate
 * @returns {Promise<Item | undefined>}
 */
async function findInOrder(items, predicate) {
  const [first, ...rest] = items;
  if (items.length === NO_POSITIONALS || first === undefined) {
    return undefined;
  }
  return (await predicate(first)) ? first : findInOrder(rest, predicate);
}

/**
 * @param {unknown} value
 * @param {string} message
 * @param {boolean} required
 * @returns {string | undefined}
 */
function normalizeProjectId(value, message, required = false) {
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(message);
    }
    return undefined;
  }
  if (typeof value !== "string" || !UUID_RE.test(value.trim())) {
    throw new Error(message);
  }
  return value.trim().toLowerCase();
}

export {
  SOURCE_MAP_DEBUG_ID_KEYS,
  byteSize,
  errorMessage,
  fileReference,
  findInOrder,
  isDirectory,
  isFile,
  isJsonList,
  isJsonObject,
  mapInOrder,
  normalizeProjectId,
  parseOptions,
  pathExists,
  printJson,
  readJsonObject,
  readText,
  realPath,
  relativeTo,
  requireBuildDir,
  requireOption,
  safeResolve,
  sha256File,
  sortJson,
  sourceMapDebugId,
  stableJson
};
