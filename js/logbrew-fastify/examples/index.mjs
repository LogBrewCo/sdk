#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const COMMAND_ARGUMENT = 2;
const SUCCESS = 0;
const FAILURE = 1;
const launcher = "node_modules/@logbrew/fastify/examples/index.mjs";
const commands = new Map([
  ["readme-example", "readme-example.mjs"],
  ["real-user-smoke", "real-user-smoke.mjs"]
]);
const command = process.argv[COMMAND_ARGUMENT] ?? "real-user-smoke";

if (command === "--help" || command === "-h") {
  process.stdout.write(
    [
      `Usage: node ${launcher} [command]`,
      "",
      "Commands:",
      "  readme-example    Run the README-sized Fastify example",
      "  real-user-smoke   Run the full Fastify real-user smoke example",
      "",
      "npm --prefix node_modules/@logbrew/fastify/examples run readme-example",
      "npm --prefix node_modules/@logbrew/fastify/examples run real-user-smoke",
      `node ${launcher} readme-example`,
      `node ${launcher} real-user-smoke`,
      ""
    ].join("\n")
  );
  process.exit(SUCCESS);
}

if (command === "--list") {
  for (const [name, file] of commands) {
    process.stdout.write(`${name} -> node ${launcher} ${name} (${file})\n`);
  }
  process.exit(SUCCESS);
}

const file = commands.get(command);
if (file === undefined) {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(FAILURE);
}

const child = spawn(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], {
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? FAILURE);
});
