// Measures, against the LogBrew API, how long a log takes from capture until the read API
// returns it, and how long a log search takes. It needs your own project keys:
//   LOGBREW_INGEST_KEY_FILE  a file that holds a server ingest key for a test project
//   LOGBREW_READ_KEY_FILE    a file that holds a read key for the same project
// Keys are read from the files and never printed. Usage: node latency.mjs [--quick]
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createLogBrewNodeClient } from "@logbrew/node";

const quick = process.argv.includes("--quick");
// Fixed before any result was seen.
const COUNT = quick ? 3 : 100;
const POLL_MS = 200;
const TIMEOUT_MS = 60_000;
const api = process.env.LOGBREW_API_URL ?? "https://api.logbrew.co";
const keyFile = (name) => {
  const path = process.env[name];
  if (!path) {
    throw new Error(`Set ${name} to a key file path.`);
  }
  return readFileSync(path, "utf8").trim();
};
const readKey = keyFile("LOGBREW_READ_KEY_FILE");
const client = createLogBrewNodeClient({ apiKey: keyFile("LOGBREW_INGEST_KEY_FILE") });
const run = `lbbench${Date.now().toString(36)}`;
let rateLimited = 0;

// One read request. Returns the rows and the request's round-trip time in milliseconds.
async function search(text, limit) {
  for (;;) {
    const start = performance.now();
    const response = await fetch(`${api}/api/logs?${new URLSearchParams({ search: text, since: "1h", limit: String(limit) })}`, {
      headers: { authorization: `Bearer ${readKey}` }
    });
    const elapsed = performance.now() - start;
    if (response.status === 429) {
      rateLimited += 1;
      await sleep(Number(response.headers.get("retry-after") ?? 1) * 1000);
      continue;
    }
    if (!response.ok) {
      throw new Error(`read API returned ${response.status}`);
    }
    return { rows: await response.json(), elapsed };
  }
}

const capture = [];
for (let i = 0; i < COUNT; i += 1) {
  const marker = `${run}n${i}e`;
  const start = performance.now();
  client.log(crypto.randomUUID(), new Date().toISOString(), { message: `benchmark ${marker}`, level: "info", logger: "benchmark" });
  const sent = await client.flush();
  const acknowledged = performance.now() - start;
  if (sent.statusCode !== 200 && sent.statusCode !== 202) {
    throw new Error(`ingest returned ${sent.statusCode}`);
  }
  for (;;) {
    const { rows } = await search(marker, 5);
    const visible = performance.now() - start;
    if (rows.some((row) => row.message.includes(marker))) {
      capture.push({ acknowledged, visible });
      break;
    }
    if (visible > TIMEOUT_MS) {
      throw new Error(`log ${i} was not readable after ${TIMEOUT_MS} ms`);
    }
    await sleep(POLL_MS);
  }
  await sleep(POLL_MS);
}

const queries = [];
let found = 0;
for (let i = 0; i < COUNT; i += 1) {
  const { rows, elapsed } = await search(run, 100);
  queries.push(elapsed);
  found = rows.length;
  await sleep(POLL_MS);
}
if (found !== COUNT) {
  throw new Error(`search returned ${found} of ${COUNT} logs`);
}
await client.shutdown();

// Nearest-rank percentile over every observation.
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil((p / 100) * values.length) - 1];
const summary = (values) => ({
  p50: Math.round(percentile(values, 50)),
  p99: Math.round(percentile(values, 99)),
  max: Math.round(Math.max(...values)),
  samples: values.length
});
console.log(JSON.stringify({
  benchmark: "ingest-and-query-latency",
  api,
  package: `@logbrew/node@${JSON.parse(readFileSync(new URL("node_modules/@logbrew/node/package.json", import.meta.url))).version}`,
  node: process.version,
  pollIntervalMs: POLL_MS,
  rateLimitedRequests: rateLimited,
  unit: "ms",
  captureToAcknowledged: summary(capture.map((sample) => sample.acknowledged)),
  captureToReadable: summary(capture.map((sample) => sample.visible)),
  searchQuery: summary(queries)
}, null, 2));
