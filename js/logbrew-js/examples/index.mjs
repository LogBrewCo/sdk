import process from "node:process";

const repoPrefix = "cd js/logbrew-js";
const repoExamplesPrefix = "cd js/logbrew-js/examples";
const repoNpmHelperPrefix = "npm run";
const repoPnpmHelperPrefix = "pnpm run";
const installedHelperPrefix = "npm --prefix node_modules/@logbrew/sdk/examples run";
const installedPnpmHelperPrefix = "pnpm --dir node_modules/@logbrew/sdk/examples run";
const installedLauncherPrefix = "node node_modules/@logbrew/sdk/examples/index.mjs";
const repoLauncherPrefix = "node examples/index.mjs";
const defaultExample = "real-user-smoke";
const FIRST_ARGUMENT = 2;
const EXIT_OK = 0;
const EXIT_UNKNOWN_EXAMPLE = 1;

const exampleNames = Object.freeze([
  "agent-timeline",
  "agent-timeline:esm",
  "agent-timeline:cjs",
  "readme-example",
  "readme-example:esm",
  "readme-example:cjs",
  "real-user-smoke",
  "real-user-smoke:esm",
  "real-user-smoke:cjs"
]);

/**
 * @param {string} name
 * @returns {URL}
 */
function exampleUrl(name) {
  const [file = name, format = "esm"] = name.split(":");
  return new URL(`${file}.${format === "cjs" ? "cjs" : "mjs"}`, import.meta.url);
}

const examples = new Map(exampleNames.map((name) => [name, exampleUrl(name)]));

/**
 * @param {string} name
 * @param {string} command
 * @returns {readonly [string, string]}
 */
function commandEntry(name, command) {
  return [name, command];
}

/**
 * @returns {boolean}
 */
function isInstalledPackageContext() {
  return import.meta.url.includes("/node_modules/@logbrew/sdk/examples/");
}

/**
 * @returns {readonly (readonly [string, string])[]}
 */
function exampleCommands() {
  const launcher = isInstalledPackageContext() ? installedLauncherPrefix : `${repoPrefix} && ${repoLauncherPrefix}`;
  return [
    ...exampleNames.map((name) => commandEntry(name, `${launcher} ${name}`)),
    commandEntry(`default (${defaultExample})`, launcher)
  ];
}

/**
 * @returns {readonly (readonly [string, string])[]}
 */
function helperCommands() {
  if (isInstalledPackageContext()) {
    return exampleNames.map((name) => commandEntry(name, `${installedHelperPrefix} ${name} | ${installedPnpmHelperPrefix} ${name}`));
  }
  return exampleNames.map((name) => commandEntry(
    name,
    `${repoExamplesPrefix} && ${repoNpmHelperPrefix} ${name} | ${repoExamplesPrefix} && ${repoPnpmHelperPrefix} ${name}`
  ));
}

/**
 * @param {string} line
 * @returns {void}
 */
function print(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * @returns {void}
 */
function printList() {
  for (const [name, command] of exampleCommands()) {
    print(`${name} -> ${command}`);
  }
}

/**
 * @returns {void}
 */
function printUsage() {
  if (isInstalledPackageContext()) {
    print("Usage: node node_modules/@logbrew/sdk/examples/index.mjs [--list] [example]");
    print("Run the packaged LogBrew SDK JavaScript examples that ship with the installed package.");
  } else {
    print("Usage: node examples/index.mjs [--list] [example]");
    print("Run the repo-checkout LogBrew SDK JavaScript examples before install.");
  }
}

/**
 * @param {string} title
 * @param {readonly (readonly [string, string])[]} commands
 * @returns {void}
 */
function printSection(title, commands) {
  print("");
  print(title);
  for (const [name, command] of commands) {
    print(`  ${name} -> ${command}`);
  }
}

/**
 * @returns {void}
 */
function printHelp() {
  printUsage();
  printSection("Launcher commands:", exampleCommands());
  printSection("Package-manager helper commands:", helperCommands());
}

/**
 * @param {string} example
 * @returns {Promise<number>}
 */
async function runExample(example) {
  const target = examples.get(example);
  if (target === undefined) {
    process.stderr.write(`unknown example: ${example}\n`);
    printHelp();
    return EXIT_UNKNOWN_EXAMPLE;
  }
  await import(target.href);
  return EXIT_OK;
}

/**
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return EXIT_OK;
  }
  if (argv.includes("--list")) {
    printList();
    return EXIT_OK;
  }
  const [example = defaultExample] = argv;
  return runExample(example);
}

const exitCode = await main(process.argv.slice(FIRST_ARGUMENT));
if (exitCode !== EXIT_OK) {
  process.exitCode = exitCode;
}
