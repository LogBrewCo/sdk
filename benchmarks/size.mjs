import { brotliCompress, constants, gzip } from "node:zlib";
import { build } from "esbuild";
import { promisify } from "node:util";
import { readField } from "./overhead/fields.js";
import { readFile } from "node:fs/promises";

const SETUPS = [
  { entry: "size/logbrew-tracing.js", packageName: "@logbrew/browser", sdk: "LogBrew" },
  { entry: "size/comparison-tracing.js", packageName: "@sentry/browser", sdk: "Comparison" }
];
const GZIP_LEVEL = 9;
const BROTLI_QUALITY = 11;
const INDENT = 2;
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
async function version(name) {
  /** @type {unknown} */
  const manifest = JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, import.meta.url), "utf8"));
  return String(readField(manifest, "version"));
}

/**
 * @param {{ readonly entry: string, readonly packageName: string, readonly sdk: string }} setup
 * @returns {Promise<Record<string, unknown>>}
 */
async function measureSetup({ entry, packageName, sdk }) {
  const result = await build({
    bundle: true,
    entryPoints: [new URL(entry, import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    minify: true,
    platform: "browser",
    write: false
  });
  const [output] = result.outputFiles;
  const code = output?.contents ?? new Uint8Array();
  const gzipped = await gzipAsync(code, { level: GZIP_LEVEL });
  const brotli = await brotliAsync(code, {
    params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: code.length }
  });
  return { brotli: brotli.length, gzip: gzipped.length, package: `${packageName}@${await version(packageName)}`, sdk };
}

const rows = [];
for (const setup of SETUPS) {
  rows.push(await measureSetup(setup));
}
process.stdout.write(
  `${JSON.stringify({ benchmark: "browser-bundle-size", esbuild: await version("esbuild"), rows, unit: "bytes" }, undefined, INDENT)}\n`
);
