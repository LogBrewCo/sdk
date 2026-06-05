import process from "node:process";

const repoPrefix = "cd js/logbrew-js";
const repoExamplesPrefix = "cd js/logbrew-js/examples";
const repoNpmHelperPrefix = "npm run";
const repoPnpmHelperPrefix = "pnpm run";
const installedHelperPrefix = "npm --prefix node_modules/@logbrew/sdk/examples run";
const installedPnpmHelperPrefix = "pnpm --dir node_modules/@logbrew/sdk/examples run";
const installedLauncherPrefix = "node node_modules/@logbrew/sdk/examples/index.mjs";
const repoLauncherPrefix = "node examples/index.mjs";

const examples = {
  "readme-example": new URL("./readme-example.mjs", import.meta.url),
  "readme-example:esm": new URL("./readme-example.mjs", import.meta.url),
  "readme-example:cjs": new URL("./readme-example.cjs", import.meta.url),
  "real-user-smoke": new URL("./real-user-smoke.mjs", import.meta.url),
  "real-user-smoke:esm": new URL("./real-user-smoke.mjs", import.meta.url),
  "real-user-smoke:cjs": new URL("./real-user-smoke.cjs", import.meta.url)
};

function isInstalledPackageContext() {
  return import.meta.url.includes("/node_modules/@logbrew/sdk/examples/");
}

function exampleCommands() {
  if (!isInstalledPackageContext()) {
    return {
      "readme-example": `${repoPrefix} && ${repoLauncherPrefix} readme-example`,
      "readme-example:esm": `${repoPrefix} && ${repoLauncherPrefix} readme-example:esm`,
      "readme-example:cjs": `${repoPrefix} && ${repoLauncherPrefix} readme-example:cjs`,
      "real-user-smoke": `${repoPrefix} && ${repoLauncherPrefix} real-user-smoke`,
      "real-user-smoke:esm": `${repoPrefix} && ${repoLauncherPrefix} real-user-smoke:esm`,
      "real-user-smoke:cjs": `${repoPrefix} && ${repoLauncherPrefix} real-user-smoke:cjs`,
      "default (real-user-smoke)": `${repoPrefix} && ${repoLauncherPrefix}`
    };
  }

  return {
    "readme-example": `${installedLauncherPrefix} readme-example`,
    "readme-example:esm": `${installedLauncherPrefix} readme-example:esm`,
    "readme-example:cjs": `${installedLauncherPrefix} readme-example:cjs`,
    "real-user-smoke": `${installedLauncherPrefix} real-user-smoke`,
    "real-user-smoke:esm": `${installedLauncherPrefix} real-user-smoke:esm`,
    "real-user-smoke:cjs": `${installedLauncherPrefix} real-user-smoke:cjs`,
    "default (real-user-smoke)": installedLauncherPrefix
  };
}

function helperCommands() {
  if (!isInstalledPackageContext()) {
    return {
      "readme-example": `${repoExamplesPrefix} && ${repoNpmHelperPrefix} readme-example | ${repoExamplesPrefix} && ${repoPnpmHelperPrefix} readme-example`,
      "readme-example:esm": `${repoExamplesPrefix} && ${repoNpmHelperPrefix} readme-example:esm | ${repoExamplesPrefix} && ${repoPnpmHelperPrefix} readme-example:esm`,
      "readme-example:cjs": `${repoExamplesPrefix} && ${repoNpmHelperPrefix} readme-example:cjs | ${repoExamplesPrefix} && ${repoPnpmHelperPrefix} readme-example:cjs`,
      "real-user-smoke": `${repoExamplesPrefix} && ${repoNpmHelperPrefix} real-user-smoke | ${repoExamplesPrefix} && ${repoPnpmHelperPrefix} real-user-smoke`,
      "real-user-smoke:esm": `${repoExamplesPrefix} && ${repoNpmHelperPrefix} real-user-smoke:esm | ${repoExamplesPrefix} && ${repoPnpmHelperPrefix} real-user-smoke:esm`,
      "real-user-smoke:cjs": `${repoExamplesPrefix} && ${repoNpmHelperPrefix} real-user-smoke:cjs | ${repoExamplesPrefix} && ${repoPnpmHelperPrefix} real-user-smoke:cjs`
    };
  }

  return {
    "readme-example": `${installedHelperPrefix} readme-example | ${installedPnpmHelperPrefix} readme-example`,
    "readme-example:esm": `${installedHelperPrefix} readme-example:esm | ${installedPnpmHelperPrefix} readme-example:esm`,
    "readme-example:cjs": `${installedHelperPrefix} readme-example:cjs | ${installedPnpmHelperPrefix} readme-example:cjs`,
    "real-user-smoke": `${installedHelperPrefix} real-user-smoke | ${installedPnpmHelperPrefix} real-user-smoke`,
    "real-user-smoke:esm": `${installedHelperPrefix} real-user-smoke:esm | ${installedPnpmHelperPrefix} real-user-smoke:esm`,
    "real-user-smoke:cjs": `${installedHelperPrefix} real-user-smoke:cjs | ${installedPnpmHelperPrefix} real-user-smoke:cjs`
  };
}

function printList() {
  for (const [name, command] of Object.entries(exampleCommands())) {
    console.log(`${name} -> ${command}`);
  }
}

function printHelp() {
  if (isInstalledPackageContext()) {
    console.log("Usage: node node_modules/@logbrew/sdk/examples/index.mjs [--list] [example]");
    console.log("Run the packaged LogBrew SDK JavaScript examples that ship with the installed package.");
  } else {
    console.log("Usage: node examples/index.mjs [--list] [example]");
    console.log("Run the repo-checkout LogBrew SDK JavaScript examples before install.");
  }
  console.log("");
  console.log("Launcher commands:");
  for (const [name, command] of Object.entries(exampleCommands())) {
    console.log(`  ${name} -> ${command}`);
  }
  console.log("");
  console.log("Package-manager helper commands:");
  for (const [name, command] of Object.entries(helperCommands())) {
    console.log(`  ${name} -> ${command}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }

  if (argv.includes("--list")) {
    printList();
    return 0;
  }

  const [example = "real-user-smoke"] = argv;
  const target = examples[example];
  if (!target) {
    console.error(`unknown example: ${example}`);
    printHelp();
    return 1;
  }

  await import(target.href);
  return 0;
}

const exitCode = await main();
if (exitCode !== 0) {
  process.exit(exitCode);
}
