import { readField, readList } from "./overhead/fields.js";
import { build } from "esbuild";
import { createServer } from "node:http";
import { launchChrome } from "./overhead/cdp.mjs";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

/**
 * @import { IncomingMessage, ServerResponse } from "node:http"
 * @import { Signal } from "./overhead/loop.js"
 * @typedef {"logbrew" | "sentry"} Sdk
 * @typedef {"browser" | "node"} Runtime
 * @typedef {{ readonly bytesPerEvent: number, readonly cpuMicrosPerEvent: number, readonly delivered: unknown, readonly expected: number }} RunResult
 * @typedef {{ readonly sdk: Sdk, readonly signal: Signal }} Case
 * @typedef {{ readonly chrome: import("./overhead/cdp.mjs").Chrome, readonly origin: string }} Browser
 * @typedef {(expression: string) => Promise<unknown>} Call
 */

const QUICK = { count: 50, runs: 1, warmup: 10 };
const FULL = { count: 1000, runs: 15, warmup: 200 };
const { count: COUNT, runs: RUNS, warmup: WARMUP } = process.argv.includes("--quick") ? QUICK : FULL;
/** @type {readonly Sdk[]} */
const SDKS = ["logbrew", "sentry"];
const ADAPTERS = { logbrew: "logbrew", sentry: "comparison" };
/** @type {readonly Signal[]} */
const SIGNALS = ["error", "span"];
/** @type {readonly Runtime[]} */
const RUNTIMES = ["node", "browser"];
const PACKAGES = {
  browser: { logbrew: "@logbrew/browser", sentry: "@sentry/browser" },
  node: { logbrew: "@logbrew/node", sentry: "@sentry/node" }
};
const HEAP_SAMPLING_INTERVAL_BYTES = 128;
const MICROS_PER_SECOND = 1e6;
const ROUNDING = 10;
const HALF = 2;
const STEP = 1;
const EVEN = 2;
const EVEN_REMAINDER = 0;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const NO_SECONDS = 0;
const SUCCESS_EXIT_CODE = 0;
const ANY_PORT = 0;
const here = new URL(".", import.meta.url).pathname;

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
async function version(name) {
  /** @type {unknown} */
  const manifest = JSON.parse(await readFile(`${here}node_modules/${name}/package.json`, "utf8"));
  return String(readField(manifest, "version"));
}

/**
 * @param {Sdk} sdk
 * @returns {Promise<string>}
 */
async function bundle(sdk) {
  const result = await build({
    bundle: true,
    format: "iife",
    logLevel: "silent",
    minify: true,
    platform: "browser",
    stdin: {
      contents: `import { bench } from "./overhead/${ADAPTERS[sdk]}-browser.js";
import { installPage } from "./overhead/page.js";
installPage(bench);`,
      loader: "js",
      resolveDir: here
    },
    write: false
  });
  const [output] = result.outputFiles;
  return output?.text ?? "";
}

/**
 * @param {Case} run
 * @returns {Promise<RunResult>}
 */
async function nodeRun({ sdk, signal }) {
  const child = spawn(process.execPath, [`${here}overhead/node-child.mjs`, ADAPTERS[sdk], signal, String(COUNT), String(WARMUP)], {
    cwd: here,
    stdio: ["ignore", "pipe", "inherit"]
  });
  const exited = once(child, "close");
  let stdout = "";
  for await (const chunk of child.stdout) {
    stdout += String(chunk);
  }
  await exited;
  if (child.exitCode !== SUCCESS_EXIT_CODE) {
    throw new Error(`node ${sdk} ${signal}: child exited with ${String(child.exitCode)}`);
  }
  /** @type {unknown} */
  const result = JSON.parse(stdout.trim().split("\n").at(-STEP) ?? "");
  return {
    bytesPerEvent: Number(readField(result, "bytesPerEvent")),
    cpuMicrosPerEvent: Number(readField(result, "cpuMicrosPerEvent")),
    delivered: readField(result, "delivered"),
    expected: Number(readField(result, "expected"))
  };
}

/**
 * @param {unknown} node
 * @returns {number}
 */
function sampled(node) {
  let bytes = Number(readField(node, "selfSize"));
  for (const child of readList(readField(node, "children"))) {
    bytes += sampled(child);
  }
  return bytes;
}

/**
 * @param {Browser} browser
 * @param {Case} run
 * @returns {Promise<{ readonly call: Call, readonly dispose: () => Promise<unknown>, readonly sessionId: string }>}
 */
async function openPage({ chrome: { send, waitFor }, origin }, { sdk, signal }) {
  const browserContextId = readField(await send("Target.createBrowserContext", {}), "browserContextId");
  const targetId = readField(await send("Target.createTarget", { browserContextId, url: "about:blank" }), "targetId");
  const sessionId = String(readField(await send("Target.attachToTarget", { flatten: true, targetId }), "sessionId"));
  for (const domain of ["Page", "Performance", "HeapProfiler"]) {
    await send(`${domain}.enable`, {}, sessionId);
  }
  const loaded = waitFor("Page.loadEventFired", sessionId);
  await send("Page.navigate", { url: `${origin}/${sdk}.html` }, sessionId);
  await loaded;
  return {
    async call(expression) {
      const reply = await send("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true }, sessionId);
      const details = readField(reply, "exceptionDetails");
      if (details !== undefined) {
        const description = readField(readField(details, "exception"), "description") ?? readField(details, "text");
        throw new Error(`${sdk} ${signal}: ${String(description)}`);
      }
      return readField(readField(reply, "result"), "value");
    },
    dispose: async () => send("Target.disposeBrowserContext", { browserContextId }),
    sessionId
  };
}

/**
 * @param {Browser} browser
 * @param {string} sessionId
 * @returns {Promise<number>}
 */
async function taskSeconds({ chrome: { send } }, sessionId) {
  const metrics = readList(readField(await send("Performance.getMetrics", {}, sessionId), "metrics"));
  const task = metrics.find((metric) => readField(metric, "name") === "TaskDuration");
  return Number(readField(task, "value") ?? NO_SECONDS);
}

/**
 * @param {Browser} browser
 * @param {{ readonly call: Call, readonly sessionId: string }} page
 * @param {string} expression
 * @returns {Promise<number>}
 */
async function allocated({ chrome: { send } }, { call, sessionId }, expression) {
  await send(
    "HeapProfiler.startSampling",
    { includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true, samplingInterval: HEAP_SAMPLING_INTERVAL_BYTES },
    sessionId
  );
  await call(expression);
  const stopped = await send("HeapProfiler.stopSampling", {}, sessionId);
  return sampled(readField(readField(stopped, "profile"), "head"));
}

/**
 * @param {Signal} signal
 * @param {number} events
 * @param {{ readonly offset: number, readonly withSdk: boolean }} run
 * @returns {string}
 */
function measure(signal, events, { offset, withSdk }) {
  return `measure(${JSON.stringify({ count: events, offset, signal, withSdk })})`;
}

/**
 * @param {Browser} browser
 * @param {{ readonly call: Call, readonly sessionId: string }} page
 * @param {Signal} signal
 * @returns {Promise<number>}
 */
async function cpuMicrosPerEvent(browser, { call, sessionId }, signal) {
  await call(measure(signal, WARMUP, { offset: 0, withSdk: true }));
  const before = await taskSeconds(browser, sessionId);
  await call(measure(signal, COUNT, { offset: WARMUP, withSdk: false }));
  const baseline = await taskSeconds(browser, sessionId);
  await call(measure(signal, COUNT, { offset: WARMUP + COUNT, withSdk: true }));
  const withSdk = await taskSeconds(browser, sessionId);
  return ((withSdk - baseline - (baseline - before)) * MICROS_PER_SECOND) / COUNT;
}

/**
 * @param {Browser} browser
 * @param {Case} run
 * @returns {Promise<RunResult>}
 */
async function browserRun(browser, run) {
  const page = await openPage(browser, run);
  const { signal } = run;
  await page.call(`bench.init(${JSON.stringify(signal)})`);
  const cpu = await cpuMicrosPerEvent(browser, page, signal);
  const baselineBytes = await allocated(browser, page, measure(signal, COUNT, { offset: WARMUP + COUNT + COUNT, withSdk: false }));
  const sdkBytes = await allocated(browser, page, measure(signal, COUNT, { offset: WARMUP + COUNT + COUNT + COUNT, withSdk: true }));
  const delivered = await page.call(`bench.delivered(${JSON.stringify(signal)})`);
  await page.dispose();
  return { bytesPerEvent: (sdkBytes - baselineBytes) / COUNT, cpuMicrosPerEvent: cpu, delivered, expected: WARMUP + COUNT + COUNT };
}

/**
 * @param {readonly number[]} values
 * @returns {number}
 */
function median(values) {
  return values.toSorted((left, right) => left - right)[Math.floor(values.length / HALF)] ?? Number.NaN;
}

/**
 * @param {number} value
 * @returns {number}
 */
function round(value) {
  return Math.round(value * ROUNDING) / ROUNDING;
}

/**
 * @param {Readonly<Record<Sdk, string>>} bundles
 * @returns {(request: IncomingMessage, response: ServerResponse) => void}
 */
function servePages(bundles) {
  return (request, response) => {
    const { extension, name } = /^\/(?<name>\w+)\.(?<extension>html|js)$/u.exec(request.url ?? "")?.groups ?? {};
    const page = name === "logbrew" || name === "sentry" ? bundles[name] : undefined;
    if (page === undefined) {
      response.writeHead(HTTP_NOT_FOUND).end();
    } else if (extension === "html") {
      response
        .writeHead(HTTP_OK, { "content-type": "text/html" })
        .end(`<!doctype html><title>bench</title><script src="/${String(name)}.js"></script>`);
    } else {
      response.writeHead(HTTP_OK, { "content-type": "text/javascript" }).end(page);
    }
  };
}

/**
 * @param {Runtime} runtime
 * @param {Browser} browser
 * @param {Case} run
 * @returns {Promise<RunResult>}
 */
async function runOnce(runtime, browser, run) {
  const result = runtime === "node" ? await nodeRun(run) : await browserRun(browser, run);
  if (result.delivered !== result.expected) {
    throw new Error(`${runtime} ${run.sdk} ${run.signal}: delivered ${String(result.delivered)} of ${String(result.expected)} events`);
  }
  return result;
}

/**
 * @param {Runtime} runtime
 * @param {Browser} browser
 * @param {Signal} signal
 * @returns {Promise<Record<Sdk, RunResult[]>>}
 */
async function runCase(runtime, browser, signal) {
  /** @type {Record<Sdk, RunResult[]>} */
  const runs = { logbrew: [], sentry: [] };
  for (let run = 0; run < RUNS; run += STEP) {
    for (const sdk of run % EVEN === EVEN_REMAINDER ? SDKS : SDKS.toReversed()) {
      runs[sdk].push(await runOnce(runtime, browser, { sdk, signal }));
    }
  }
  return runs;
}

/**
 * @param {{ readonly runtime: Runtime, readonly sdk: Sdk, readonly signal: Signal }} subject
 * @param {readonly RunResult[]} runs
 * @returns {Promise<Record<string, unknown>>}
 */
async function summarize({ runtime, sdk, signal }, runs) {
  const cpu = runs.map((result) => result.cpuMicrosPerEvent);
  const bytes = runs.map((result) => result.bytesPerEvent);
  return {
    bytesPerEvent: { max: Math.round(Math.max(...bytes)), median: Math.round(median(bytes)), runs: bytes.map((value) => Math.round(value)) },
    cpuMicrosPerEvent: { max: round(Math.max(...cpu)), median: round(median(cpu)), runs: cpu.map((value) => round(value)) },
    package: `${PACKAGES[runtime][sdk]}@${await version(PACKAGES[runtime][sdk])}`,
    runtime,
    sdk,
    signal
  };
}

const [logbrewBundle, sentryBundle] = await Promise.all(SDKS.map(async (sdk) => bundle(sdk)));
const server = createServer(servePages({ logbrew: logbrewBundle ?? "", sentry: sentryBundle ?? "" }));
server.listen(ANY_PORT, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const chrome = await launchChrome();
const browser = { chrome, origin: `http://127.0.0.1:${String(typeof address === "object" ? address?.port : address)}` };
const chromeVersion = readField(await chrome.send("Browser.getVersion", {}), "product");
const cases = [];
try {
  for (const runtime of RUNTIMES) {
    for (const signal of SIGNALS) {
      const runs = await runCase(runtime, browser, signal);
      for (const sdk of SDKS) {
        cases.push(await summarize({ runtime, sdk, signal }, runs[sdk]));
      }
    }
  }
} finally {
  await chrome.close();
  server.close();
}
process.stdout.write(
  `${JSON.stringify(
    { benchmark: "sdk-overhead-per-event", cases, chrome: chromeVersion, eventsPerRun: COUNT, node: process.version, runs: RUNS, warmupEvents: WARMUP },
    undefined,
    HALF
  )}\n`
);
