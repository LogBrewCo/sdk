import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const sdkRoot = path.resolve(packageRoot, "../logbrew-js");

export async function withInstalledPackage(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-rn-global-errors-"));
  const nodeModules = path.join(root, "node_modules");
  const packageDir = path.join(nodeModules, "@logbrew", "react-native");
  try {
    fs.mkdirSync(path.dirname(packageDir), { recursive: true });
    fs.cpSync(packageRoot, packageDir, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`)
    });
    fs.symlinkSync(sdkRoot, path.join(nodeModules, "@logbrew", "sdk"), "dir");
    const reactDir = path.join(nodeModules, "react");
    fs.mkdirSync(reactDir, { recursive: true });
    fs.writeFileSync(
      path.join(reactDir, "package.json"),
      JSON.stringify({ name: "react", version: "18.0.0", main: "index.cjs" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(reactDir, "index.cjs"),
      "module.exports={createContext(value){return {_currentValue:value,Provider(){},Consumer(){}}},createElement(type,props,...children){return {type,props:{...(props||{}),children}}}};\n",
      "utf8"
    );
    const reactNativeDir = path.join(nodeModules, "react-native");
    fs.mkdirSync(reactNativeDir, { recursive: true });
    fs.writeFileSync(
      path.join(reactNativeDir, "package.json"),
      JSON.stringify({
        name: "react-native",
        version: "0.86.2",
        type: "module",
        main: "index.js"
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(reactNativeDir, "index.js"),
      [
        "export const NativeModules = {};",
        "export const TurboModuleRegistry = { get() { return undefined; } };",
        ""
      ].join("\n"),
      "utf8"
    );
    return await callback(
      await import(pathToFileURL(path.join(packageDir, "global-errors.js"))),
      packageDir,
      await import(pathToFileURL(path.join(sdkRoot, "index.js")))
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function createErrorUtils(previousHandler = () => {}) {
  let currentHandler = previousHandler;
  return {
    getGlobalHandler() {
      return currentHandler;
    },
    setGlobalHandler(handler) {
      currentHandler = handler;
    },
    currentHandler() {
      return currentHandler;
    }
  };
}

export function createClient({ drop = false, fail = false } = {}) {
  const issues = [];
  let dropped = 0;
  return {
    droppedEvents() {
      return dropped;
    },
    issue(id, timestamp, attributes) {
      if (fail) {
        throw new Error("private capture failure");
      }
      if (drop) {
        dropped += 1;
        return;
      }
      issues.push({ attributes, id, timestamp });
    },
    pendingEvents() {
      return issues.length;
    },
    issues
  };
}
