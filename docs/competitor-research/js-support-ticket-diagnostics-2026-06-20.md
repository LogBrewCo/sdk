# JavaScript Support Ticket Diagnostics - Competitor Research - 2026-06-20

## Goal

Prepare JavaScript developers and support agents for the planned backend support-ticket API without calling routes that are not live yet. The safer SDK gap is a local, typed, token-free payload draft for explicit user or agent action. LogBrew must not silently open tickets, infer backend ownership, or leak credentials in diagnostics.

## Sources Read

- Sentry JavaScript SDK: `getsentry/sentry-javascript@102483999dc4d93856f450912443328fa59aeb09`.
- Sentry files/functions: `packages/core/src/feedback.ts` (`captureFeedback`), `packages/core/src/types/feedback/sendFeedback.ts` (`UserFeedback`, `FeedbackEvent`, `SendFeedbackParams`), `packages/core/src/client.ts` (`beforeSendFeedback`, `processBeforeSend`), `packages/browser/src/userfeedback.ts` (`createUserFeedbackEnvelope`, `createUserFeedbackEnvelopeItem`), and `packages/browser/test/userfeedback.test.ts`.
- Datadog browser SDK: `DataDog/browser-sdk@fce095dc4913895cbb72a41fa5fe6b983aba4564`.
- Datadog files/functions: `packages/browser-core/src/domain/configuration/configuration.ts` (`GenericBeforeSendCallback`, `validateAndBuildConfiguration`, `beforeSend` wrapping), `packages/browser-core/src/domain/configuration/configuration.spec.ts`, `packages/browser-core/src/tools/serialisation/sanitize.ts` (`sanitize`), `packages/browser-core/src/domain/context/contextManager.ts` (`createContextManager`), and `packages/browser-core/src/domain/context/contextUtils.ts` (`checkContext`).
- PostHog JS SDK: `PostHog/posthog-js@ab4a2203392af6e63225fcfc93483bc8577c16ae`.
- PostHog files/functions: `packages/browser/src/customizations/before-send.ts` (`sampleByDistinctId`, `sampleBySessionId`, `sampleByEvent`, `printAndDropEverything`), `packages/core/src/posthog-core.ts` (`_beforeSend`, `_runBeforeSend`, `processBeforeEnqueue`), `packages/browser/src/posthog-core.ts` (`_runBeforeSend`), and `packages/core/src/logs/index.ts` (`_runBeforeSend`).

## Competitor Pattern

- Sentry feedback is a live event/envelope path. It supports structured feedback and a `beforeSendFeedback` hook, but the browser helper is tied to sending feedback data through Sentry's client pipeline.
- Datadog uses `beforeSend` and context sanitization as a broad last-mile mutation/drop layer. This is powerful, but it is part of the telemetry pipeline and depends on runtime configuration.
- PostHog chains `before_send` functions for events and logs so apps can sample, mutate, or drop payloads before enqueue. This is flexible, but broad mutation hooks can make support diagnostics harder to reason about.

## LogBrew Implementation

- Added `createSupportTicketDraft(...)` to `@logbrew/sdk`.
- The helper validates the planned public backend `source` and `category` enums, requires title and description, converts JavaScript camelCase input to planned create-payload fields, lowercases valid W3C trace IDs, and returns a local JSON object.
- Diagnostics are JSON-like, bounded, and sanitized before the draft is returned. Auth-like keys, cookies, tokens, local paths, URL origins, hidden payload strings, unsupported values, and exception messages/stacks are redacted or omitted.
- The helper intentionally does not send data, open support tickets, call `POST /api/support/tickets`, use account/session API credentials, infer usage/quota state, or treat planned routes as deployed.

## Tradeoffs

- Better than live feedback defaults for public SDK safety: developers get a predictable, inspectable payload they can copy or pass to an explicit future agent action without background network behavior.
- Worse than Sentry's current feedback path for teams that want an in-product widget or immediate hosted ticket submission today.
- Better than broad `beforeSend` mutation for support diagnostics because the helper is narrow, typed, local-only, and token-redacting by construction.
- The next safe step is adding the same explicit local draft helper to high-use SDKs after the backend confirms route deployment semantics. Network ticket creation should remain a separate explicit user or agent action.

## Verification

- Focused source tests cover payload shape, enum validation, trace ID validation, diagnostics redaction, unsupported-value omission, and no hidden token/path/origin/raw propagation leakage.
- Installed-package smoke now checks README guidance, shipped ESM/CommonJS declarations, TypeScript types, and runtime behavior from `@logbrew/sdk` after package-manager install and reinstall.
