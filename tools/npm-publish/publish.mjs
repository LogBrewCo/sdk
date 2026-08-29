import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { publish } from "libnpmpublish";

async function jsonResponse(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  return response.json();
}

async function exchangeGrant(packageName) {
  const { ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestGrant, ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl } = process.env;
  if (!requestUrl || !requestGrant) {
    throw new Error("GitHub OIDC environment is incomplete");
  }
  const identityUrl = new URL(requestUrl);
  identityUrl.searchParams.set("audience", "npm:registry.npmjs.org");
  const identity = await jsonResponse(
    await fetch(identityUrl, {
      headers: { Accept: "application/json", Authorization: `Bearer ${requestGrant}` },
    }),
    "GitHub OIDC request",
  );
  if (typeof identity.value !== "string" || !identity.value) {
    throw new Error("GitHub OIDC response omitted its identity");
  }
  const exchange = await jsonResponse(
    await fetch(
      `https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${packageName.replace("/", "%2f")}`,
      { method: "POST", headers: { Authorization: `Bearer ${identity.value}` } },
    ),
    `npm OIDC exchange for ${packageName}`,
  );
  if (typeof exchange.token !== "string" || !exchange.token) {
    throw new Error(`npm OIDC exchange omitted its grant for ${packageName}`);
  }
  return exchange.token;
}

const packageDirs = Bun.argv.slice(2).map((path) => resolve(path));
if (packageDirs.length === 0) throw new Error("At least one package directory is required");
const manifests = await Promise.all(packageDirs.map(async (path) => {
  const manifest = await Bun.file(join(path, "package.json")).json();
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error("Every package manifest requires name and version");
  }
  return manifest;
}));
const grants = await Promise.all(manifests.map(({ name }) => exchangeGrant(name)));
const scratch = await mkdtemp(join(tmpdir(), "logbrew-npm-publish-"));
try {
  for (const [index, manifest] of manifests.entries()) {
    const tarballPath = join(scratch, `${index}.tgz`);
    const pack = Bun.spawnSync([
      process.execPath, "pm", "pack", "--ignore-scripts", "--quiet",
      "--filename", tarballPath,
    ], { cwd: packageDirs[index] });
    if (pack.exitCode !== 0) throw new Error(`Bun pack failed for ${manifest.name}`);
    await publish(manifest, await readFile(tarballPath), {
      access: "public",
      npmVersion: `bun/${Bun.version}`,
      provenance: true,
      registry: "https://registry.npmjs.org/",
      forceAuth: { token: grants[index] },
    });
    console.log(`Published ${manifest.name}@${manifest.version} with npm provenance`);
  }
} finally {
  await rm(scratch, { force: true, recursive: true });
}
