# Browser Error Cause-Chain Summaries - 2026-07-04

## User Gap

Production errors often wrap lower-level failures. A real developer needs to know whether a browser issue is a plain top-level exception, a wrapped error, or an aggregate failure without leaking nested messages, stacks, local paths, or user data. Before this pass, LogBrew emitted the top error name/message, grouping key, first frame, and source-map Debug ID metadata, but not a bounded cause-chain summary.

## Source Reading

- Sentry JavaScript `68fe9e8fbcf70f1a92468410a1686787d4f724a6`
- `packages/core/src/integrations/linkederrors.ts`: `linkedErrorsIntegration(...)` defaults to key `cause` and limit `5`.
- `packages/browser/src/integrations/linkederrors.ts`: browser integration delegates to `applyAggregateErrorsToEvent(...)` with the browser exception builder.
- `packages/core/src/utils/aggregate-errors.ts`: `applyAggregateErrorsToEvent(...)`, `aggregateExceptionsFromError(...)`, parent/child exception group metadata.
- `packages/core/src/types/mechanism.ts`: linked/aggregate exceptions use `source`, `is_exception_group`, `exception_id`, and `parent_id`.
- Pattern: Sentry turns linked causes and `AggregateError.errors` into full exception values with stack data and parent-child mechanism fields. Strong for hosted debugging; heavier than LogBrew's current privacy boundary.

- Datadog Browser SDK `d2c7e303e4533f40e93d447042a67571f7ba97ff`
- `packages/browser-core/src/domain/error/error.ts`: `flattenErrorCauses(...)`, `computeRawError(...)`, `getErrorDebugIds(...)`.
- `packages/browser-logs/src/domain/createErrorFieldFromRawError.ts`: maps raw error `causes` into the log error field.
- `packages/browser-logs/src/domain/logger.spec.ts` and `runtimeError/runtimeErrorCollection.spec.ts`: tests include nested cause messages, types, and stacks.
- Pattern: Datadog flattens up to 10 causes and keeps messages/stacks/debug IDs. Strong debugging context; larger privacy/cardinality surface.

- PostHog JS `e480a3e23ecff45d2f9cf50332f6f59c54a7c736`
- `packages/core/src/error-tracking/error-properties-builder.ts`: `MAX_CAUSE_RECURSION = 4`, `parseStacktrace(...)`, `convertToExceptionList(...)`.
- `packages/browser/src/posthog-exceptions.ts`: builds exception properties and applies suppression before capture.
- Pattern: PostHog recursively converts causes into an exception list with a depth cap, then uses the exception list for capture/suppression.

## LogBrew Change

- `@logbrew/sdk` `createIssueAttributesFromError(...)` now summarizes nested `Error.cause` and `AggregateError.errors`.
- Metadata added only when causes exist:
  - `errorCauseCount`
  - `errorCauseTypes` with safe built-in or constructor names, not arbitrary non-error object names
  - `errorCauseSources`
  - `errorExceptionGroup` for aggregate-style errors
  - `errorCauseTruncated` when the five-entry cap is hit or a cycle is detected
- LogBrew does not copy nested cause messages, nested stacks, arbitrary nested object names, nested frame URLs, local paths, payloads, headers, cookies, baggage, or tracestate.
- `@logbrew/browser` receives the same summary through its existing core issue helper, so browser errors can now show path-only first-frame/source-map hints plus bounded cause context.

## Verification

- RED: `node --test --test-name-pattern "createIssueAttributesFromError.*cause|installed browser errors attach release artifact" js/logbrew-js/test/sdk.test.js js/logbrew-browser/test/trace-context.test.mjs` failed on missing cause metadata.
- GREEN: the same focused command passed after implementation.
- The Vite installed-artifact smoke was extended to attach a nested runtime cause and assert only cause type/source/count metadata is emitted.

## Remaining Gaps

- Sentry and Datadog still lead on hosted linked-exception UI, cause-chain stack display, source context, grouping previews, and suppression workflows.
- LogBrew's SDK-side summary is intentionally lighter. Hosted grouping/symbolication should decide how to display cause chains once backend release-artifact lookup and grouping contracts are available.
