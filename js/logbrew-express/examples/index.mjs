#!/usr/bin/env node

const commands = new Map([
  ["readme-example", new URL("./readme-example.mjs", import.meta.url)],
  ["real-user-smoke", new URL("./real-user-smoke.mjs", import.meta.url)]
]);

const command = process.argv[2] ?? "real-user-smoke";

if (command === "--help" || command === "-h") {
  printHelp();
} else if (command === "--list") {
  printList();
} else if (commands.has(command)) {
  await import(commands.get(command));
} else {
  console.error(`Unknown LogBrew Express example: ${command}`);
  printList();
  process.exitCode = 1;
}

function printHelp() {
  console.log("LogBrew Express examples");
  console.log("node node_modules/@logbrew/express/examples/index.mjs --list");
  console.log("node node_modules/@logbrew/express/examples/index.mjs readme-example");
  console.log("node node_modules/@logbrew/express/examples/index.mjs real-user-smoke");
  console.log("node node_modules/@logbrew/express/examples/index.mjs");
  console.log("npm --prefix node_modules/@logbrew/express/examples run list");
  console.log("npm --prefix node_modules/@logbrew/express/examples run readme-example");
  console.log("npm --prefix node_modules/@logbrew/express/examples run real-user-smoke");
}

function printList() {
  console.log("readme-example -> node node_modules/@logbrew/express/examples/index.mjs readme-example");
  console.log("real-user-smoke -> node node_modules/@logbrew/express/examples/index.mjs real-user-smoke");
}
