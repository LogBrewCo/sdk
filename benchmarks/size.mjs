// Bundles the errors and tracing setup of each SDK in size/ with esbuild (bundled, minified, ESM, browser platform) and
// prints the gzip (level 9) and brotli (quality 11) sizes in bytes.
// Sizes do not vary between runs, so one build per setup is reported.
import { readFileSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { build } from "esbuild";

const setups = [
  ["LogBrew", "@logbrew/browser", "size/logbrew-tracing.js"],
  ["Comparison", "@sentry/browser", "size/comparison-tracing.js"]
];
const version = (name) =>
  JSON.parse(readFileSync(new URL(`node_modules/${name}/package.json`, import.meta.url))).version;

const rows = [];
for (const [sdk, pkg, entry] of setups) {
  const result = await build({
    entryPoints: [new URL(entry, import.meta.url).pathname],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    write: false,
    logLevel: "silent"
  });
  const code = result.outputFiles[0].contents;
  rows.push({
    sdk,
    package: `${pkg}@${version(pkg)}`,
    gzip: gzipSync(code, { level: 9 }).length,
    brotli: brotliCompressSync(code, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: code.length }
    }).length
  });
}
console.log(JSON.stringify({ benchmark: "browser-bundle-size", esbuild: version("esbuild"), unit: "bytes", rows }, null, 2));
