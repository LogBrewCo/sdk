import { field, fieldOfEach, parseJson, pick } from "./capture-helpers.js";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";

/**
 * @typedef {{ readonly status: number | null, readonly stderr: string, readonly stdout: string }} RunResult
 */

const SUPPORTED_EVENT_TYPES = ["release", "environment", "issue", "log", "span", "action"];
const EXPECTED_EVENT_COUNT = SUPPORTED_EVENT_TYPES.length;
const EXIT_OK = 0;
const NOT_FOUND = -1;
const PAYMENT_UNAVAILABLE = 503;
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const NPM_EXAMPLES_DIR = fileURLToPath(new URL("../examples", import.meta.url));
const PNPM_EXAMPLES_DIR = fileURLToPath(new URL("../examples/", import.meta.url));
const PRIVATE_TIMELINE_VALUES = /card=private|coupon=private|#payment|debug heartbeat/u;

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {string} cwd
 * @returns {Promise<RunResult>}
 */
async function runCommand(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  const [stdout, stderr] = await Promise.all([text(child.stdout), text(child.stderr), closed]);
  return { status: child.exitCode, stderr, stdout };
}

/**
 * @param {readonly string[]} args
 * @returns {Promise<RunResult>}
 */
async function runNode(args) {
  return runCommand(process.execPath, args, PACKAGE_DIR);
}

/**
 * @param {readonly string[]} args
 * @returns {Promise<RunResult>}
 */
async function runNpm(args) {
  return runCommand("npm", args, NPM_EXAMPLES_DIR);
}

/**
 * @param {readonly string[]} args
 * @returns {Promise<RunResult>}
 */
async function runPnpm(args) {
  return runCommand("pnpm", args, PNPM_EXAMPLES_DIR);
}

/**
 * @param {string} output
 * @returns {unknown}
 */
function parseLastJsonObject(output) {
  const lines = output.trim().split("\n");
  const start = lines.findIndex((line) => line.startsWith("{"));
  if (start === NOT_FOUND) {
    throw new Error(`no JSON object found in output:\n${output}`);
  }
  return parseJson(lines.slice(start).join("\n"));
}

/**
 * @param {string} output
 * @returns {unknown}
 */
function parseLastJsonLine(output) {
  const lines = output.trim().split("\n").filter((line) => line !== "");
  lines.reverse();
  const line = lines.find((candidate) => candidate.startsWith("{"));
  if (line === undefined) {
    throw new Error(`no JSON line found in output:\n${output}`);
  }
  return parseJson(line);
}

/**
 * @param {unknown} payload
 * @returns {void}
 */
function assertEventTypes(payload) {
  assert.deepEqual(fieldOfEach(field(payload, "events"), "type"), SUPPORTED_EVENT_TYPES);
}

/**
 * @param {unknown} summary
 * @returns {void}
 */
function assertSuccessSummary(summary) {
  assert.deepEqual(summary, {
    attempts: 1,
    events: EXPECTED_EVENT_COUNT,
    ok: true,
    status: 202
  });
}

/**
 * @param {string} output
 * @returns {void}
 */
function assertCompactSuccessSummary(output) {
  assert.match(
    output,
    new RegExp(`\\{"ok":true,"status":202,"attempts":1,"events":${EXPECTED_EVENT_COUNT}\\}`, "u")
  );
}

/**
 * @param {string} output
 * @returns {void}
 */
function assertOutputIncludesEventTypes(output) {
  for (const eventType of SUPPORTED_EVENT_TYPES) {
    assert.match(output, new RegExp(`"type": "${eventType}"`, "u"));
  }
}

/**
 * @param {unknown} metadata
 * @returns {void}
 */
function assertCheckoutMetadata(metadata) {
  assert.equal(field(metadata, "source"), "product.action");
  assert.equal(field(metadata, "routeTemplate"), "/checkout/:step");
  assert.equal(field(metadata, "funnel"), "checkout");
}

/**
 * @param {unknown} metadata
 * @returns {void}
 */
function assertPaymentMetadata(metadata) {
  assert.equal(field(metadata, "source"), "network.milestone");
  assert.equal(field(metadata, "routeTemplate"), "/payments/123");
  assert.equal(field(metadata, "statusCode"), PAYMENT_UNAVAILABLE);
  assert.equal(field(metadata, "method"), "POST");
  assert.equal(field(metadata, "retryable"), true);
}

/**
 * @param {unknown} payload
 * @returns {void}
 */
function assertAgentTimelinePayload(payload) {
  assert.equal(pick(payload, "sdk.name"), "checkout-agent-timeline");
  const events = field(payload, "events");
  assert.deepEqual(fieldOfEach(events, "id"), [
    "evt_checkout_started",
    "evt_payment_api"
  ]);
  assert.deepEqual(fieldOfEach(events, "type"), ["action", "action"]);
  assert.deepEqual(fieldOfEach(fieldOfEach(events, "attributes"), "status"), ["success", "failure"]);
  assertCheckoutMetadata(pick(payload, "events.0.attributes.metadata"));
  assertPaymentMetadata(pick(payload, "events.1.attributes.metadata"));

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, PRIVATE_TIMELINE_VALUES);
}

/**
 * @param {unknown} summary
 * @returns {void}
 */
function assertAgentTimelineSummary(summary) {
  assert.deepEqual(summary, {
    events: 2,
    ok: true,
    status: 202,
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"
  });
}

export {
  EXIT_OK,
  PRIVATE_TIMELINE_VALUES,
  assertAgentTimelinePayload,
  assertAgentTimelineSummary,
  assertCompactSuccessSummary,
  assertEventTypes,
  assertOutputIncludesEventTypes,
  assertSuccessSummary,
  parseLastJsonLine,
  parseLastJsonObject,
  runNode,
  runNpm,
  runPnpm
};
