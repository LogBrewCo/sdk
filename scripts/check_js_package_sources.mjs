const packageDir = process.cwd();
const entrypoints = [];

for await (const path of new Bun.Glob("**/*.{js,cjs,mjs}").scan({
  cwd: packageDir,
  onlyFiles: true
})) {
  if (!path.includes("node_modules/")) entrypoints.push(`${packageDir}/${path}`);
}

const result = await Bun.build({
  entrypoints,
  format: "esm",
  naming: "source-[hash].[ext]",
  packages: "external",
  target: "node",
  write: false
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exitCode = 1;
}
