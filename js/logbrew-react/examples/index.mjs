import process from "node:process";

const repoPrefix = "cd js/logbrew-react";
const repoExamplesPrefix = "cd js/logbrew-react/examples";
const installedHelperPrefix = "npm --prefix node_modules/@logbrew/react/examples run";
const installedPnpmHelperPrefix = "pnpm --dir node_modules/@logbrew/react/examples run";
const repoLauncherPrefix = "node examples/index.mjs";
const installedLauncherPrefix = "node node_modules/@logbrew/react/examples/index.mjs";

const examples = {
  "readme-example": new URL("./readme-example.mjs", import.meta.url),
  "real-user-smoke": new URL("./real-user-smoke.mjs", import.meta.url)
};

function isInstalledPackageContext() {
  return import.meta.url.includes("/node_modules/@logbrew/react/examples/");
}

function exampleCommands() {
  if (!isInstalledPackageContext()) {
    return {
      "readme-example": `${repoPrefix} && ${repoLauncherPrefix} readme-example`,
      "real-user-smoke": `${repoPrefix} && ${repoLauncherPrefix} real-user-smoke`,
      "default (real-user-smoke)": `${repoPrefix} && ${repoLauncherPrefix}`
    };
  }

  return {
    "readme-example": `${installedLauncherPrefix} readme-example`,
    "real-user-smoke": `${installedLauncherPrefix} real-user-smoke`,
    "default (real-user-smoke)": installedLauncherPrefix
  };
}

function helperCommands() {
  if (!isInstalledPackageContext()) {
    return {
      "readme-example": `${repoExamplesPrefix} && npm run readme-example | ${repoExamplesPrefix} && pnpm run readme-example`,
      "real-user-smoke": `${repoExamplesPrefix} && npm run real-user-smoke | ${repoExamplesPrefix} && pnpm run real-user-smoke`
    };
  }

  return {
    "readme-example": `${installedHelperPrefix} readme-example | ${installedPnpmHelperPrefix} readme-example`,
    "real-user-smoke": `${installedHelperPrefix} real-user-smoke | ${installedPnpmHelperPrefix} real-user-smoke`
  };
}

function printList() {
  for (const [name, command] of Object.entries(exampleCommands())) {
    console.log(`${name} -> ${command}`);
  }
}

function printHelp() {
  if (isInstalledPackageContext()) {
    console.log("Usage: node node_modules/@logbrew/react/examples/index.mjs [--list] [example]");
    console.log("Run the packaged LogBrew React examples that ship with the installed package.");
  } else {
    console.log("Usage: node examples/index.mjs [--list] [example]");
    console.log("Run the repo-checkout LogBrew React examples before install.");
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
