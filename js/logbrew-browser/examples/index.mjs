#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const examplesDir = dirname(fileURLToPath(import.meta.url));
const commands = {
  "readme-example": {
    description: "Run the README-style browser capture example.",
    file: "readme-example.mjs"
  },
  "real-user-smoke": {
    description: "Run the stronger browser capture smoke example.",
    file: "real-user-smoke.mjs"
  }
};

const selected = process.argv[2] ?? "real-user-smoke";

if (selected === "--help" || selected === "-h") {
  printHelp();
  process.exit(0);
}

if (selected === "--list" || selected === "list") {
  printList();
  process.exit(0);
}

const command = commands[selected];
if (!command) {
  console.error(`Unknown browser example: ${selected}`);
  printList();
  process.exit(1);
}

const result = spawnSync(process.execPath, [join(examplesDir, command.file)], {
  stdio: "inherit"
});
process.exit(result.status ?? 1);

function printHelp() {
  console.log("Usage: node node_modules/@logbrew/browser/examples/index.mjs [example]");
  console.log("");
  console.log("Examples:");
  printList();
  console.log("");
  console.log("Helper commands:");
  console.log("npm --prefix node_modules/@logbrew/browser/examples run help");
  console.log("npm --prefix node_modules/@logbrew/browser/examples run list");
  console.log("npm --prefix node_modules/@logbrew/browser/examples run readme-example");
  console.log("npm --prefix node_modules/@logbrew/browser/examples run real-user-smoke");
  console.log("");
  console.log("Default example: real-user-smoke");
}

function printList() {
  for (const [name, command] of Object.entries(commands)) {
    console.log(`${name} -> node node_modules/@logbrew/browser/examples/index.mjs ${name}`);
    console.log(`  ${command.description}`);
  }
}
