# Issue diagnostic evidence

An issue can include an optional `attributes.evidence` object when the application already knows facts that runtime inspection cannot derive. This object carries a reported cause hypothesis, a likely code location, user-visible impact, and explicit evidence-state receipts. The SDK does not generate these claims from an exception message.

## Wire contract

`likelyRootCause` is bounded to 1,024 Unicode scalar values. LogBrew presents it as an application-reported hypothesis, not a verified root cause.

`likelyFixArea` contains at least one code-location field: `component`, `module`, `function`, repository-relative `file`, positive `line`, or positive `column`. Optional `inApp` classifies the location but cannot be the only field. Paths are limited to 256 characters and cannot be absolute, contain parent traversal, a URL scheme, a query, or a fragment.

`impact` contains at least one of `affectedUserSegment`, `failedAction`, or `userVisibleOutcome`. Segment and action values are bounded low-cardinality identities. The outcome is display text capped at 512 Unicode scalar values. These fields describe a group and an outcome. They do not carry user identities.

`capturedFields`, `missingFields`, `redactedFields`, and `truncatedFields` each contain 1 to 32 unique field names. One name cannot appear under two states. Field names use letters, digits, dots, underscores, and hyphens and are capped at 64 characters.

Unknown keys, empty objects, contradictory states, unsafe paths, control characters, and values outside these bounds fail validation before queue admission.

## Ownership and safety

The application owns every value in `evidence`. Add it only when application logic, a bounded rule, or a developer-approved diagnostic already knows the claim. Do not copy an unreviewed generated diagnosis into telemetry. Do not include authentication material, authorization values, request or response bodies, personal data, raw user input, full URLs, headers, query strings, local absolute paths, or raw stack text.

SDKs preserve the validated object without upgrading its certainty. Backend, API, CLI, dashboard, and agent consumers keep reported hypotheses separate from observed frames, trace correlations, deployment timing, and symbolication. Missing, redacted, and truncated states remain visible. Consumers must not invent a historical backfill when older events do not contain this object.

Framework adapters reuse their ecosystem core validator. They must not accept a broader shape or drop valid evidence added by the core package.
