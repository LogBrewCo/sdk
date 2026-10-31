import { assertExcludes, callUnchecked } from "./tracing-helpers.js";
import assert from "node:assert/strict";
import { createSupportTicketDraft } from "@logbrew/sdk";
import test from "node:test";

/**
 * @import { SupportTicketDraftInput } from "@logbrew/sdk"
 */

const EXPECTED_DRAFT = {
  category: "ingest_failure",
  description: "Flush returned usage_limit_exceeded",
  diagnostics: {
    apiKey: "[redacted]",
    attemptCount: 2,
    endpoint: "[redacted-url]/ingest",
    error: { name: "Error" },
    events: [
      { id: "evt_checkout_flush", type: "span" },
      { token: "[redacted]" }
    ],
    headers: {
      accept: "application/json",
      authorization: "[redacted]",
      cookie: "[redacted]"
    },
    localPath: "[redacted-path]",
    retryable: false
  },
  environment: "production",
  event_id: "evt_checkout_flush",
  framework: "express",
  project_id: "proj_123",
  release: "checkout@1.2.3",
  runtime: "node@22",
  sdk_package: "@logbrew/sdk",
  sdk_version: "0.1.3",
  source: "sdk",
  title: "Telemetry flush failed",
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736"
};

/**
 * @returns {Record<string, unknown>}
 */
function unsafeDiagnostics() {
  return {
    apiKey: ["lbw", "ingest", "hidden"].join("_"),
    attemptCount: 2,
    callback: () => "ignored",
    endpoint: "https://api.example/ingest?debug=true#frag",
    error: new Error("contains hidden message"),
    events: [
      { id: "evt_checkout_flush", type: "span" },
      { token: "hidden" }
    ],
    headers: {
      accept: "application/json",
      authorization: ["Bearer", "hidden"].join(" "),
      cookie: "sid=hidden"
    },
    localPath: "/home/example/app/.env",
    retryable: false
  };
}

/**
 * @returns {SupportTicketDraftInput}
 */
function flushFailureInput() {
  return {
    category: "ingest_failure",
    description: "Flush returned usage_limit_exceeded",
    diagnostics: unsafeDiagnostics(),
    environment: "production",
    eventId: "evt_checkout_flush",
    framework: "express",
    projectId: "proj_123",
    release: "checkout@1.2.3",
    runtime: "node@22",
    sdkPackage: "@logbrew/sdk",
    sdkVersion: "0.1.3",
    source: "sdk",
    title: "Telemetry flush failed",
    traceId: "4BF92F3577B34DA6A3CE929D0E0E4736"
  };
}

await test("support ticket draft creates planned payload and redacts diagnostics", () => {
  const draft = createSupportTicketDraft(flushFailureInput());

  assert.deepEqual(draft, EXPECTED_DRAFT);
  assertExcludes(JSON.stringify(draft), ["hidden", "api.example", "/home/example", "traceparent"]);
});

await test("support ticket draft rejects invalid route-owned values", () => {
  assert.throws(
    () => callUnchecked(createSupportTicketDraft, [{
      category: "ingest_failure",
      description: "Flush failed",
      source: "daemon",
      title: "Telemetry failed"
    }]),
    /support ticket source must be one of: cli, sdk, website, docs, mobile/u
  );
  assert.throws(
    () => createSupportTicketDraft({
      category: "ingest_failure",
      description: "Flush failed",
      source: "sdk",
      title: "Telemetry failed",
      traceId: "00000000000000000000000000000000"
    }),
    /traceId must not be all zeros/u
  );
  assert.throws(
    () => callUnchecked(createSupportTicketDraft, [{
      category: "ingest_failure",
      description: "Flush failed",
      diagnostics: ["not", "an", "object"],
      source: "sdk",
      title: "Telemetry failed"
    }]),
    /support ticket diagnostics must be an object/u
  );
});
