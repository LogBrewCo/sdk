# Rust Dependency Panic Capture - 2026-07-04

## Source Checked

- Sentry Rust repo: `https://github.com/getsentry/sentry-rust`
- Commit checked: `e752b2db2f5d70b752d207328733e32a2b153545`
- File read: `sentry-panic/src/lib.rs`
- Functions/types read: `PanicIntegration::setup`, `panic_handler`,
  `message_from_panic_info`, `PanicIntegration::event_from_panic_info`

## Pattern Observed

Sentry's Rust panic integration installs a process-wide panic hook, captures a
panic event, flushes the client, then forwards to the previously registered
panic hook. Its generated event marks the exception type/mechanism as `panic`
and includes panic value plus stacktrace data.

## LogBrew Choice

LogBrew should not default to a global panic hook for dependency work. The
public Rust SDK now uses an explicit app-owned `DependencyOperationSpan`
`capture_panic(...)` helper instead. It queues an ok span on success, queues an
error span on panic, resumes the original unwind, and records only
`exception.type=panic`, `panic=true`, and a type-level `panicType`.

## Intentionally Not Copied

- No default process-wide hook.
- No panic messages or stacktraces.
- No SQL statements, cache keys, payloads, headers, full URLs, baggage,
  tracestate, or raw propagation data.
- No hidden DB/cache/queue driver patching.

## Proof Added

- Focused Rust operation tracing tests cover success return, failed span
  capture, unsafe-field omission, and unwind preservation.
- Installed temp-app dependency smoke now exercises `capture_panic(...)` from a
  packaged crate and verifies the panic message is absent from telemetry.
