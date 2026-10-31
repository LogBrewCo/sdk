import { createLogBrewNodeClient } from "@logbrew/node";
import { readField } from "./overhead/fields.js";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * @typedef {{ readonly acknowledged: number, readonly visible: number }} CaptureSample
 * @typedef {{ readonly elapsed: number, readonly rows: readonly unknown[] }} SearchResult
 */

const QUICK_COUNT = 3;
const FULL_COUNT = 100;
const COUNT = process.argv.includes("--quick") ? QUICK_COUNT : FULL_COUNT;
const POLL_MS = 200;
const TIMEOUT_MS = 60_000;
const MARKER_ROWS = 5;
const SEARCH_ROWS = 100;
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;
const DEFAULT_RETRY_SECONDS = 1;
const PERCENT = 100;
const MEDIAN_PERCENTILE = 50;
const TAIL_PERCENTILE = 99;
const RANK_OFFSET = 1;
const STEP = 1;
const BASE36 = 36;
const INDENT = 2;
const api = process.env["LOGBREW_API_URL"] ?? "https://api.logbrew.co";
const run = `lbbench${Date.now().toString(BASE36)}`;
const stats = { rateLimited: 0 };

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
async function keyFile(name) {
  const keyPath = process.env[name] ?? "";
  if (keyPath === "") {
    throw new Error(`Set ${name} to a key file path.`);
  }
  const key = await readFile(keyPath, "utf8");
  return key.trim();
}

const readKey = await keyFile("LOGBREW_READ_KEY_FILE");
const client = createLogBrewNodeClient({ apiKey: await keyFile("LOGBREW_INGEST_KEY_FILE") });

/**
 * @param {Response} response
 * @param {number} elapsed
 * @returns {Promise<SearchResult>}
 */
async function readRows(response, elapsed) {
  if (!response.ok) {
    throw new Error(`read API returned ${String(response.status)}`);
  }
  /** @type {unknown} */
  const rows = await response.json();
  return { elapsed, rows: Array.isArray(rows) ? rows : [] };
}

/**
 * @param {string} text
 * @param {number} limit
 * @returns {Promise<SearchResult>}
 */
async function search(text, limit) {
  const query = new URLSearchParams({ limit: String(limit), search: text, since: "1h" });
  for (;;) {
    const start = performance.now();
    const response = await fetch(`${api}/api/logs?${query.toString()}`, { headers: { authorization: `Bearer ${readKey}` } });
    const elapsed = performance.now() - start;
    if (response.status !== HTTP_TOO_MANY_REQUESTS) {
      return readRows(response, elapsed);
    }
    stats.rateLimited += STEP;
    await sleep(Number(response.headers.get("retry-after") ?? DEFAULT_RETRY_SECONDS) * MS_PER_SECOND);
  }
}

/**
 * @param {string} marker
 * @param {number} start
 * @returns {Promise<number>}
 */
async function waitUntilReadable(marker, start) {
  for (;;) {
    const { rows } = await search(marker, MARKER_ROWS);
    const visible = performance.now() - start;
    if (rows.some((row) => String(readField(row, "message")).includes(marker))) {
      return visible;
    }
    if (visible > TIMEOUT_MS) {
      throw new Error(`log ${marker} was not readable after ${String(TIMEOUT_MS)} ms`);
    }
    await sleep(POLL_MS);
  }
}

/**
 * @param {number} index
 * @returns {Promise<CaptureSample>}
 */
async function captureOne(index) {
  const marker = `${run}n${String(index)}e`;
  const start = performance.now();
  client.log(crypto.randomUUID(), new Date().toISOString(), { level: "info", logger: "benchmark", message: `benchmark ${marker}` });
  const sent = await client.flush();
  const acknowledged = performance.now() - start;
  if (sent.statusCode !== HTTP_OK && sent.statusCode !== HTTP_ACCEPTED) {
    throw new Error(`ingest returned ${String(sent.statusCode)}`);
  }
  const visible = await waitUntilReadable(marker, start);
  await sleep(POLL_MS);
  return { acknowledged, visible };
}

/**
 * @param {readonly number[]} values
 * @param {number} rank
 * @returns {number}
 */
function percentile(values, rank) {
  return values.toSorted((left, right) => left - right)[Math.ceil((rank / PERCENT) * values.length) - RANK_OFFSET] ?? Number.NaN;
}

/**
 * @param {readonly number[]} values
 * @returns {Record<string, number>}
 */
function summary(values) {
  return {
    max: Math.round(Math.max(...values)),
    p50: Math.round(percentile(values, MEDIAN_PERCENTILE)),
    p99: Math.round(percentile(values, TAIL_PERCENTILE)),
    samples: values.length
  };
}

/** @type {CaptureSample[]} */
const capture = [];
for (let index = 0; index < COUNT; index += STEP) {
  capture.push(await captureOne(index));
}
/** @type {number[]} */
const queries = [];
const found = { rows: 0 };
for (let index = 0; index < COUNT; index += STEP) {
  const { elapsed, rows } = await search(run, SEARCH_ROWS);
  queries.push(elapsed);
  found.rows = rows.length;
  await sleep(POLL_MS);
}
if (found.rows !== COUNT) {
  throw new Error(`search returned ${String(found.rows)} of ${String(COUNT)} logs`);
}
await client.shutdown();
/** @type {unknown} */
const installed = JSON.parse(await readFile(new URL("node_modules/@logbrew/node/package.json", import.meta.url), "utf8"));
const report = {
  api,
  benchmark: "ingest-and-query-latency",
  captureToAcknowledged: summary(capture.map((sample) => sample.acknowledged)),
  captureToReadable: summary(capture.map((sample) => sample.visible)),
  node: process.version,
  package: `@logbrew/node@${String(readField(installed, "version"))}`,
  pollIntervalMs: POLL_MS,
  rateLimitedRequests: stats.rateLimited,
  searchQuery: summary(queries),
  unit: "ms"
};
process.stdout.write(`${JSON.stringify(report, undefined, INDENT)}\n`);
