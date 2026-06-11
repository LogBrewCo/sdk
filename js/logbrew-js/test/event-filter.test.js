import test from "node:test";
import assert from "node:assert/strict";

import { LogBrewClient } from "../index.js";

test("event filter can drop events after validation without mutating queued payloads", () => {
  const filteredLevels = [];
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-js",
    sdkVersion: "0.1.0",
    eventFilter(event) {
      filteredLevels.push(event.attributes.level);
      event.attributes.title = "mutated copy";
      return event.attributes.level !== "info";
    }
  });

  client.log("evt_log_001", "2026-06-02T10:00:03Z", { message: "runtime detail", level: "debug" });
  client.issue("evt_issue_001", "2026-06-02T10:00:04Z", { title: "Checkout outage", level: "fatal" });

  const payload = JSON.parse(client.previewJson());
  assert.deepEqual(filteredLevels, ["info", "critical"]);
  assert.equal(client.pendingEvents(), 1);
  assert.deepEqual(payload.events, [
    {
      type: "issue",
      id: "evt_issue_001",
      timestamp: "2026-06-02T10:00:04Z",
      attributes: {
        title: "Checkout outage",
        level: "critical"
      }
    }
  ]);
});
