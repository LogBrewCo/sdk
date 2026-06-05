#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const commands = {
  "readme-example": "readme-example.mjs",
  "real-user-smoke": "real-user-smoke.mjs"
};

const examplesDir = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2] ?? "real-user-smoke";

if (command === "--help" || command === "-h") {
  console.log("Usage: node node_modules/@logbrew/nestjs/examples/index.mjs [command]");
  console.log("");
  console.log("Commands:");
  console.log("  readme-example    Run the README-sized NestJS example");
  console.log("  real-user-smoke   Run the full NestJS real-user smoke example");
  console.log("");
  console.log("npm --prefix node_modules/@logbrew/nestjs/examples run readme-example");
  console.log("npm --prefix node_modules/@logbrew/nestjs/examples run real-user-smoke");
  console.log("node node_modules/@logbrew/nestjs/examples/index.mjs readme-example");
  console.log("node node_modules/@logbrew/nestjs/examples/index.mjs real-user-smoke");
  process.exit(0);
}

if (command === "--list") {
  for (const [name, file] of Object.entries(commands)) {
    console.log(`${name} -> node node_modules/@logbrew/nestjs/examples/index.mjs ${name} (${file})`);
  }
  process.exit(0);
}

const file = commands[command];
if (!file) {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

const child = spawn(process.execPath, [join(examplesDir, file)], {
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
