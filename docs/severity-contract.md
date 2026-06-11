# LogBrew Severity Contract

LogBrew uses four user-facing severity categories across SDKs, native ingest, logs, issues, and event timelines:

| Product severity | Use it for |
| --- | --- |
| `info` | Normal progress, debug-style details that are useful for investigation, and non-actionable notices. |
| `warning` | Recoverable or degraded behavior that may need attention if it repeats. |
| `error` | Failed work, handled exceptions, and request or job failures that should be investigated. |
| `critical` | Fatal, outage-level, data-loss, or user-blocking failures that need urgent attention. |

SDKs may accept idiomatic runtime aliases when they improve integration with existing loggers, but payloads should be normalized before delivery:

| Runtime alias | Sent as |
| --- | --- |
| `trace` | `info` |
| `debug` | `info` |
| `info` | `info` |
| `warn` | `warning` |
| `warning` | `warning` |
| `error` | `error` |
| `fatal` | `critical` |
| `critical` | `critical` |

Public LogBrew docs and examples should prefer `info`, `warning`, `error`, and `critical`. Treat `trace`, `debug`, `warn`, and `fatal` as compatibility inputs for logger bridges, not as product categories shown to users.

This keeps LogBrew simpler than tools that expose many overlapping severity labels while preserving compatibility with common runtimes, OpenTelemetry-style logs, and existing application logger conventions.
