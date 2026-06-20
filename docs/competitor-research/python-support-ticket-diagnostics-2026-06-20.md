# Python Support Ticket Diagnostics - Competitor Research - 2026-06-20

## Goal

Prepare Python developers and support agents for explicit support-ticket handoff without calling backend support routes that are not deployed yet. The SDK gap is a local, typed, token-free payload draft that helps users preserve the useful install/runtime context while avoiding accidental secret, local path, URL origin, and exception-message leakage.

## Sources Read

- Sentry Python SDK: `getsentry/sentry-python@1164b1851093725d8095caba394a78234770460c`.
- Sentry files/functions/classes: `sentry_sdk/scrubber.py` (`DEFAULT_DENYLIST`, `DEFAULT_PII_DENYLIST`, `EventScrubber.scrub_dict`, `scrub_request`, `scrub_event`), `sentry_sdk/client.py` (`event_scrubber.scrub_event`, `before_send` handling), `sentry_sdk/scope.py` (`add_event_processor`, `run_event_processors`), and `sentry_sdk/utils.py` (`sanitize_url`, `parse_url`).
- PostHog Python SDK: `PostHog/posthog-python@95598a2a85a7e32df6901943c72cbfd21ecd6e9d`.
- PostHog files/functions/classes: `posthog/exception_utils.py` (`DEFAULT_CODE_VARIABLES_MASK_PATTERNS`, `_mask_sensitive_data`, `serialize_code_variables`), `posthog/contexts.py` (`new_context`), `posthog/client.py` (`capture`, `capture_exception`), and `posthog/request.py` (`post`, `get`, feature-flag request helpers).
- Datadog Python SDK: `DataDog/dd-trace-py@c6278143c871bfe3252213b37385a689da53b221`.
- Datadog files/functions/classes: `ddtrace/internal/utils/http.py` (`strip_query_string`, `redact_query_string`, `redact_url`), `ddtrace/internal/settings/_config.py` (query-string obfuscation config), `ddtrace/internal/flare/flare.py` (`_generate_config_file` API-key redaction), `ddtrace/internal/telemetry/writer.py` (`_format_traceback`, `_format_file_path`), `ddtrace/contrib/internal/subprocess/patch.py` (`SubprocessCmdLine.scrub_env_vars`, `scrub_arguments`), and `ddtrace/contrib/internal/ray/core/utils.py` (`redact_paths`).

## Competitor Pattern

- Sentry has mature event scrubbing and `before_send`/event-processor hooks, but those run inside the telemetry capture pipeline and are broader than a support-diagnostics draft.
- PostHog keeps capture explicit and supports context-scoped exception capture; code-variable capture is opt-in and masked by patterns.
- Datadog has multiple specialized redaction paths for URLs, config, command arguments, local paths, and telemetry tracebacks.

## LogBrew Implementation

- Added `create_support_ticket_draft(...)` to `logbrew-sdk`.
- The helper validates planned public `source` and `category` values, requires title and description, keeps Pythonic snake_case payload fields, normalizes valid W3C trace IDs, and returns a local dictionary.
- Diagnostics are structured JSON-like data with bounded recursion, sequence length, and string length. Auth-like keys, cookies, tokens, URL origins, local paths, unsupported objects, and exception messages/stacks are redacted or omitted before the draft is returned.
- The helper intentionally does not send data, open tickets, call backend support routes, use account/session API credentials, infer backend ownership, or treat planned routes as deployed.

## Tradeoffs

- Better than broad telemetry mutation hooks for support diagnostics because the draft helper is narrow, inspectable, typed, and local-only.
- Better than raw exception/context upload for public SDK safety because exception messages and stacks are not copied into diagnostics by default.
- Worse than Sentry or Datadog for teams that want hosted feedback/support submission today; LogBrew should only add network ticket creation after backend route deployment and explicit user or agent action.
- The next safe step is repeating this explicit draft pattern in other high-use SDKs while keeping route calls out of SDK defaults.

## Verification

- Focused Python unit tests cover payload shape, enum validation, trace ID validation, diagnostics object validation, sensitive-key redaction, URL-origin stripping, local-path redaction, exception type-only capture, unsupported-object omission, and no hidden auth/path/origin/message leakage.
- Python real-user smoke now requires the helper in wheel/sdist payloads, README/metadata, installed package file inventories, strict typecheck imports, and installed runtime behavior after package-manager install/reinstall.
