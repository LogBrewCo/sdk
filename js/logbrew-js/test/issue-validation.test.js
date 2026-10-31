import { SdkError, createIssueAttributesFromError } from "@logbrew/sdk";
import { firstAttributes, items, pick, previewEvents, sampleClient, uncheckedIssue } from "./issue-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { IssueDiagnosticEvidence, IssueLikelyFixArea } from "@logbrew/sdk"
 * @typedef {IssueDiagnosticEvidence & { capturedFields: string[], likelyFixArea: IssueLikelyFixArea }} MutableEvidence
 */

/** @type {readonly IssueDiagnosticEvidence[]} */
const INVALID_EVIDENCE = [
  {},
  { likelyFixArea: { inApp: true } },
  { likelyFixArea: { file: "/srv/example/app.js" } },
  { likelyFixArea: { file: " /srv/example/app.js" } },
  { capturedFields: ["provider.status"], missingFields: ["provider.status"] },
  { capturedFields: ["bad field"] }
];

/**
 * @returns {MutableEvidence}
 */
function diagnosticEvidence() {
  return {
    capturedFields: ["provider.status", "retry.count"],
    impact: {
      affectedUserSegment: "checkout-users",
      failedAction: "checkout.submit",
      userVisibleOutcome: "The order was not confirmed."
    },
    likelyFixArea: {
      column: 7,
      component: "checkout-api",
      file: "src/payments/gateway.js",
      function: "chargeOrder",
      inApp: true,
      line: 42,
      module: "payments.gateway"
    },
    likelyRootCause: "The payment provider exhausted its retry budget.",
    missingFields: ["provider.request_id"],
    redactedFields: ["provider.message"],
    truncatedFields: ["breadcrumbs"]
  };
}

/**
 * @param {unknown} reason
 * @returns {boolean}
 */
function isInvalidTimestamp(reason) {
  const message = pick(reason, "message");
  return pick(reason, "code") === "validation_error" && typeof message === "string" && /invalid timestamp/u.test(message);
}

await test("invalid timestamp fails validation", () => {
  const client = sampleClient();
  assert.throws(
    () => {
      client.log("evt_log_001", "2026-06-02T10:00:03", { level: "info", message: "worker started" });
    },
    new SdkError("validation_error", "timestamp must include a timezone offset: 2026-06-02T10:00:03")
  );
  for (const timestamp of ["not-a-timeZ", "2026-02-30T10:00:03Z", "2026-06-02T25:00:03Z"]) {
    assert.throws(
      () => {
        client.log("evt_log_001", timestamp, { level: "info", message: "worker started" });
      },
      isInvalidTimestamp
    );
  }
});

await test("invalid issue level fails validation", () => {
  const client = sampleClient();
  assert.throws(
    () => {
      uncheckedIssue(client, ["evt_issue_001", "2026-06-02T10:00:02Z", { level: "verbose", title: "Checkout timeout" }]);
    },
    /issue level must be one of: trace, debug, info, warn, warning, error, fatal, critical/u
  );
});

await test("issue diagnostic evidence survives the public client boundary", () => {
  const client = sampleClient();
  const evidence = diagnosticEvidence();

  client.issue("evt_issue_evidence", "2026-06-02T10:00:02Z", {
    evidence,
    level: "error",
    title: "Checkout failed"
  });
  evidence.likelyFixArea.file = "mutated.js";
  evidence.capturedFields.push("mutated");

  assert.deepEqual(pick(firstAttributes(client), "evidence"), diagnosticEvidence());
});

await test("issue diagnostic evidence rejects unsafe or contradictory states", () => {
  const client = sampleClient();
  for (const evidence of INVALID_EVIDENCE) {
    assert.throws(
      () => {
        client.issue("evt_invalid_evidence", "2026-06-02T10:00:02Z", {
          evidence,
          level: "error",
          title: "Checkout failed"
        });
      },
      /issue evidence/u
    );
  }
});

await test("createIssueAttributesFromError preserves validated app-reported evidence", () => {
  const evidence = {
    likelyFixArea: { file: "src/payments/gateway.js", line: 42 },
    likelyRootCause: "The provider returned a terminal response.",
    missingFields: ["provider.request_id"]
  };
  const attributes = createIssueAttributesFromError(new Error("Checkout failed"), { evidence });
  evidence.likelyFixArea.file = "mutated.js";

  assert.deepEqual(attributes.evidence, {
    likelyFixArea: { file: "src/payments/gateway.js", line: 42 },
    likelyRootCause: "The provider returned a terminal response.",
    missingFields: ["provider.request_id"]
  });
});

await test("severity aliases normalize before preview", () => {
  const client = sampleClient();

  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", { level: "fatal", title: "Checkout timeout" });
  client.log("evt_log_001", "2026-06-02T10:00:03Z", { level: "debug", message: "verbose runtime detail" });
  client.log("evt_log_002", "2026-06-02T10:00:04Z", { level: "warn", message: "legacy warning alias" });

  assert.deepEqual(
    items(previewEvents(client)).map((event) => pick(event, "attributes.level")),
    ["critical", "info", "warning"]
  );
});
