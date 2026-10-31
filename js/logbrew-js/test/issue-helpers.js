import { LogBrewClient, SdkError, createIssueAttributesFromError } from "@logbrew/sdk";
import assert from "node:assert/strict";

const LOGGER_TRACE = {
  parentSpanId: "00f067aa0ba902b7",
  sampled: true,
  spanId: "b7ad6b7169203331",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736"
};
const OVERSIZED_TEXT_LENGTH = 257;
const TEXT_LIMIT = 256;
const STACK_FRAME_LIMIT = 32;

/**
 * @returns {LogBrewClient}
 */
function sampleClient() {
  return LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    maxRetries: 2,
    sdkName: "logbrew-js",
    sdkVersion: "0.1.0"
  });
}

/**
 * @param {string} value
 * @returns {unknown}
 */
function parseJson(value) {
  /** @type {unknown} */
  const parsed = JSON.parse(value);
  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} keyPath
 * @returns {unknown}
 */
function pick(value, keyPath) {
  let current = value;
  for (const key of keyPath.split(".")) {
    current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  }
  return current;
}

/**
 * @param {unknown} value
 * @returns {readonly unknown[]}
 */
function items(value) {
  assert.ok(Array.isArray(value), "expected an array");
  /** @type {readonly unknown[]} */
  const list = value;
  return list;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  assert.equal(typeof value, "string", "expected a string");
  return String(value);
}

/**
 * @param {unknown} target
 * @param {string} keyPath
 * @param {unknown} replacement
 * @returns {void}
 */
function setAt(target, keyPath, replacement) {
  const keys = keyPath.split(".");
  const last = keys.pop();
  const parent = pick(target, keys.join("."));
  assert.ok(typeof parent === "object" && parent !== null && last !== undefined, "expected an object");
  Reflect.set(parent, last, replacement);
}

/**
 * @param {LogBrewClient} client
 * @returns {unknown}
 */
function previewEvents(client) {
  return pick(parseJson(client.previewJson()), "events");
}

/**
 * @param {LogBrewClient} client
 * @param {number} index
 * @returns {unknown}
 */
function previewAttributes(client, index) {
  return pick(previewEvents(client), `${index}.attributes`);
}

/**
 * @param {LogBrewClient} client
 * @returns {unknown}
 */
function firstAttributes(client) {
  return pick(previewEvents(client), "0.attributes");
}

/**
 * @param {LogBrewClient} client
 * @param {readonly unknown[]} args
 * @returns {void}
 */
function uncheckedIssue(client, args) {
  Reflect.apply(client.issue.bind(client), undefined, args);
}

/**
 * @param {unknown} error
 * @param {unknown} options
 * @returns {unknown}
 */
function uncheckedIssueAttributes(error, options) {
  /** @type {unknown} */
  const attributes = Reflect.apply(createIssueAttributesFromError, undefined, [error, options]);
  return attributes;
}

/**
 * @param {unknown} reason
 * @returns {boolean}
 */
function isValidationError(reason) {
  return reason instanceof SdkError && reason.code === "validation_error";
}

export {
  LOGGER_TRACE,
  OVERSIZED_TEXT_LENGTH,
  STACK_FRAME_LIMIT,
  TEXT_LIMIT,
  firstAttributes,
  isValidationError,
  items,
  parseJson,
  pick,
  previewAttributes,
  previewEvents,
  sampleClient,
  setAt,
  text,
  uncheckedIssue,
  uncheckedIssueAttributes
};
