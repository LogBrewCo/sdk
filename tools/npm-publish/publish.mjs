import { argv, version as bunVersion, file, spawn } from "bun";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { publish } from "libnpmpublish";
import { tmpdir } from "node:os";

/**
 * @import { PackageJson } from "@npm/types"
 * @typedef {{ readonly headers: Readonly<Record<string, string>>, readonly method?: "POST" }} JsonRequest
 * @typedef {{ readonly grant: string, readonly manifest: PackageJson, readonly packageDir: string }} PublishTarget
 */

const FIRST_PACKAGE_ARGUMENT = 2;
const NO_PACKAGES = 0;
const SUCCESS_EXIT_CODE = 0;
const TRANSPARENCY_LOG_TIMEOUT_MS = 60_000;

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {string}
 */
function readString(value, key) {
  const field = isObjectLike(value) ? value[key] : undefined;
  return typeof field === "string" ? field : "";
}

/**
 * @param {string} url
 * @param {JsonRequest} request
 * @param {string} label
 * @returns {Promise<unknown>}
 */
async function fetchJson(url, request, label) {
  const response = await fetch(url, request);
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${String(response.status)}`);
  }
  /** @type {unknown} */
  const body = await response.json();
  return body;
}

/**
 * @returns {Promise<string>}
 */
async function requestIdentity() {
  const requestUrl = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] ?? "";
  const requestGrant = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] ?? "";
  if (requestUrl === "" || requestGrant === "") {
    throw new Error("GitHub OIDC environment is incomplete");
  }
  const identityUrl = new URL(requestUrl);
  identityUrl.searchParams.set("audience", "npm:registry.npmjs.org");
  const identity = readString(
    await fetchJson(
      identityUrl.href,
      { headers: { Accept: "application/json", Authorization: `Bearer ${requestGrant}` } },
      "GitHub OIDC request"
    ),
    "value"
  );
  if (identity === "") {
    throw new Error("GitHub OIDC response omitted its identity");
  }
  return identity;
}

/**
 * @param {string} packageName
 * @returns {Promise<string>}
 */
async function exchangeGrant(packageName) {
  const identity = await requestIdentity();
  const exchangeUrl = `https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${packageName.replace("/", "%2f")}`;
  const exchange = await fetchJson(
    exchangeUrl,
    { headers: { Authorization: `Bearer ${identity}` }, method: "POST" },
    `npm OIDC exchange for ${packageName}`
  );
  const grant = readString(exchange, "token");
  if (grant === "") {
    throw new Error(`npm OIDC exchange omitted its grant for ${packageName}`);
  }
  return grant;
}

/**
 * @param {string} packageDir
 * @returns {Promise<PackageJson>}
 */
async function readManifest(packageDir) {
  /** @type {unknown} */
  const manifest = await file(path.join(packageDir, "package.json")).json();
  const name = readString(manifest, "name");
  const packageVersion = readString(manifest, "version");
  if (!isObjectLike(manifest) || name === "" || packageVersion === "") {
    throw new TypeError("Every package manifest requires name and version");
  }
  return { ...manifest, name, version: packageVersion };
}

/**
 * @param {PublishTarget} target
 * @param {string} scratch
 * @returns {Promise<string>}
 */
async function publishPackage({ grant, manifest, packageDir }, scratch) {
  const tarballPath = path.join(scratch, `${manifest.name.replace("/", "-")}.tgz`);
  const pack = spawn([process.execPath, "pm", "pack", "--ignore-scripts", "--quiet", "--filename", tarballPath], {
    cwd: packageDir
  });
  if ((await pack.exited) !== SUCCESS_EXIT_CODE) {
    throw new Error(`Bun pack failed for ${manifest.name}`);
  }
  await publish(manifest, await readFile(tarballPath), {
    access: "public",
    forceAuth: { token: grant },
    npmVersion: `bun/${bunVersion}`,
    provenance: true,
    registry: "https://registry.npmjs.org/",
    timeout: TRANSPARENCY_LOG_TIMEOUT_MS
  });
  return `Published ${manifest.name}@${manifest.version} with npm provenance\n`;
}

const packageDirs = argv.slice(FIRST_PACKAGE_ARGUMENT).map((packageDir) => path.resolve(packageDir));
if (packageDirs.length === NO_PACKAGES) {
  throw new Error("At least one package directory is required");
}
const manifests = await Promise.all(packageDirs.map(async (packageDir) => readManifest(packageDir)));
const grants = await Promise.all(manifests.map(async (manifest) => exchangeGrant(manifest.name)));
/** @type {readonly PublishTarget[]} */
const targets = manifests.map((manifest, index) => ({ grant: grants[index] ?? "", manifest, packageDir: packageDirs[index] ?? "" }));
const scratch = await mkdtemp(path.join(tmpdir(), "logbrew-npm-publish-"));
try {
  for (const target of targets) {
    process.stdout.write(await publishPackage(target, scratch));
  }
} finally {
  await rm(scratch, { force: true, recursive: true });
}
