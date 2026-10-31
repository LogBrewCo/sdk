import {
  OVERSIZED_TEXT_LENGTH,
  firstAttributes,
  isValidationError,
  items,
  pick,
  previewAttributes,
  sampleClient,
  uncheckedIssue
} from "./issue-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 */

const BREADCRUMB_LIMIT = 64;
const LAST_BREADCRUMB_INDEX = 63;
const STEP_INCREMENT = 1;
const SECONDS_PER_MINUTE = 60;
const SECOND_DIGITS = 2;
const SECOND_EVENT_INDEX = 1;

const INVALID_DIAGNOSTICS = [
  { exception: { mechanism: { type: "react.error_boundary" }, type: "CheckoutError" } },
  { exception: { type: "x".repeat(OVERSIZED_TEXT_LENGTH) } },
  { breadcrumbs: [] },
  { breadcrumbs: [{ category: "navigation", data: { nested: {} }, timestamp: "2026-07-17T12:00:00Z" }] },
  { breadcrumbsTruncated: "yes" }
];

/**
 * @param {LogBrewClient} client
 * @returns {void}
 */
function addCheckoutSteps(client) {
  for (let index = STEP_INCREMENT; index <= BREADCRUMB_LIMIT; index += STEP_INCREMENT) {
    client.addBreadcrumb({
      category: `checkout.step.${index}`,
      data: { attempt: index, complete: index === BREADCRUMB_LIMIT },
      level: index === BREADCRUMB_LIMIT ? "warn" : "debug"
    }, `2026-07-17T11:59:${String(index % SECONDS_PER_MINUTE).padStart(SECOND_DIGITS, "0")}.000Z`);
  }
}

/**
 * @param {unknown} attributes
 * @returns {void}
 */
function assertBoundedTrail(attributes) {
  assert.equal(pick(attributes, "breadcrumbs.length"), BREADCRUMB_LIMIT);
  assert.equal(pick(attributes, "breadcrumbs.0.category"), "checkout.step.1");
  assert.equal(pick(attributes, "breadcrumbs.0.level"), "debug");
  assert.deepEqual(pick(attributes, `breadcrumbs.${LAST_BREADCRUMB_INDEX}`), {
    category: "checkout.step.64",
    data: { attempt: 64, complete: true },
    level: "warning",
    timestamp: "2026-07-17T11:59:04.000Z"
  });
  assert.equal(pick(attributes, "breadcrumbsTruncated"), true);
  assert.doesNotMatch(JSON.stringify(attributes), /caller mutation|original\/example/u);
}

/**
 * @param {LogBrewClient} client
 * @returns {void}
 */
function addMutatedNavigation(client) {
  const mutable = {
    category: "navigation",
    data: { attempt: 1, route: "/checkout/:step" },
    message: "Opened /checkout/:step"
  };
  client.addBreadcrumb(mutable, "2026-07-17T11:59:00.000Z");
  mutable.message = "caller mutation";
  mutable.data.route = "/original/example/123";
}

/**
 * @param {LogBrewClient} client
 * @returns {void}
 */
function assertClearedTrail(client) {
  assert.equal(client.clearBreadcrumbs(), BREADCRUMB_LIMIT);
  client.issue("evt_after_clear", "2026-07-17T12:00:01.000Z", { level: "error", title: "After clear" });
  const cleared = previewAttributes(client, SECOND_EVENT_INDEX);
  assert.equal(pick(cleared, "breadcrumbs"), undefined);
  assert.equal(pick(cleared, "breadcrumbsTruncated"), undefined);
}

await test("issue diagnostics retain a bounded breadcrumb trail without caller mutation", () => {
  const client = sampleClient();
  addMutatedNavigation(client);
  addCheckoutSteps(client);

  client.issue("evt_breadcrumbs", "2026-07-17T12:00:00.000Z", {
    exception: {
      mechanism: { handled: true, type: "react.error_boundary" },
      type: "CheckoutError"
    },
    level: "error",
    title: "Checkout failed"
  });
  assertBoundedTrail(firstAttributes(client));
  assertClearedTrail(client);
});

await test("issue diagnostics reject unsafe shapes and preserve explicit breadcrumb snapshots", () => {
  for (const diagnostics of INVALID_DIAGNOSTICS) {
    const client = sampleClient();
    assert.throws(
      () => {
        uncheckedIssue(client, ["evt_invalid_diagnostics", "2026-07-17T12:00:00Z", {
          level: "error",
          title: "Invalid diagnostics",
          ...diagnostics
        }]);
      },
      isValidationError
    );
  }

  const client = sampleClient();
  client.addBreadcrumb({ category: "buffered" }, "2026-07-17T11:58:00Z");
  client.issue("evt_explicit_snapshot", "2026-07-17T12:00:00Z", {
    breadcrumbs: [{
      category: "explicit",
      data: { step: "  submit  " },
      message: "  Safe explicit context  ",
      timestamp: "2026-07-17T11:59:00Z"
    }],
    level: "error",
    title: "Explicit snapshot"
  });
  const attributes = firstAttributes(client);
  assert.deepEqual(items(pick(attributes, "breadcrumbs")).map((breadcrumb) => pick(breadcrumb, "category")), ["explicit"]);
  assert.equal(pick(attributes, "breadcrumbs.0.message"), "Safe explicit context");
  assert.equal(pick(attributes, "breadcrumbs.0.data.step"), "submit");
});
