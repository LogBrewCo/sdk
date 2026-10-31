#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const COMMAND_ARGUMENT = 2;
const FAILURE = 1;
const commands = new Map([
  ["readme-example", "readme-example.mjs"],
  ["real-user-smoke", "real-user-smoke.mjs"]
]);
const help = [
  "Usage: node node_modules/@logbrew/angular/examples/index.mjs [command]",
  "",
  "Commands:",
  "  readme-example    Run the README-sized Angular example",
  "  real-user-smoke   Run the full Angular real-user smoke example",
  "",
  "npm --prefix node_modules/@logbrew/angular/examples run readme-example",
  "npm --prefix node_modules/@logbrew/angular/examples run real-user-smoke",
  "node node_modules/@logbrew/angular/examples/index.mjs readme-example",
  "node node_modules/@logbrew/angular/examples/index.mjs real-user-smoke"
];

/**
 * @param {readonly string[]} lines
 * @returns {void}
 */
function printLines(lines) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * @param {string} file
 * @returns {void}
 */
function runExample(file) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal === null) {
      process.exitCode = code ?? FAILURE;
      return;
    }
    process.kill(process.pid, signal);
  });
}

const command = process.argv[COMMAND_ARGUMENT] ?? "real-user-smoke";
const file = commands.get(command);

if (command === "--help" || command === "-h") {
  printLines(help);
} else if (command === "--list") {
  /** @type {string[]} */
  const lines = [];
  for (const [name, example] of commands) {
    lines.push(`${name} -> node node_modules/@logbrew/angular/examples/index.mjs ${name} (${example})`);
  }
  printLines(lines);
} else if (file === undefined) {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.exitCode = FAILURE;
} else {
  runExample(file);
}
