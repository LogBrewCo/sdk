import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { compile } from "svelte/compiler";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @import { Component } from "svelte"
 * @import { LogBrewClient, Transport } from "@logbrew/sdk"
 * @typedef {Component<{ readonly client?: LogBrewClient, readonly transport?: Transport }>} ExampleComponent
 */

/**
 * @param {unknown} value
 * @returns {value is ExampleComponent}
 */
function isComponent(value) {
  return typeof value === "function";
}

/**
 * @param {string} modulePath
 * @param {string} filename
 * @returns {Promise<ExampleComponent>}
 */
async function loadComponent(modulePath, filename) {
  /** @type {unknown} */
  const loaded = await import(pathToFileURL(modulePath).href);
  /** @type {unknown} */
  const component = typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "default") : undefined;
  if (!isComponent(component)) {
    throw new TypeError(`${filename} has no default component export`);
  }
  return component;
}

/**
 * @param {string} filename
 * @param {string} source
 * @param {string} prefix
 * @returns {Promise<ExampleComponent>}
 */
async function compileComponent(filename, source, prefix) {
  const dir = await mkdtemp(path.join(process.cwd(), prefix));
  try {
    const compiled = compile(source, { filename, generate: "server" });
    const modulePath = path.join(dir, `${filename}.mjs`);
    await writeFile(modulePath, compiled.js.code, "utf8");
    return await loadComponent(modulePath, filename);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

/**
 * @param {unknown} value
 * @param {readonly (string | number)[]} keys
 * @returns {unknown}
 */
function readPath(value, keys) {
  /** @type {unknown} */
  let current = value;
  for (const key of keys) {
    current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  }
  return current;
}

export { compileComponent, readPath };
