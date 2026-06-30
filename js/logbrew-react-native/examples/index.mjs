#!/usr/bin/env node

const commands = new Map([
  ["apollo-link-spans", new URL("./apollo-link-spans.mjs", import.meta.url)],
  ["instrumentation-kit", new URL("./instrumentation-kit.mjs", import.meta.url)],
  ["lifecycle-spans", new URL("./lifecycle-spans.mjs", import.meta.url)],
  ["native-bridge-scope", new URL("./native-bridge-scope.mjs", import.meta.url)],
  ["navigation-resource-spans", new URL("./navigation-resource-spans.mjs", import.meta.url)],
  ["readme-example", new URL("./readme-example.mjs", import.meta.url)],
  ["real-user-smoke", new URL("./real-user-smoke.mjs", import.meta.url)],
  ["resource-fetch-spans", new URL("./resource-fetch-spans.mjs", import.meta.url)],
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
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs apollo-link-spans");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs instrumentation-kit");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs lifecycle-spans");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs native-bridge-scope");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs --list");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs navigation-resource-spans");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs readme-example");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs real-user-smoke");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs resource-fetch-spans");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs trace-correlation");
  console.log("node node_modules/@logbrew/react-native/examples/index.mjs");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run list");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run apollo-link-spans");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run instrumentation-kit");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run lifecycle-spans");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run native-bridge-scope");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run navigation-resource-spans");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run readme-example");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run real-user-smoke");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run resource-fetch-spans");
  console.log("npm --prefix node_modules/@logbrew/react-native/examples run trace-correlation");
}

function printList() {
  console.log("apollo-link-spans -> node node_modules/@logbrew/react-native/examples/index.mjs apollo-link-spans");
  console.log("instrumentation-kit -> node node_modules/@logbrew/react-native/examples/index.mjs instrumentation-kit");
  console.log("lifecycle-spans -> node node_modules/@logbrew/react-native/examples/index.mjs lifecycle-spans");
  console.log("native-bridge-scope -> node node_modules/@logbrew/react-native/examples/index.mjs native-bridge-scope");
  console.log("navigation-resource-spans -> node node_modules/@logbrew/react-native/examples/index.mjs navigation-resource-spans");
  console.log("readme-example -> node node_modules/@logbrew/react-native/examples/index.mjs readme-example");
  console.log("real-user-smoke -> node node_modules/@logbrew/react-native/examples/index.mjs real-user-smoke");
  console.log("resource-fetch-spans -> node node_modules/@logbrew/react-native/examples/index.mjs resource-fetch-spans");
  console.log("trace-correlation -> node node_modules/@logbrew/react-native/examples/index.mjs trace-correlation");
}
