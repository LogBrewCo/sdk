import { createClient, field, items, parseJson, recordAt } from "./capture-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

const ONE_QUEUED_EVENT = 1;

/**
 * @param {unknown} event
 * @returns {void}
 */
function mutateIssueCopy(event) {
  const attributes = recordAt(event, "attributes");
  recordAt(attributes, "exception")["type"] = "FilterMutation";
  const [firstBreadcrumb] = items(attributes["breadcrumbs"]);
  recordAt(firstBreadcrumb, "data")["route"] = "/filter-mutation";
}

/**
 * @param {(level: unknown) => void} recordLevel
 * @returns {(event: unknown) => boolean}
 */
function levelFilter(recordLevel) {
  return (event) => {
    const attributes = recordAt(event, "attributes");
    recordLevel(attributes["level"]);
    attributes["title"] = "mutated copy";
    if (field(event, "type") === "issue") {
      mutateIssueCopy(event);
    }
    return attributes["level"] !== "info";
  };
}

await test("event filter can drop events after validation without mutating queued payloads", () => {
  /** @type {unknown[]} */
  const filteredLevels = [];
  const client = createClient({
    eventFilter: levelFilter((level) => {
      filteredLevels.push(level);
    })
  });

  client.log("evt_log_001", "2026-06-02T10:00:03Z", { level: "debug", message: "runtime detail" });
  client.issue("evt_issue_001", "2026-06-02T10:00:04Z", {
    breadcrumbs: [{
      category: "navigation",
      data: { route: "/checkout/:step" },
      timestamp: "2026-06-02T10:00:02Z"
    }],
    exception: {
      mechanism: { handled: true, type: "javascript.error" },
      type: "CheckoutError"
    },
    level: "fatal",
    title: "Checkout outage"
  });

  const payload = parseJson(client.previewJson());
  assert.deepEqual(filteredLevels, ["info", "critical"]);
  assert.equal(client.pendingEvents(), ONE_QUEUED_EVENT);
  assert.deepEqual(field(payload, "events"), [
    {
      attributes: {
        breadcrumbs: [{
          category: "navigation",
          data: { route: "/checkout/:step" },
          timestamp: "2026-06-02T10:00:02Z"
        }],
        exception: {
          mechanism: { handled: true, type: "javascript.error" },
          type: "CheckoutError"
        },
        level: "critical",
        title: "Checkout outage"
      },
      id: "evt_issue_001",
      timestamp: "2026-06-02T10:00:04Z",
      type: "issue"
    }
  ]);
});
