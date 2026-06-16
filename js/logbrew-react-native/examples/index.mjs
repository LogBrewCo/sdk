#!/usr/bin/env node

const commands = new Map([
  ["navigation-resource-spans", new URL("./navigation-resource-spans.mjs", import.meta.url)],
  ["readme-example", new URL("./readme-example.mjs", import.meta.url)],
  ["real-user-smoke", new URL("./real-user-smoke.mjs", import.meta.url)],
  ["trace-correlation", new URL("./trace-correlation.mjs", import.meta.url)]
]);

const command = process.argv[2] ?? "real-user-smoke";

if (command === "--help" || command === "-h") {
  printHelp();
} else if (command === "--list") {
  printList();
} else if (commands.has(command)) {
  await import(commands.get(command));
} else {
  console.error(`Unknown LogBrew React Native example: ${command}`);
  printList();
  process.exitCode = 1;
}

function printHelp() {
  console.log("LogBrew React Native examples");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs --list");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs navigation-resource-spans");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs readme-example");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs real-user-smoke");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs trace-correlation");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run list");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run navigation-resource-spans");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run readme-example");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run real-user-smoke");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run trace-correlation");
}

function printList() {
  console.log("navigation-resource-spans -> node node_modules/@logbrew/react-native/examples/index.mjs navigation-resource-spans");
  console.log("readme-example -> node node_modules/@logbrew/react-native/examples/index.mjs readme-example");
  console.log("real-user-smoke -> node node_modules/@logbrew/react-native/examples/index.mjs real-user-smoke");
  console.log("trace-correlation -> node node_modules/@logbrew/react-native/examples/index.mjs trace-correlation");
}
