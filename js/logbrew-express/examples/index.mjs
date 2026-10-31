#!/usr/bin/env node

const COMMAND_ARGUMENT = 2;
const FAILURE = 1;
const commands = new Map([
  ["readme-example", new URL("readme-example.mjs", import.meta.url)],
  ["handler-wrapper", new URL("handler-wrapper.mjs", import.meta.url)],
  ["real-user-smoke", new URL("real-user-smoke.mjs", import.meta.url)]
]);
const help = [
  "LogBrew Express examples",
  "node node_modules/@logbrew/express/examples/index.mjs --list",
  "node node_modules/@logbrew/express/examples/index.mjs readme-example",
  "bun node_modules/@logbrew/express/examples/index.mjs handler-wrapper",
  "node node_modules/@logbrew/express/examples/index.mjs real-user-smoke",
  "node node_modules/@logbrew/express/examples/index.mjs",
  "npm --prefix node_modules/@logbrew/express/examples run list",
  "npm --prefix node_modules/@logbrew/express/examples run readme-example",
  "npm --prefix node_modules/@logbrew/express/examples run real-user-smoke"
];
const list = [
  "readme-example -> node node_modules/@logbrew/express/examples/index.mjs readme-example",
  "handler-wrapper -> bun node_modules/@logbrew/express/examples/index.mjs handler-wrapper",
  "real-user-smoke -> node node_modules/@logbrew/express/examples/index.mjs real-user-smoke"
];

/**
 * @param {readonly string[]} lines
 * @returns {void}
 */
function printLines(lines) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

const command = process.argv[COMMAND_ARGUMENT] ?? "real-user-smoke";
const example = commands.get(command);

if (command === "--help" || command === "-h") {
  printLines(help);
} else if (command === "--list") {
  printLines(list);
} else if (example === undefined) {
  process.stderr.write(`Unknown LogBrew Express example: ${command}\n`);
  printLines(list);
  process.exitCode = FAILURE;
} else {
  await import(example.href);
}
