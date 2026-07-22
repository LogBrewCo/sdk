import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])])
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

export function printJson(payload) {
  process.stdout.write(`${JSON.stringify(sortJson(payload), null, 2)}\n`);
}

export function safeResolve(candidate, root) {
  const resolvedRoot = fs.realpathSync(root);
  const resolved = path.resolve(candidate);
  const comparable = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  const relative = path.relative(resolvedRoot, comparable);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return comparable;
  }
  return null;
}

export function byteSize(filePath) {
  return fs.statSync(filePath).size;
}

export function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  digest.update(fs.readFileSync(filePath));
  return digest.digest("hex");
}

export function requireBuildDir(value) {
  const buildDir = path.resolve(value);
  if (!fs.existsSync(buildDir) || !fs.statSync(buildDir).isDirectory()) {
    throw new Error(`build directory does not exist: ${value}`);
  }
  return fs.realpathSync(buildDir);
}

export function readJsonObject(filePath, label) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return payload;
}

export function normalizeProjectId(value, errorMessage, required = false) {
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(errorMessage);
    }
    return undefined;
  }
  if (typeof value !== "string" || UUID_RE.test(value.trim()) === false) {
    throw new Error(errorMessage);
  }
  return value.trim().toLowerCase();
}
