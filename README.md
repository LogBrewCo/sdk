# LogBrew SDK Contracts

Public foundation for LogBrew SDKs. This repository currently defines:

- A language-neutral event contract for releases, environments, issues, logs, traces/spans, and actions
- Public fixtures for valid and invalid payloads
- A small validation script and tests that future SDKs can reuse in CI
- The first public Rust SDK package with buffered event capture, transport-friendly flush/shutdown semantics, and optional HTTP delivery
- The first public JavaScript SDK package with zero-build install UX, W3C trace context helpers, opt-in console capture, Pino destination support, Winston transport support, and the same public event model
- The first public Browser integration package with page-view, error, unhandled-rejection, fetch transport, and target-scoped W3C `traceparent` propagation UX on top of the JavaScript SDK
- The first public Node.js integration package with `node:http` handler UX, server-side key setup, query-safe request/error metadata, and W3C `traceparent` request-span continuation on top of the JavaScript SDK
- The first public Express integration package with middleware, error-handler UX, server-side key setup, query-safe request/error metadata, and W3C `traceparent` request-span continuation on top of the JavaScript SDK
- The first public Fastify integration package with plugin/hook UX, server-side key setup, query-safe request/error metadata, and W3C `traceparent` request-span continuation on top of the JavaScript SDK
- The first public NestJS integration package with interceptor UX, server-side key setup, query-safe request/error metadata, and W3C `traceparent` request-span continuation on top of the JavaScript SDK
- The first public Angular integration package with provider/injection UX, frontend `clientKey` setup, and target-scoped W3C `traceparent` propagation on top of the JavaScript SDK
- The first public Vue integration package with plugin/composable UX, frontend `clientKey` setup, and target-scoped W3C `traceparent` propagation on top of the JavaScript SDK
- The first public Svelte integration package with context/error-helper UX, frontend `clientKey` setup, and target-scoped W3C `traceparent` propagation on top of the JavaScript SDK
- The first public React integration package with provider/hook UX, scoped error-boundary capture, frontend `clientKey` setup, and target-scoped W3C `traceparent` propagation on top of the JavaScript SDK
- The first public Next.js integration package with App Router Route Handler UX, server-side key setup, W3C `traceparent` request-span continuation, and query-safe error metadata defaults on top of the JavaScript SDK
- The first public React Native integration package with mobile screen/app-state UX, handled error capture, mobile `clientKey` setup, and target-scoped W3C `traceparent` propagation on top of the JavaScript SDK
- The first public Python SDK package with `pyproject.toml` packaging, W3C trace context helpers, dependency-free HTTP delivery, and a fresh-venv install path
- The first public FastAPI integration package with middleware UX on top of the Python SDK
- The first public Django integration package with middleware UX on top of the Python SDK
- The first public Go SDK package with a standard Go module install path, W3C trace context helpers, dependency-free HTTP delivery, and temp-module smoke coverage
- The first public C SDK package with source/header packaging and temp-native-app smoke coverage
- The first public C++ SDK package with RAII source/header packaging and temp-native-app smoke coverage
- The first public Objective-C SDK package with Foundation source/header packaging and temp-native-app smoke coverage
- The first public Java SDK package with JDK toolchain package checks, dependency-free HTTP delivery, JUL handler support, optional Logback appender support, Spring Boot smoke coverage, and temp-classpath smoke coverage
- The first public .NET SDK package with NuGet packing, dependency-free HTTP delivery, `Microsoft.Extensions.Logging` provider support, and fresh-console-app smoke coverage
- The first public Unity SDK package with UPM metadata, source-only runtime, dependency-free HTTP delivery, and temp-project smoke coverage
- The first public Kotlin SDK package with Android helper APIs, Android `Log` priority helpers, throwable-safe capture, dependency-free HTTP delivery, and Gradle/JVM smoke coverage
- The first public Ruby SDK package with gem packaging, dependency-free HTTP delivery, standard `Logger` support, Rack/Rails-compatible middleware, Rails error subscriber support, and temp-gem-home smoke coverage
- The first public Swift SDK package with SwiftPM packaging, Swift Testing coverage, Apple-style logger ergonomics, dependency-free HTTP delivery, and temp-app smoke coverage
- The first public PHP SDK package with Composer artifact-install smoke coverage, dependency-free HTTP delivery, and PSR-3 logger support
- A readiness checklist for shipping public SDKs safely

The repo intentionally excludes backend, infrastructure, storage, deployment, and private operational details.

## Event contract

The canonical payload shape lives in [`spec/event-batch.schema.json`](spec/event-batch.schema.json).

Each SDK should serialize an event batch as JSON with:

- `sdk`: client metadata
- `events`: one or more typed events

Supported event types:

- `release`
- `environment`
- `issue`
- `log`
- `span`
- `action`

## Public QA fixtures

Fixtures live in [`fixtures/`](fixtures/).

- `valid-batch.json` shows a happy-path batch using only fake placeholder values
- `invalid-batch.json` shows a validation failure case

## Validation

Run the contract checks with Python standard library only:

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/validate_fixtures.py fixtures/valid-batch.json
python3 scripts/validate_fixtures.py fixtures/invalid-batch.json --expect-invalid
python3 scripts/validate_fixtures.py fixtures/valid-batch.json --json
```

The validator can emit stable JSON for CI and automation consumers:

```json
{"ok": true, "fixture": "fixtures/valid-batch.json", "message": "valid"}
```

## Repo Verification

Run the full public-SDK verification path with one command:

```bash
bash scripts/check_public_sdks.sh
python3 scripts/check_release_metadata.py
python3 scripts/check_markdown_links.py
bash scripts/check_shell_static.sh
```

For automation or CI consumers that want a machine-readable result:

```bash
bash scripts/check_public_sdks.sh --json
bash scripts/check_public_sdks.sh --json-out=/tmp/logbrew-sdk-checks.json
```

In `--json` mode, the script writes the JSON object to stdout and sends human progress logs to stderr so automation can parse stdout directly.

When JSON mode fails, it returns a non-zero exit code and emits a parseable failure object with the completed-step count, the full step-label list, the completed-step labels, and the last step label reached.
If another verifier run is already active, JSON mode returns a structured failure instead of racing shared build directories.
The full verifier also runs `python3 scripts/check_release_metadata.py` so package names, versions, licenses, repository URLs, README presence, runtime requirements, and ecosystem-specific publish metadata cannot drift silently, `python3 scripts/check_markdown_links.py` so local README and docs links stay valid, plus `bash scripts/check_shell_static.sh`, which downloads pinned ShellCheck release assets into a temp directory, verifies their SHA-256 digest, and checks every public smoke/package shell script at style severity with only narrow exclusions for intentional inline-language and virtualenv activation patterns.

Current JSON fields:

- `schema_version`
- `ok`
- `steps_completed`
- `steps_total`
- `message`
- `step_labels`
- `completed_step_labels`
- `toolchain_versions`
- `started_at`
- `finished_at`
- `duration_ms`
- `failure_reason` when a run fails with a stable machine-readable category
- `exit_code` when a run fails
- `failed_step_number` when a step fails after execution starts
- `failed_step_label` when a step fails after execution starts

The JSON payload also captures the first-line version strings for the toolchains used during that verifier run, including Node.js, npm, pnpm, C/C++/Objective-C compilers, Make, Python, pip, Go, Java, javac, jar, jdeps, .NET, Kotlin, Gradle, Ruby, RubyGems, Bundler, Swift, SwiftFormat, SwiftLint, Cargo, rustc, PHP, and Composer. That makes it easier to tie a future regression back to a language, runtime, compiler, formatter, linter, or package-manager change instead of treating every red gate as an SDK logic change first.

That script runs the shared contract checks, release metadata consistency checks, every current SDK test suite, C, C++, and Objective-C source/header package checks, Rust and JavaScript package dry-runs, Java compile/package/Javadoc checks, .NET NuGet package checks, Unity UPM package checks, Kotlin jar/Maven metadata checks, Ruby gem package checks, Swift style and package archive checks, every real-user smoke path, the Browser, Node.js, Express, Fastify, NestJS, Angular, Vue, Svelte, React, React Native, and Next.js integration smoke paths, the Python, FastAPI, and Django packaging checks, the PHP Composer checks, workflow YAML validation, and the confidentiality leak scan.
Each real-user smoke path now proves a successful full-batch install/run flow, an empty-flush no-op path, a validation-failure path, a clean unauthenticated failure path, a retry-then-success transport path, a retry-budget failure path, a non-retryable transport-status failure path, and post-shutdown rejection of new work from a fresh temp project.
It also removes the generated Python and Composer build artifacts before exiting so a normal verifier run does not dirty the public worktree.

## Rust SDK

The first installable SDK package lives in [`rust/logbrew`](rust/logbrew).

Useful commands:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --features http -- -D warnings
cargo test
cargo test --features http
cargo publish --dry-run --allow-dirty -p logbrew
cd rust/logbrew/examples && make
cd rust/logbrew/examples && make run-readme-example
cd rust/logbrew/examples && make run
cd rust/logbrew/examples && make run-real-user-smoke
cargo run --example readme_example -p logbrew
cargo run --example real_user_smoke -p logbrew
bash scripts/real_user_rust_smoke.sh
```

The smoke script creates a temporary Cargo app, packages the crate artifact, proves the packaged `README.md`, `Cargo.toml`, and shipped example surface keep the expected user-facing guidance, including `cargo add logbrew --features http`, `examples/readme_example.rs`, `examples/real_user_smoke.rs`, and a tiny `examples/Makefile` wrapper, runs the shipped README example directly from the extracted crate artifact through raw `cargo run --example readme_example` and through `make run-readme-example`, then runs the stronger shipped example both through raw `cargo run --example real_user_smoke` and the shipped helper commands, now including a discoverable plain `make` path whose output prints copy-pasteable commands for both example flows while still labeling `make run` as the shorter real-user smoke alias, and proves the packaged README itself teaches that helper surface instead of leaving it implicit, before the helper paths execute the examples, proves a separate temp lifecycle app can add the extracted crate through `cargo add --path`, remove it cleanly with `cargo remove logbrew`, verify that `Cargo.toml`, `Cargo.lock`, locked metadata, and the dependency tree all drop the crate, and then add it back again, then adds the extracted packaged crate contents to the main temp app through `cargo add --path`, proves the rewritten `Cargo.toml` entry, proves normal Cargo resolution by generating `Cargo.lock`, checking the expected temp-app and local `logbrew` lockfile entries, checking resolved package metadata and version, proving that `cargo pkgid logbrew` reports the resolved crate identity, that `cargo metadata --locked` reports the resolved root package plus the `smoke-app -> logbrew` dependency edge, proving that `cargo tree --locked --depth 1 --charset ascii` still shows the temp app root and direct `logbrew` child, and that `cargo fetch --locked`, `cargo check --locked`, `cargo build --locked`, `cargo test --locked`, repo-checkout `cargo fmt --check`, strict default and `http` feature clippy/test paths, and later doc and runtime commands all succeed under the public gate, including through a temp `.cargo/config.toml` alias layer that a consumer can keep around, checking a dependency-tree view for the temp app, rendering crate docs through `cargo doc --locked --package logbrew --no-deps`, including the `LogBrewClient`, `ClientBuilder`, `SdkError`, `Transport`, `RecordingTransport`, `TransportResponse`, and `TransportError` symbol pages plus the public batch-shape and event-builder pages and field-level docs for key response and payload structs, explicitly reruns a temp binary that mirrors the published README example, then runs a full successful batch, verifies the empty-flush no-op path, verifies a stable validation failure, proves the unauthenticated error path, proves retry recovery, proves retry-budget failure behavior, proves non-retryable transport-status failure behavior, confirms post-shutdown rejection like a user would, and creates a separate feature-enabled temp app that documents `DEFAULT_HTTP_ENDPOINT`, `HttpTransportConfig`, and `HttpTransport` before proving installed-artifact HTTP delivery against a local intake with 5xx-to-2xx retry behavior.

## JavaScript SDK

The first installable JavaScript SDK package lives in [`js/logbrew-js`](js/logbrew-js).

Useful commands:

```bash
python3 scripts/check_js_sources.py
bash scripts/check_js_lint.sh
bash scripts/check_js_package.sh
cd js/logbrew-js && npm test
cd js/logbrew-js/examples && npm run
cd js/logbrew-js/examples && npm run help
cd js/logbrew-js/examples && npm run list
cd js/logbrew-js/examples && pnpm run
cd js/logbrew-js/examples && pnpm run list
cd js/logbrew-js/examples && pnpm run help
cd js/logbrew-js/examples && npm run readme-example
cd js/logbrew-js/examples && npm run readme-example:cjs
cd js/logbrew-js/examples && npm run real-user-smoke
cd js/logbrew-js/examples && npm run real-user-smoke:cjs
cd js/logbrew-js && node examples/index.mjs --help
cd js/logbrew-js && node examples/index.mjs --list
cd js/logbrew-js && node examples/index.mjs readme-example
cd js/logbrew-js && node examples/index.mjs readme-example:cjs
cd js/logbrew-js && node examples/index.mjs real-user-smoke
cd js/logbrew-js && node examples/index.mjs
cd js/logbrew-js && node examples/index.mjs real-user-smoke:cjs
cd js/logbrew-js && node examples/readme-example.mjs
cd js/logbrew-js && node examples/readme-example.cjs
cd js/logbrew-js && node examples/real-user-smoke.mjs
cd js/logbrew-js && node examples/real-user-smoke.cjs
cd js/logbrew-js && npm run smoke
bash scripts/real_user_js_smoke.sh
cd js/logbrew-js && npm pack --dry-run
```

The focused public verifier runs `python3 scripts/check_js_sources.py`, `bash scripts/check_js_lint.sh`, and `bash scripts/check_js_package.sh` before the JavaScript package dry-runs so every repo-checkout `.js`, `.cjs`, and `.mjs` file, including framework integration packages, is checked with Node's syntax checker, a strict ESLint ruleset, and strict publint package-publishing validation before package and real-user smoke paths run. The ESLint and publint gates install exact tooling into throwaway temp directories, which keeps linting strict without leaving `node_modules` or lockfiles in the public worktree.
The JavaScript smoke script creates temporary apps through package-manager-native bootstrap, using `npm init -y` on the npm path and `pnpm init` on the pnpm path, inspects the packed tarball before install, proves npm's own `npm pack --dry-run --json` and `npm pack --json` metadata for the tarball name, integrity, shasum, and shipped file list, installs that tarball through both `npm` and `pnpm`, proves normal install artifacts like rewritten `package.json` dependency entries, lockfiles, resolved tarball targets, integrity metadata, dependency-tree resolution, generated script entries for installed-user checks, plain dependency-tree output through `npm ls @logbrew/sdk` and `pnpm ls @logbrew/sdk`, direct consumer dependency edges through `npm explain @logbrew/sdk` and `pnpm why @logbrew/sdk`, plain package-manager list output through `npm list --depth=0` and `pnpm list --depth=0`, and structured package-manager package lists through `npm list --json --depth=0` and `pnpm list --json --depth=0`, proves that the temp app survives package-manager-native removal through `npm uninstall @logbrew/sdk` and `pnpm remove @logbrew/sdk` before the tarball is added back, proves that the generated lockfiles keep the same tarball integrity value reported by `npm pack --json` before recreating the install through `npm ci` and `pnpm install --frozen-lockfile`, reproves the same package-manager graph, tree, and package-list output after reinstall, proves the packed and installed package metadata, shipped README payload, explicit ESM/CommonJS `exports` map, runnable packaged example files, the shipped `examples/package.json` helper surface, the shipped `examples/index.mjs` launcher, and declaration comments in `index.d.ts` plus the CommonJS `index.d.cts`, including packed and installed README install commands, explicit launcher discovery commands, and fake-placeholder guidance plus event attribute types, error, transport, lifecycle helpers, W3C trace context helpers, optional console capture, Pino destination, and Winston transport helpers, and field-level docs for transport responses and recorded request bodies, proves the shipped TypeScript declarations compile through generated ESM `.ts` and CommonJS `.cts` consumer files in a real app, proves installed-user test and runtime scripts through `npm run` and `pnpm run`, explicitly reruns a script that mirrors the published README example before and after reinstall, runs the packaged README-style and stronger `real-user-smoke` ESM and CommonJS example files directly from `node_modules/@logbrew/sdk/examples/`, proves the installed Node launcher through `--help`, `--list`, the default no-argument path, and named selection, proves the installed example helper scripts from `node_modules/@logbrew/sdk/examples/package.json`, including plain `npm ... run` and `pnpm ... run` listing output plus a discoverable `help` script whose output includes copy-pasteable npm and pnpm installed-user commands for both the README and `real-user-smoke` paths before their explicit ESM and CommonJS variants, and proves that the packaged README teaches those launcher commands explicitly instead of leaving them implicit in the longer prose, before proving both ESM `import` and CommonJS `require` entrypoints, explicit `parseTraceparent()`/`createTraceparent()`/`spanAttributesFromTraceparent()` behavior for OpenTelemetry-compatible trace propagation, opt-in `installLogBrewConsoleCapture()` behavior from the installed package, real Pino `warn`/`error` capture through `createLogBrewPinoDestination()`, real Winston `warn`/`error` capture through `createLogBrewWinstonTransport()`, running a full successful batch, verifying the empty-flush no-op path, verifying a stable validation failure, verifying the unauthenticated error path, proving retry recovery, proving retry-budget failure behavior, proving non-retryable transport-status failure behavior, and confirming post-shutdown rejection like a user would.

## Browser Integration

The first Browser integration package lives in [`js/logbrew-browser`](js/logbrew-browser).

Useful commands:

```bash
python3 scripts/check_js_sources.py
bash scripts/check_js_lint.sh
cd js/logbrew-browser && npm test
cd js/logbrew-browser && npm pack --dry-run
bash scripts/real_user_browser_smoke.sh
```

The Browser smoke script packs both `@logbrew/sdk` and `@logbrew/browser`, installs them into a fresh npm app with current `happy-dom`, verifies npm package graph/list metadata, exercises `installLogBrewBrowser()` against a browser-like `Window` using browser-scoped `clientKey` setup, captures an initial page-view span, captures synchronous `error` events, captures `unhandledrejection` events, proves query string and hash data are excluded from metadata by default, proves document title and user agent are opt-in, proves queued events flush on `pagehide` and hidden `visibilitychange`, proves listener `uninstall()` behavior, verifies the fetch transport uses `POST` with keepalive, proves target-scoped W3C `traceparent` propagation through `createTraceparentFetch()` without global fetch patching or unrelated-origin headers, typechecks a strict DOM TypeScript consumer, verifies the CommonJS entry, validates emitted event JSON against the shared contract/parity fixture, and runs packaged example launcher plus helper commands from `node_modules/@logbrew/browser/examples`.

## Node.js Integration

The first Node.js integration package lives in [`js/logbrew-node`](js/logbrew-node).

Useful commands:

```bash
python3 scripts/check_js_sources.py
bash scripts/check_js_lint.sh
cd js/logbrew-node && npm test
cd js/logbrew-node && npm pack --dry-run
bash scripts/real_user_node_smoke.sh
```

The Node.js smoke script packs both `@logbrew/sdk` and `@logbrew/node`, installs them into a fresh npm app with Node's built-in `node:http` runtime, verifies npm package graph/list metadata, starts real HTTP servers, exercises `withLogBrewHttpHandler()`, request-local `req.logbrew`, server-side `serverApiKey` setup plus `LOGBREW_SERVER_API_KEY` env fallback while preserving lower-level `apiKey` compatibility, automatic request capture, valid inbound W3C `traceparent` request-span continuation with deterministic test span ids, query-string omission from request/error metadata, thrown-handler error capture with a fallback `500`, manual error capture, and `createNodeFetchTransport()` delivery against a local HTTP intake with retry behavior, validates emitted event JSON against the shared contract/parity fixture, typechecks a strict TypeScript consumer using `@types/node` and request event narrowing, verifies the CommonJS entry, and runs packaged example launcher plus helper commands from `node_modules/@logbrew/node/examples`.

## Express Integration

The first Express integration package lives in [`js/logbrew-express`](js/logbrew-express).

Useful commands:

```bash
python3 scripts/check_js_sources.py
bash scripts/check_js_lint.sh
cd js/logbrew-express && npm test
cd js/logbrew-express && npm pack --dry-run
bash scripts/real_user_express_smoke.sh
```

The Express smoke script packs both `@logbrew/sdk` and `@logbrew/express`, installs them into a fresh npm app with current `express`, verifies npm package graph/list metadata, starts a real Express server, exercises request middleware and error-handler middleware through actual HTTP requests, validates emitted event JSON against the shared contract/parity fixture, proves server-side `serverApiKey` setup while preserving lower-level `apiKey` compatibility, proves automatic request capture and async error capture, proves query-string omission from request/error metadata, proves valid inbound W3C `traceparent` headers turn automatic request capture into continued span events with deterministic test span ids, typechecks a strict TypeScript consumer using Express request augmentation and request event narrowing, verifies the CommonJS entry, and runs packaged example launcher plus helper commands from `node_modules/@logbrew/express/examples`. The package follows Express middleware conventions: normal middleware uses `(req, res, next)`, error middleware uses `(err, req, res, next)`, and the LogBrew error handler captures then passes errors onward to the app's own response handler.

## Fastify Integration

The first Fastify integration package lives in [`js/logbrew-fastify`](js/logbrew-fastify).

Useful commands:

```bash
python3 scripts/check_js_sources.py
bash scripts/check_js_lint.sh
cd js/logbrew-fastify && npm test
cd js/logbrew-fastify && npm pack --dry-run
bash scripts/real_user_fastify_smoke.sh
```

The Fastify smoke script packs both `@logbrew/sdk` and `@logbrew/fastify`, installs them into a fresh npm app with current `fastify`, verifies npm package graph/list metadata, starts a real Fastify server, exercises `onRequest`, `onResponse`, and `onError` hook behavior through actual HTTP requests, validates emitted event JSON against the shared contract/parity fixture, proves server-side `serverApiKey` setup while preserving lower-level `apiKey` compatibility, proves automatic request capture and async error capture, proves query-string omission from request/error metadata, proves valid inbound W3C `traceparent` headers turn automatic request capture into continued span events with deterministic test span ids, typechecks a strict TypeScript consumer using Fastify request augmentation and request event narrowing, verifies the CommonJS entry, and runs packaged example launcher plus helper commands from `node_modules/@logbrew/fastify/examples`. The package wraps its plugin with `fastify-plugin` so normal `app.register(logbrewFastifyPlugin)` usage decorates the app routes users define afterward instead of surprising them with Fastify plugin encapsulation.

## NestJS Integration

The first NestJS integration package lives in [`js/logbrew-nestjs`](js/logbrew-nestjs).

Useful commands:

```bash
python3 scripts/check_js_sources.py
bash scripts/check_js_lint.sh
cd js/logbrew-nestjs && npm test
cd js/logbrew-nestjs && npm pack --dry-run
bash scripts/real_user_nestjs_smoke.sh
```

The NestJS smoke script packs both `@logbrew/sdk` and `@logbrew/nestjs`, installs them into a fresh npm app with current `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `reflect-metadata`, and `rxjs`, verifies npm package graph/list metadata, starts real Nest HTTP apps, exercises `LogBrewInterceptor` through actual controller requests, validates emitted event JSON against the shared contract/parity fixture, proves server-side `serverApiKey` setup while preserving lower-level `apiKey` compatibility, proves automatic request capture, valid inbound W3C `traceparent` request-span continuation with deterministic test span ids, malformed-header log fallback, query-string omission from request/error metadata, async error capture, typechecks a strict TypeScript consumer using Express request augmentation through `request.logbrew` and request-event narrowing, verifies the CommonJS entry, and runs packaged example launcher plus helper commands from `node_modules/@logbrew/nestjs/examples`. The interceptor captures failures with RxJS `catchError`, then rethrows them so Nest's normal exception handling still owns the response.

## Angular Integration

The first Angular integration package lives in [`js/logbrew-angular`](js/logbrew-angular).

Useful commands:

```bash
python3 scripts/check_js_sources.py
bash scripts/check_js_lint.sh
cd js/logbrew-angular && npm test
cd js/logbrew-angular && npm pack --dry-run
bash scripts/real_user_angular_smoke.sh
```

The Angular smoke script packs both `@logbrew/sdk` and `@logbrew/angular`, installs them into a fresh npm app with current `@angular/core`, `@angular/compiler`, `rxjs`, and `zone.js`, verifies npm package graph/list metadata, exercises Angular's real dependency-injection APIs through `provideLogBrew()`, `LOG_BREW_ANGULAR_CONTEXT`, and `injectLogBrew()`, validates emitted event JSON against the shared contract/parity fixture, proves view-helper behavior, proves Angular `ErrorHandler` capture while delegating to an app-owned handler, typechecks a strict TypeScript consumer, verifies the CommonJS entry, and runs packaged example launcher plus helper commands from `node_modules/@logbrew/angular/examples`.

## Vue Integration

The first Vue integration package lives in [`js/logbrew-vue`](js/logbrew-vue).

Useful commands:

```bash
python3 scripts/check_js_sources.py
bash scripts/check_js_lint.sh
cd js/logbrew-vue && npm test
cd js/logbrew-vue && npm pack --dry-run
bash scripts/real_user_vue_smoke.sh
```

The Vue smoke script packs both `@logbrew/sdk` and `@logbrew/vue`, installs them into a fresh npm app with current `vue` and `@vue/server-renderer`, verifies npm package graph/list metadata, renders plugin and composable flows through Vue SSR, validates emitted event JSON against the shared contract/parity fixture, proves view-helper behavior, proves Vue component error capture while preserving any existing `app.config.errorHandler`, typechecks a strict TypeScript consumer, verifies the CommonJS entry, and runs packaged example launcher plus helper commands from `node_modules/@logbrew/vue/examples`.

## Svelte Integration

The first Svelte integration package lives in [`js/logbrew-svelte`](js/logbrew-svelte).

Useful commands:

```bash
python3 scripts/check_js_sources.py
bash scripts/check_js_lint.sh
cd js/logbrew-svelte && npm test
cd js/logbrew-svelte && npm pack --dry-run
bash scripts/real_user_svelte_smoke.sh
```

The Svelte smoke script packs both `@logbrew/sdk` and `@logbrew/svelte`, installs them into a fresh npm app with current `svelte`, verifies npm package graph/list metadata, compiles real Svelte 5 server components through `svelte/compiler`, renders them with `svelte/server`, validates emitted event JSON against the shared contract/parity fixture, proves context setup and missing-context errors, proves Svelte error capture, typechecks a strict TypeScript consumer, verifies the CommonJS entry, and runs packaged example launcher plus helper commands from `node_modules/@logbrew/svelte/examples`.

## React Integration

The first React integration package lives in [`js/logbrew-react`](js/logbrew-react).

Useful commands:

```bash
python3 scripts/check_js_sources.py
bash scripts/check_js_lint.sh
cd js/logbrew-react && npm test
cd js/logbrew-react && npm pack --dry-run
bash scripts/real_user_react_smoke.sh
```

The React smoke script packs both `@logbrew/sdk` and `@logbrew/react`, installs them into a fresh npm app with current `react`, `react-dom`, and `react-test-renderer`, proves npm dependency graph/list metadata, renders provider and hook flows through `react-dom/server`, proves `LogBrewErrorBoundary` capture through a real React renderer with component-stack metadata and raw stack text omitted by default, proves handled Error/non-Error helper capture plus stack opt-in, proves frontend `clientKey` setup plus target-scoped W3C `traceparent` propagation through `createTraceparentFetch()` without global fetch patching or unrelated-origin headers, typechecks a strict TypeScript consumer with React, error-helper, and trace target types, verifies the CommonJS trace and error helper surface, validates emitted event JSON against the shared contract/parity fixture, and runs packaged example launcher plus helper commands from `node_modules/@logbrew/react/examples`.

## React Native Integration

The first React Native integration package lives in [`js/logbrew-react-native`](js/logbrew-react-native).

Useful commands:

```bash
python3 scripts/check_js_sources.py
bash scripts/check_js_lint.sh
cd js/logbrew-react-native && npm test
cd js/logbrew-react-native && npm pack --dry-run
bash scripts/real_user_react_native_smoke.sh
```

The React Native smoke script packs both `@logbrew/sdk` and `@logbrew/react-native`, installs them into a fresh npm app with current `react`, `react-native`, and `react-test-renderer`, verifies npm package graph/list metadata, proves the package ships a Metro-facing `react-native` entry while keeping the default Node entry runnable, renders provider/hook flows through `react-test-renderer`, proves mobile `clientKey` setup plus target-scoped W3C `traceparent` propagation through `createTraceparentFetch()` without global fetch patching or unrelated-origin headers, typechecks a strict TypeScript consumer using React Native app-state, handled-error, and trace target types, validates emitted mobile event JSON against the shared contract, proves screen-view and app-state capture helpers, proves handled `Error` and non-`Error` issue capture with stack text omitted by default and opt-in only, verifies the CommonJS entry and default export, and runs packaged example launcher plus helper commands from `node_modules/@logbrew/react-native/examples`. The package intentionally accepts `Platform` and `AppState` by dependency injection in its default entry, with a separate `index.native.js` for Metro, because React Native source packages are not directly importable in plain Node.

## Next.js Integration

The first Next.js integration package lives in [`js/logbrew-next`](js/logbrew-next).

Useful commands:

```bash
python3 scripts/check_js_sources.py
bash scripts/check_js_lint.sh
cd js/logbrew-next && npm test
cd js/logbrew-next && npm pack --dry-run
bash scripts/real_user_next_smoke.sh
```

The Next.js smoke script packs both `@logbrew/sdk` and `@logbrew/next`, installs them into a fresh npm app with current `next`, `react`, and `react-dom`, verifies npm package graph/list metadata, builds a real App Router app with `next build`, invokes the installed Route Handler wrapper through standard `Request`/`Response` objects, validates emitted event JSON against the shared contract/parity fixture, proves server-side `serverApiKey` setup while preserving lower-level `apiKey` compatibility, proves retry-backed flushing, error capture, default request capture, valid inbound W3C `traceparent` request-span continuation with deterministic test span ids, malformed-header log fallback, query-string omission from error metadata by default plus explicit `includeSearchParams` opt-in, safe `onCaptureError` behavior when telemetry delivery fails, typechecks a strict TypeScript consumer with request-event narrowing, and runs packaged example launcher plus helper commands from `node_modules/@logbrew/next/examples`. The package targets App Router Route Handlers and follows the Next.js 16 `proxy.js` naming change by not relying on deprecated middleware naming or `NextResponse.next()` inside route handlers.

## Python SDK

The first installable Python SDK package lives in [`python/logbrew_py`](python/logbrew_py).

Useful commands:

```bash
python3 scripts/check_python_sources.py
bash scripts/check_python_static.sh
PYTHONPATH=python/logbrew_py/src python3 -m unittest discover -s python/logbrew_py/tests -p 'test_*.py'
PYTHONPATH=python/logbrew_py/src python3 -m logbrew_sdk.examples --help
PYTHONPATH=python/logbrew_py/src python3 -m logbrew_sdk.examples --list
PYTHONPATH=python/logbrew_py/src python3 -m logbrew_sdk.examples readme-example
PYTHONPATH=python/logbrew_py/src python3 -m logbrew_sdk.examples real-user-smoke
PYTHONPATH=python/logbrew_py/src python3 -m logbrew_sdk.examples
PYTHONPATH=python/logbrew_py/src python3 python/logbrew_py/examples/readme_example.py
PYTHONPATH=python/logbrew_py/src python3 -m logbrew_sdk.examples.readme_example
PYTHONPATH=python/logbrew_py/src python3 -m logbrew_sdk.examples.real_user_smoke
PYTHONPATH=python/logbrew_py/src python3 python/logbrew_py/examples/real_user_smoke.py
bash scripts/real_user_python_smoke.sh
cd python/logbrew_py && python3 -m build
cd python/logbrew_py && python3 -m twine check "dist/*"
```

The Python smoke script creates fresh virtual environments, builds both the wheel and source distribution, inspects both archives before install, installs each through `pip`, proves the installed package metadata a user sees through `pip show`, `pip show -f`, `pip list --format=json`, `pip freeze`, `importlib.metadata`, and pip-written `INSTALLER`, `direct_url.json`, `--report`, and `pip inspect` provenance records, including the expected plain `pip show` package summary fields, proves the installed environments stay clean under `python -m pip check`, proves that both the wheel and source-distribution paths survive a clean `python -m pip uninstall -y logbrew-sdk` removal before reinstalling the same artifact, proves the repo Python sources compile in memory through `python3 scripts/check_python_sources.py` and pass temp-installed Ruff plus strict Mypy through `bash scripts/check_python_static.sh` before focused package tests, proves a consumer-owned temp `Makefile` can wrap installed-user `mypy`, `unittest`, README-example, packaged-example, packaged examples list, packaged examples help, packaged examples entrypoint, packaged real-user example, and happy-path smoke commands, explicitly reruns those flows through that Makefile on the main install and reinstall paths, and now proves plain `make` itself is the discoverable entrypoint by printing copy-pasteable `make smoke-...` commands, with the shorter `make smoke-run` path labeled explicitly as the `real-user-smoke` flow. It also proves that the packaged examples surface is discoverable through `python -m logbrew_sdk.examples --help`, `python -m logbrew_sdk.examples --list`, and named selection through the same entrypoint, with both help and list output now printing copy-pasteable packaged-example commands, including explicit named `readme-example` and `real-user-smoke` entrypoint commands plus the default `python -m logbrew_sdk.examples` entrypoint being labeled explicitly as the `real-user-smoke` path, and proves that the packaged README teaches those example-entrypoint commands explicitly instead of leaving them implicit in the longer prose, before proving that the generated freeze output can recreate each install in a fresh virtual environment, that a one-line direct requirements file derived from that freeze output also reinstalls cleanly under `python -m pip install --require-hashes -r ...`, key installed payload files like `py.typed`, the packaged example modules, and dist-info metadata plus installed README-derived guidance in `METADATA`, pip's own installed file listing for the expected module and dist-info payload, pip's structured installed-package list for the expected `logbrew-sdk` entry and version, the installed module, public payload shape types, `LogBrewClient`, `HttpTransport`, `LogBrewLoggingHandler`, `RecordingTransport`, `SdkError`, `TransportResponse`, `TransportError`, and lifecycle method docstrings a user sees through normal Python introspection, field-level typing metadata for key response and transport attributes, the shipped typing metadata in a real typed consumer through a temp `pyproject.toml`-driven mypy config, standard-library `logging` handler capture with primitive `extra` metadata and exception metadata without full source paths by default, installed `HttpTransport` delivery against a local HTTP intake with retry behavior, and then runs a full successful batch, verifies the empty-flush no-op path, verifies a stable validation failure, verifies the unauthenticated error path, proves retry recovery, proves retry-budget failure behavior, proves non-retryable transport-status failure behavior, and confirms post-shutdown rejection like a user would.

## FastAPI Integration

The first FastAPI integration package lives in [`python/logbrew_fastapi`](python/logbrew_fastapi).

Useful commands:

```bash
python3 scripts/check_python_sources.py
bash scripts/check_python_static.sh
bash scripts/check_fastapi_package.sh
bash scripts/real_user_fastapi_smoke.sh
cd python/logbrew_fastapi && python3 -m build
cd python/logbrew_fastapi && python3 -m twine check "dist/*"
```

The FastAPI package ships typed middleware and helpers through `logbrew_fastapi`. `add_logbrew_middleware()` records successful requests as span events, unhandled handler exceptions as issue plus error-span events, and flushes through the supplied transport after each response. If no transport is provided, events stay queued on the core Python client for user-owned flushing. Transport failures are swallowed by default so observability does not break the response path, while `raise_flush_errors=True` lets test environments fail loudly.

The FastAPI smoke script builds both `logbrew-sdk` and `logbrew-fastapi`, installs them into a fresh virtual environment with current FastAPI and Starlette dependencies, validates package metadata and `pip check`, runs a real `FastAPI` app through `TestClient`, proves `/health` and exception routes emit the expected span/issue/span event sequence, proves valid inbound W3C `traceparent` continuation with deterministic child span IDs, query omission, and malformed-header synthetic span fallback, validates the emitted body against the shared contract, typechecks a strict installed consumer, and runs the packaged example entrypoint commands.

## Django Integration

The first Django integration package lives in [`python/logbrew_django`](python/logbrew_django).

Useful commands:

```bash
python3 scripts/check_python_sources.py
bash scripts/check_python_static.sh
bash scripts/check_django_package.sh
bash scripts/real_user_django_smoke.sh
cd python/logbrew_django && python3 -m build
cd python/logbrew_django && python3 -m twine check "dist/*"
```

The Django package ships typed middleware and helpers through `logbrew_django`. `LogBrewDjangoMiddleware` records successful requests as span events, records unhandled view exceptions through Django's `process_exception()` path as issue events, adds the final 500 response as an error span, and flushes through the configured transport after each response. `configure_logbrew()` is the simplest startup hook for passing the core Python client and transport into Django without forcing a project-specific settings layout.

The Django smoke script builds both `logbrew-sdk` and `logbrew-django`, installs them into a fresh virtual environment with current Django, validates package metadata and `pip check`, runs a real Django test client against in-memory URL patterns, proves `/health/` and exception routes emit the expected span/issue/span event sequence, proves valid inbound W3C `traceparent` continuation with deterministic child span IDs, query omission, and malformed-header synthetic span fallback, validates the emitted body against the shared contract, typechecks a strict installed consumer, and runs the packaged example entrypoint commands.

## Go SDK

The first installable Go SDK package lives in [`go/logbrew`](go/logbrew).

Useful commands:

```bash
cd go/logbrew && test -z "$(gofmt -l .)"
cd go/logbrew && go vet ./...
cd go/logbrew && go test ./...
bash scripts/check_go_static.sh
cd go/logbrew/examples && make
cd go/logbrew/examples && make run-readme-example
cd go/logbrew/examples && make run
cd go/logbrew/examples && make run-real-user-smoke
cd go/logbrew && go run ./examples/readme_example
cd go/logbrew && go run ./examples/real_user_smoke
bash scripts/real_user_go_smoke.sh
```

The Go smoke script creates a temporary module through `go mod init`, generates a local file-backed module proxy artifact for `v0.1.0`, proves the proxy `.info`, `.mod`, and `.zip` files plus the installed module cache keep the expected metadata, shipped example files, and README install, trace-helper, and helper guidance, runs the shipped README example directly from the extracted module artifact through raw `go run ./examples/readme_example`, then proves the downloaded `examples/Makefile` gives users one discoverable helper surface for both shipped example flows, with plain `make` printing copy-pasteable `make run-readme-example`, `make run`, and `make run-real-user-smoke` commands before the README example runs through `make run-readme-example` and the stronger real-user path runs through `make run` or `make run-real-user-smoke`. It also keeps proving the nested `examples/real_user_smoke/Makefile` smoke-only helper, then proves a separate temp lifecycle module can remove the SDK with `go get github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew@none` and add it back with `go get ...@v0.1.0`, resolves the SDK through its normal module path without a workspace `replace`, adds it through `go get`, runs `go mod tidy`, proves the temp app keeps the expected `go.mod` requirement and `go.sum` hash entries, proves the downloaded module cache passes `go mod verify`, proves Go's own `go mod download -json` output keeps the expected info, mod, zip, extracted-dir, and checksum metadata for the installed SDK artifact, proves both `go list -m all` and `go list -m -json all` keep the expected temp-app root plus installed `github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew v0.1.0` module entry, proves `go list -deps -json ./...` keeps the expected `smoke-app` package entry plus the installed `logbrew` dependency package metadata, proves a built temp-app binary keeps the expected embedded module metadata through `go version -m`, proves that later `go build`, `go test`, `go vet`, `go list`, `go doc`, and `go run` checks all succeed under `-mod=readonly`, while repo-checkout `test -z "$(gofmt -l .)"`, `go vet ./...`, `go test ./...`, and temp-installed `staticcheck ./...` now run in the public verifier, including through a temp `Makefile` that a consumer can keep around for key installed-user flows, explicitly reruns a temp program that mirrors the published README example, proves module and dependency metadata through `go list`, proves the package and exported symbol documentation surface through `go doc`, including public payload structs, the public event shape, public SDK errors, W3C trace context types and helpers, transport interfaces, response and error types, `DefaultHTTPEndpoint`, `HTTPTransportConfig`, `HTTPTransport`, `NewHTTPTransport`, helper entrypoints like `PendingEvents`, `LastBody`, and `AsTransportError`, plus preview and lifecycle methods and field-level docs for core config and transport types, proves installed `ParseTraceparent`, `CreateTraceparent`, and `SpanAttributesFromTraceparent` behavior with valid continuation, default flags, primitive metadata filtering, and malformed-header rejection, proves installed `HTTPTransport` delivery against a local HTTP intake with retry behavior, then runs a full successful batch, verifies the empty-flush no-op path, verifies a stable validation failure, verifies the unauthenticated error path, proves retry recovery, proves retry-budget failure behavior, proves non-retryable transport-status failure behavior, and confirms post-shutdown rejection like a user would.

## Objective-C SDK

The first installable Objective-C SDK package lives in [`objc/logbrew-objc`](objc/logbrew-objc).

Useful commands:

```bash
bash scripts/check_objc_package.sh
bash scripts/real_user_objc_smoke.sh
cd objc/logbrew-objc/examples && make
cd objc/logbrew-objc/examples && make run-readme-example
cd objc/logbrew-objc/examples && make run
cd objc/logbrew-objc/examples && make run-real-user-smoke
```

The focused Objective-C verifier compiles the Foundation-based source/header package, tests, and examples with ARC plus `-Wall -Wextra -Wpedantic -Werror`, validates example stdout against the shared contract and parity fixture, inspects the source archive, builds the extracted package, and checks public README/header guidance. The Objective-C smoke script installs that archive into a fresh temp native app under `vendor/logbrew-objc`, proves source package remove/add behavior, compiles a consumer app against the installed header/source, verifies the shipped examples from the installed package, and exercises successful flush, empty flush, validation failure, unauthenticated failure, retry recovery, retry-budget failure, non-retryable status failure, graceful shutdown, and post-shutdown rejection like an Apple Objective-C user would.

## Java SDK

The first installable Java SDK package lives in [`java/logbrew-java`](java/logbrew-java).

Useful commands:

```bash
bash scripts/check_java_static.sh
bash scripts/check_java_package.sh
bash scripts/real_user_java_smoke.sh
bash scripts/real_user_spring_boot_smoke.sh
cd java/logbrew-java/examples && make
cd java/logbrew-java/examples && make run-readme-example
cd java/logbrew-java/examples && make run
cd java/logbrew-java/examples && make run-real-user-smoke
```

The focused Java verifier first runs pinned SpotBugs `4.9.8` from a temp-downloaded Maven Central distribution with SHA-256 verification, then compiles the SDK and tests with `javac -Xlint:all -Werror --release 11`, runs package tests, generates Javadocs with doclint failures treated as errors, builds and inspects a binary jar containing Maven metadata plus README guidance, compiles shipped examples against that jar, and validates example stdout against the shared contract and parity fixture. The Java smoke script builds binary and source jars with JDK tools, temp-downloads checksum-verified SLF4J/Logback artifacts for optional appender coverage, inspects both artifacts, extracts the source jar and runs the shipped helper Makefile, proves classpath add/remove/re-add behavior in a temp app, compiles a fresh temp app against the packaged jar, verifies successful flush, empty flush, validation failure, unauthenticated failure, retry recovery, retry-budget failure, non-retryable status failure, post-shutdown rejection, installed `HttpTransport` delivery against a local HTTP intake with retry behavior, `LogBrewJulHandler` capture from a real app-owned `java.util.logging.Logger` without mutating the root logger, and `LogBrewLogbackAppender` capture from a real app-owned SLF4J/Logback logger with MDC, fluent key/value metadata, generated ids, stop-time flushing, and no stack traces by default. The Spring Boot smoke builds the SDK jar into a temp Maven-style repository, resolves stable Spring Boot through a fresh Gradle app, and proves Boot's default Logback runtime captures app-owned logger events with MDC and SLF4J key/value metadata without adding a required Spring dependency to the SDK.

## .NET SDK

The first installable .NET SDK package lives in [`dotnet/logbrew-dotnet`](dotnet/logbrew-dotnet).

Useful commands:

```bash
bash scripts/check_dotnet_package.sh
bash scripts/real_user_dotnet_smoke.sh
cd dotnet/logbrew-dotnet/examples && make
cd dotnet/logbrew-dotnet/examples && make run-readme-example
cd dotnet/logbrew-dotnet/examples && make run
cd dotnet/logbrew-dotnet/examples && make run-real-user-smoke
```

The focused .NET verifier builds the `netstandard2.0` SDK with nullable reference types, warnings as errors, built-in .NET analyzers enabled, `AnalysisMode=All`, code-style enforcement in build, and analyzer warnings treated as errors, runs package tests, packs a NuGet `.nupkg`, inspects the packaged DLL, README, examples, and helper Makefile, compiles shipped examples against the SDK project, and validates example stdout against the shared contract and parity fixture. The .NET smoke script installs the packed NuGet package into fresh console apps, proves package add/remove/re-add behavior, runs packaged README-style and stronger real-user examples, verifies `Microsoft.Extensions.Logging` provider capture from a real `LoggerFactory` with structured state, `BeginScope` metadata, exception metadata, no stack text by default, proves installed `HttpTransport` delivery against a local HTTP intake with retry behavior, and then verifies successful flush, empty flush, validation failure, unauthenticated failure, retry recovery, retry-budget failure, non-retryable status failure, graceful shutdown, and post-shutdown rejection like a real user.

## Unity SDK

The first installable Unity SDK package lives in [`unity/logbrew-unity`](unity/logbrew-unity).

Useful commands:

```bash
bash scripts/check_unity_package.sh
bash scripts/real_user_unity_smoke.sh
cd unity/logbrew-unity/examples && make
cd unity/logbrew-unity/examples && make run-readme-example
cd unity/logbrew-unity/examples && make run
cd unity/logbrew-unity/examples && make run-real-user-smoke
```

The focused Unity verifier validates UPM `package.json` metadata, compiles the source-only runtime with nullable reference types, warnings as errors, built-in .NET analyzers enabled with `AnalysisMode=All`, code-style enforcement in build, analyzer warnings treated as errors, and SDK-aware exceptions for public UPM APIs plus older Unity profile compatibility. It runs dependency-free package tests, including null-argument fail-fast coverage and `HttpTransport` request/header validation, packs and inspects a `co.logbrew.unity-0.1.0.tgz` artifact, runs shipped README-style and stronger samples, and validates sample stdout against the shared contract and parity fixture. The Unity smoke script installs the packed package into a fresh Unity-project-like `Packages/` layout, proves dependency add/remove/re-add behavior through the project manifest, runs installed samples, verifies Unity helper APIs for scene, log, exception, and frame-span capture, proves installed `HttpTransport` delivery against a local HTTP intake with retry behavior, and exercises successful flush, empty flush, validation failure, unauthenticated failure, retry recovery, retry-budget failure, non-retryable status failure, graceful shutdown, and post-shutdown rejection without requiring the Unity Editor.

## Kotlin SDK

The first installable Kotlin SDK package lives in [`kotlin/logbrew-kotlin`](kotlin/logbrew-kotlin).

Useful commands:

```bash
bash scripts/check_kotlin_style.sh
bash scripts/check_kotlin_package.sh
bash scripts/real_user_kotlin_smoke.sh
cd kotlin/logbrew-kotlin/examples && make
cd kotlin/logbrew-kotlin/examples && make run-readme-example
cd kotlin/logbrew-kotlin/examples && make run
cd kotlin/logbrew-kotlin/examples && make run-real-user-smoke
```

The focused Kotlin verifier first runs pinned ktlint `1.8.0` from a temp-downloaded Maven Central all-jar with SHA-256 verification, then compiles the SDK with `kotlinc -Werror`, runs dependency-free package tests, builds and inspects a `co.logbrew:logbrew-kotlin:0.1.0` jar with Maven metadata, README guidance, `HttpTransport`, and shipped examples, compiles README-style and stronger examples against that jar, and validates stdout against the shared contract and parity fixture. The Kotlin smoke script creates a local Maven-style repository, proves Gradle can resolve the package, proves dependency add/remove/re-add behavior in a temp Gradle project, runs installed shipped examples, verifies Android helper APIs for activity, screen, Android `Log` priority-style messages, throwable-safe issue capture, logcat-style messages, device, OS, and session context, confirms throwable stack text stays opt-in, proves installed `HttpTransport` delivery against a local HTTP intake with SDK-key authorization, content-type/custom-header handling, and retry recovery, and exercises successful flush, empty flush, validation failure, unauthenticated failure, retry recovery, retry-budget failure, non-retryable status failure, graceful shutdown, and post-shutdown rejection without requiring the Android SDK.

## Ruby SDK

The first installable Ruby SDK package lives in [`ruby/logbrew-ruby`](ruby/logbrew-ruby).

Useful commands:

```bash
bash scripts/check_ruby_package.sh
bash scripts/real_user_ruby_smoke.sh
cd ruby/logbrew-ruby && ruby tests/run.rb
cd ruby/logbrew-ruby && gem build logbrew-sdk.gemspec --strict
cd ruby/logbrew-ruby/examples && make
cd ruby/logbrew-ruby/examples && make run-readme-example
cd ruby/logbrew-ruby/examples && make run
cd ruby/logbrew-ruby/examples && make run-real-user-smoke
```

The focused Ruby verifier checks every Ruby file with `ruby -w -c`, runs dependency-free package tests, generates RDoc pages for the public client, standard `LogBrew::Logger`, Rack-compatible `LogBrew::RackMiddleware`, Rails `LogBrew::RailsErrorSubscriber`, `LogBrew::HttpTransport`, recording transport, and SDK error surface, builds the gem with `gem build --strict`, unpacks the artifact to inspect shipped README/example/helper files, and validates README and real-user example stdout against the shared contract and parity fixture. The Ruby smoke script builds and unpacks the gem, installs it into a fresh `GEM_HOME`, proves installed examples and helper commands from the gem directory, removes and reinstalls the gem through RubyGems, runs a fresh temp app through `require "logbrew"`, proves installed `LogBrew::HttpTransport` delivery against a local HTTP intake with retry behavior, proves `LogBrew::Logger` capture from real `warn`/`error` calls without exception backtrace text by default, proves installed `LogBrew::RackMiddleware` captures successful Rack requests plus unhandled app exceptions as issue/error-span events without requiring Rails or Rack at runtime, proves installed `LogBrew::RailsErrorSubscriber` captures handled/manual Rails error reports through the Rails error reporter shape, and verifies successful flush, empty flush, validation failure, unauthenticated failure, retry recovery, retry-budget failure, non-retryable status failure, graceful shutdown, and post-shutdown rejection like a real user.

## Swift SDK

The first installable Swift SDK package lives in [`swift/logbrew-swift`](swift/logbrew-swift).

Useful commands:

```bash
bash scripts/check_swift_style.sh
bash scripts/check_swift_package.sh
cd swift/logbrew-swift && swift build
cd swift/logbrew-swift && swift test
cd swift/logbrew-swift && swift package archive-source
cd swift/logbrew-swift && swift run ReadmeExample
cd swift/logbrew-swift && swift run RealUserSmoke
cd swift/logbrew-swift/examples && make
cd swift/logbrew-swift/examples && make run-readme-example
cd swift/logbrew-swift/examples && make run
cd swift/logbrew-swift/examples && make run-real-user-smoke
bash scripts/real_user_swift_smoke.sh
```

The focused Swift verifier now runs `bash scripts/check_swift_style.sh` first, which requires SwiftFormat and SwiftLint, enforces the package-local `.swiftformat` and `.swiftlint.yml` configs, treats SwiftLint violations as errors with `--strict`, and keeps the package source split small enough that file-length issues are fixed structurally instead of ignored. The Swift smoke script builds and tests the SwiftPM package using isolated scratch paths, creates and inspects a Swift source archive, runs the shipped README-style and stronger retry-backed executable examples directly and through the shipped `examples/Makefile`, validates their JSON against the shared contract and parity fixture, then creates a fresh temp SwiftPM executable app that depends on the local `logbrew-swift` package path, proves SwiftPM dependency metadata through `describe` and `show-dependencies`, verifies `LogBrewLogger` capture for Apple-style levels, subsystem/category metadata, generated ids, and non-throwing logger calls, proves installed `HTTPTransport` delivery against a local HTTP intake with SDK-key authorization, content-type/custom-header handling, and retry recovery, and runs the app like a real user.

## PHP SDK

The first installable PHP SDK package lives in [`php/logbrew-php`](php/logbrew-php).

Useful commands:

```bash
cd php/logbrew-php && composer update --no-interaction
python3 scripts/check_php_sources.py
bash scripts/check_php_static.sh
cd php/logbrew-php && php tests/run.php
cd php/logbrew-php/examples && make
cd php/logbrew-php/examples && make run-readme-example
cd php/logbrew-php/examples && make run
cd php/logbrew-php/examples && make run-real-user-smoke
cd php/logbrew-php && php examples/readme_example.php
cd php/logbrew-php && php examples/real_user_smoke.php
bash scripts/real_user_php_smoke.sh
cd php/logbrew-php && composer validate --no-check-publish
```

The focused public verifier runs `python3 scripts/check_php_sources.py` and `bash scripts/check_php_static.sh` before the PHP test suite so every repo-checkout PHP source, example, and test file is checked with `php -l` plus temp-installed PHPStan `level=max` before Composer metadata and real-user smoke paths run. The PHPStan gate installs its exact tooling into a throwaway Composer project, keeps PHPStan cache state inside that temp directory, and uses `treatPhpDocTypesAsCertain: false` because the public SDK still accepts raw user arrays and validates them at runtime even though PHPDoc shaped arrays improve static consumer UX. The PHP SDK also includes opt-in `LogBrewMonologHandler` support for Monolog and Laravel-style logging channels while keeping Monolog as an app-owned dependency instead of forcing it into every SDK install.
The PHP smoke script creates a temporary Composer project through `composer init`, inspects the packaged archive before install, adds that archive through `composer require` against a Composer artifact repository, proves the generated consumer project stays valid under `composer validate`, proves normal Composer install artifacts and package metadata through the rewritten root `composer.json`, plain `composer show`, `composer show --format=json`, `composer why`, `composer licenses --format=json`, `composer.lock`, `vendor/composer/installed.json`, and generated autoload/version helpers under `vendor/composer/`, including the expected human-facing `composer show` summary fields for package name, description, selected version, type, MIT license, artifact zip, install path, autoload block, PHP requirement, and `psr/log` dependency, proves that the temp project survives a package-manager-native `composer remove logbrew/sdk` removal before `composer require logbrew/sdk:0.1.0` adds the artifact back, proves that the generated lockfile can recreate the install through a clean `composer install` after `vendor/` is removed, proves that `composer dump-autoload --optimize` preserves the SDK autoload surface before and after that reinstall path, proves the direct `smoke/app -> logbrew/sdk` dependency edge through Composer's own graph output, proves the installed package license through Composer's own license report, proves the structured Composer package view for description, type, dist, install path, autoload, and PHP requirement metadata, proves tiny installed-user scripts can still exercise the public client through Composer's own script runner, explicitly reruns a static-analysis consumer script, one that mirrors the published README example, a PSR-3 logger script, a Monolog handler script, an HTTP transport script, the happy-path smoke run, the shipped `vendor/logbrew/sdk/examples/readme_example.php` file, and the shipped `vendor/logbrew/sdk/examples/real_user_smoke.php` file before and after reinstall, then proves the shipped example helper surface by running the installed `vendor/logbrew/sdk/examples/Makefile`, now including a discoverable plain `make` path whose output prints copy-pasteable `make run-readme-example`, `make run`, and `make run-real-user-smoke` commands before the README example runs through `make run-readme-example` and the stronger real-user path runs through `make run` or `make run-real-user-smoke`, and proves the packaged README itself teaches that helper surface instead of leaving it implicit, proves installed vendor payload files and manifest fields, proves the archive and installed README guidance plus the shipped example files and PHPDoc payload-shape aliases, client, PSR-3 logger, Monolog handler, SDK error, transport interface, `HttpTransport`, recording transport, response, lifecycle method surface, and key public property docs through reflection and in a real static-analysis consumer, proves installed `HttpTransport` delivery against a local HTTP intake with retry behavior, runs a full successful batch, verifies the empty-flush no-op path, verifies a stable validation failure, verifies the unauthenticated error path, proves retry recovery, proves retry-budget failure behavior, proves non-retryable transport-status failure behavior, and confirms post-shutdown rejection like a user would.

## SDK shipping expectations

Before any language SDK is published, it should satisfy the checklist in [`docs/sdk-readiness-checklist.md`](docs/sdk-readiness-checklist.md), including:

- Installable real-user examples with fake/public placeholders only
- Success, validation failure, unauthenticated, network failure, retry, flush, shutdown, JSON, and error-path coverage
- Small dependency footprint and stable parseable outputs
- Dry-run packaging checks before release

The repository GitHub Actions baseline is documented in [`docs/github-actions.md`](docs/github-actions.md).
