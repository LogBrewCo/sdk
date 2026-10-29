# LogBrew SDK benchmarks

These scripts measure the LogBrew JavaScript SDKs: how large the browser
bundle is, how much CPU time and memory the SDK spends on each captured error
and span, and how fast the LogBrew API makes a log readable. You can rerun all
of them with one command and check every number below.

## Run them

You need Node.js 22 or newer and Google Chrome or Chromium.

```bash
bash benchmarks/run.sh
```

The script installs the exact package versions from `package-lock.json`, then
prints one JSON result for each benchmark. The size and cost benchmarks take
about 2 minutes, and the latency benchmark about 2 more. `--quick` runs a few
events only. CI uses it to check that the scripts still work, and it does not
check the results.

The latency benchmark sends logs to your own LogBrew project. It runs only when
you give it key files:

```bash
logbrew projects keys create "<project_id>" --kind server --ingest-key-file ./bench.ingest
logbrew projects keys create "<project_id>" --kind read --ingest-key-file ./bench.read
LOGBREW_INGEST_KEY_FILE=./bench.ingest LOGBREW_READ_KEY_FILE=./bench.read bash benchmarks/run.sh
```

The script reads the keys from the files and never prints them. Use a test
project, because the run adds 100 logs to it. Revoke both keys when you finish.

## Results

All numbers come from runs on 2026-10-29. The raw output, with every
individual run, is in [results/2026-10-29](results/2026-10-29).

| Machine and software | Value |
| --- | --- |
| Computer | Apple M4, 10 cores, 16 GB memory |
| Operating system | macOS 27.0.1 |
| Node.js | 22.18.0 |
| Browser | Headless Chrome 156.0.8078.48 |
| Bundler | esbuild 0.28.2 |
| Packages | `@logbrew/browser` 0.1.15, `@logbrew/node` 0.1.20, `@logbrew/sdk` 0.1.35, `web-vitals` 6.2.3 |
| Machine load | Other programs ran during the cost runs. The load average went from about 8 to 26. |

### Browser bundle size

| Setup | Minified | gzip | brotli |
| --- | ---: | ---: | ---: |
| Errors | 127,601 B | 36,522 B | 31,609 B |
| Errors and tracing | 177,005 B | 48,078 B | 41,192 B |

### SDK cost per captured event

Each value is the median of 15 runs, followed by the slowest or largest of
those 15 runs. One run captures 1,000 events, so each run's value is already an
average of 1,000 events. CPU time is in microseconds per event. Memory is what
the SDK allocated per event, in bytes, whether or not it was freed later.

| Runtime and event | CPU time | Memory |
| --- | ---: | ---: |
| Node.js, error | 144.2 µs, max 229.8 | 44,382 B, max 44,472 |
| Node.js, span | 73.7 µs, max 121.8 | 15,826 B, max 15,882 |
| Browser, error | 65.1 µs, max 67.1 | 29,897 B, max 29,974 |
| Browser, span | 23.0 µs, max 25.0 | 9,246 B, max 9,288 |

The Node.js runs share the machine's cores with other programs, so they vary
more than the browser runs.

### Ingest and query latency

| Measurement | p50 | p99 | Max | Samples |
| --- | ---: | ---: | ---: | ---: |
| Capture to accepted by the API | 260 ms | 415 ms | 424 ms | 100 |
| Capture to returned by the read API | 402 ms | 644 ms | 646 ms | 100 |
| One log search request | 132 ms | 207 ms | 230 ms | 100 |

These times include the network round trip between the test computer and
`https://api.logbrew.co`.

## Method

The rules for every benchmark were fixed before the first result. The SDK runs
with its default settings. Every run counts. Nothing is a best of several
attempts.

### Bundle size

[size.mjs](size.mjs) bundles a small app with esbuild: bundled, minified, ES
module output, browser platform, and no other options. It then compresses each
bundle with gzip at level 9 and brotli at quality 11. Sizes do not change
between runs, so the script builds each bundle once.

- [size/logbrew-errors.js](size/logbrew-errors.js) is the minimal setup from
  the [browser package README](../js/logbrew-browser/README.md). It captures
  errors, unhandled rejections, and the first page view.
- [size/logbrew-tracing.js](size/logbrew-tracing.js) adds every tracing helper
  that README documents: route changes, fetch and XHR spans with trace
  propagation, document load, resource timing, interactions and long tasks,
  and Web Vitals through the `web-vitals` package.

### Cost per event

[overhead.mjs](overhead.mjs) replaces the SDK's network transport with an
in-memory stub, so no request leaves the computer. The SDK still builds and
serializes every payload before it hands the payload to the stub. The Node.js
runs use a new process each time. The browser runs use a new Chrome browser
context each time.

Each run first captures 200 events to warm up. It then runs the same loop
twice, once without the SDK and once with it, and subtracts the first from the
second. So the result is the SDK's own cost, without the cost of creating each
`Error` in the app. Each event runs in its own task, the way errors and spans
arrive in an app, and the loop waits for the SDK to flush at the end.

- An error is a new `Error` with a unique message. The browser runs capture it
  with `captureBrowserError()`. The Node.js runs use `client.issue()` with
  `createIssueAttributesFromError()`.
- A span is a root span around an empty function. The SDK records it with
  `client.span()` after it creates a trace context, an event ID, and a
  duration.
- Node.js CPU time is `process.cpuUsage()`, user plus system, for all threads
  of the process. Browser CPU time is the page's main-thread task time from the
  Chrome DevTools Protocol.
- Memory comes from the V8 sampling heap profiler at a 128-byte interval, with
  objects that garbage collection already freed included.
- After each run the script counts the delivered events in the stub. The run
  fails unless every captured error or span arrived.

The [overhead](overhead) folder has the SDK adapters and the shared loop.

### Ingest and query latency

[latency.mjs](latency.mjs) uses `@logbrew/node` with its default transport. It
sends 100 logs one at a time, each with a unique marker.

- The clock starts just before `client.log()`. Accepted is when `flush()`
  returns a success response.
- After a log is accepted, the script searches for its marker with
  `GET /api/logs` and a read key. It repeats the search every 200 ms until the
  log appears. Readable is when that search response returns.
- When all 100 logs are readable, the script runs 100 more searches, 200 ms
  apart, for all logs of the run and times each request. The last search must
  return all 100 logs.
- A rate-limited request waits for `Retry-After`, and that wait counts in the
  result. This run had no rate-limited requests.

p50 and p99 use the nearest-rank method over all 100 samples.

## Limits

- One machine and one date. Your numbers will differ, so rerun the scripts on
  your own hardware.
- The cost benchmark measures capture and serialization with a stub transport.
  It does not measure network time in your app.
- With 15 runs, the cost table reports the median and the maximum of the runs.
  15 runs are too few for a p99.
- The latency results depend on the network path from the test computer to the
  API.
