import { describe, expect, test } from "bun:test";
import { errorLogLink, issueLink, originsFrom } from "./logbrew";
import { failureFor, readErrorLogs, readIssues, readProjects } from "./api";
import type { Reply } from "./api";

const ok = 200;
const status = { badRequest: 400, forbidden: 403, notFound: 404, rateLimited: 429, unavailable: 503 } as const;

const issueRow = {
  environment: "production",
  first_seen_at: "2026-11-15T10:00:00Z",
  id: "issue/1",
  last_seen_at: "2026-11-15T11:30:00Z",
  message: "Cannot read properties of undefined",
  occurrence_count: 3,
  project_id: "project-1",
  release: "1.4.0",
  service_name: "checkout",
  severity: "warning",
  title: "TypeError in checkout",
  triage: { effective_severity: "error" },
};

const logRow = {
  environment: "production",
  id: "log-1",
  message: "Payment failed\nstack line",
  occurred_at: "2026-11-15T11:00:00Z",
  project_id: "project-1",
  release: "1.4.0",
  service_name: "payments",
  severity: "critical",
  trace_id: "trace 1",
};

const brokenIssues = [
  { ...issueRow, id: "" },
  { ...issueRow, severity: "fatal", triage: undefined },
  { ...issueRow, occurrence_count: "3" },
  { ...issueRow, last_seen_at: "yesterday" },
  "issue",
];

function reply(body: unknown): Reply {
  return { body, status: ok };
}

describe("readIssues", () => {
  test("maps an issue row and prefers the triaged severity", () => {
    expect(readIssues(reply([issueRow]))).toEqual({
      kind: "ok",
      value: [
        {
          environment: "production",
          firstSeenAt: Date.parse("2026-11-15T10:00:00Z"),
          id: "issue/1",
          lastSeenAt: Date.parse("2026-11-15T11:30:00Z"),
          message: "Cannot read properties of undefined",
          occurrences: 3,
          projectId: "project-1",
          release: "1.4.0",
          serviceName: "checkout",
          severity: "error",
          title: "TypeError in checkout",
        },
      ],
    });
  });

  test("falls back to the reported severity and fills missing text with empty strings", () => {
    const row = { ...issueRow, environment: undefined, release: undefined, triage: undefined };
    const outcome = readIssues(reply([row]));
    const [first] = outcome.kind === "ok" ? outcome.value : [];
    expect(first).toMatchObject({
      environment: "",
      release: "",
      severity: "warning",
    });
  });

  test("rejects the whole list when one row is not an issue", () => {
    for (const row of brokenIssues) {
      expect(readIssues(reply([issueRow, row]))).toEqual({ failure: "invalid", kind: "failed" });
    }
    expect(readIssues(reply({ issues: [issueRow] }))).toEqual({ failure: "invalid", kind: "failed" });
  });

  test("turns an error status into a failure", () => {
    expect(readIssues({ body: undefined, status: status.forbidden })).toEqual({ failure: "forbidden", kind: "failed" });
  });
});

describe("failureFor", () => {
  test("names each status family", () => {
    expect(failureFor(status.forbidden)).toBe("forbidden");
    expect(failureFor(status.notFound)).toBe("notFound");
    expect(failureFor(status.rateLimited)).toBe("rateLimited");
    expect(failureFor(status.unavailable)).toBe("unavailable");
    expect(failureFor(status.badRequest)).toBe("invalid");
  });
});

describe("readErrorLogs", () => {
  test("maps an error log row", () => {
    expect(readErrorLogs(reply([logRow]))).toEqual({
      kind: "ok",
      value: [
        {
          environment: "production",
          id: "log-1",
          message: "Payment failed\nstack line",
          occurredAt: Date.parse("2026-11-15T11:00:00Z"),
          projectId: "project-1",
          release: "1.4.0",
          serviceName: "payments",
          severity: "critical",
          traceId: "trace 1",
        },
      ],
    });
  });

  test("rejects a log without an id, a known severity, or a time", () => {
    for (const row of [
      { ...logRow, id: "" },
      { ...logRow, severity: "debug" },
      { ...logRow, occurred_at: "" },
    ]) {
      expect(readErrorLogs(reply([row]))).toEqual({ failure: "invalid", kind: "failed" });
    }
  });
});

describe("readProjects", () => {
  test("keeps active projects only", () => {
    const rows = [
      { id: "project-1", is_active: true, name: "Checkout" },
      { id: "project-2", is_active: false, name: "Old" },
      { id: "project-3", name: "Worker" },
    ];
    expect(readProjects(reply(rows))).toEqual({
      kind: "ok",
      value: [
        { id: "project-1", name: "Checkout" },
        { id: "project-3", name: "Worker" },
      ],
    });
  });

  test("rejects a project without a name", () => {
    expect(readProjects(reply([{ id: "project-1", name: " " }]))).toEqual({ failure: "invalid", kind: "failed" });
  });
});

describe("originsFrom", () => {
  test("derives the dashboard from the API host", () => {
    expect(originsFrom("https://api.logbrew.co")).toEqual({
      api: "https://api.logbrew.co",
      dashboard: "https://logbrew.co",
    });
    expect(originsFrom(" http://127.0.0.1:8787/ ")).toEqual({
      api: "http://127.0.0.1:8787",
      dashboard: "http://127.0.0.1:8787",
    });
  });

  test("refuses addresses it cannot use", () => {
    for (const address of [
      "",
      "logbrew.co",
      "ftp://api.logbrew.co",
      "https://user:pw@api.logbrew.co",
      "https://api.logbrew.co/?a=1",
      "https://api.logbrew.co/#top",
    ]) {
      expect(originsFrom(address)).toBeUndefined();
    }
  });
});

describe("dashboard links", () => {
  const origins = { api: "https://api.logbrew.co", dashboard: "https://logbrew.co" };

  test("links an issue by its encoded id", () => {
    const outcome = readIssues(reply([issueRow]));
    const [issue] = outcome.kind === "ok" ? outcome.value : [];
    expect(issue === undefined ? "" : issueLink(origins, issue)).toBe("https://logbrew.co/dashboard/issues/issue%2F1");
  });

  test("links an error log to its trace, else to the logs view", () => {
    const outcome = readErrorLogs(reply([logRow, { ...logRow, id: "log-2", trace_id: "" }]));
    const links = (outcome.kind === "ok" ? outcome.value : []).map((log) => errorLogLink(origins, log));
    expect(links).toEqual(["https://logbrew.co/dashboard/traces?trace=trace%201", "https://logbrew.co/dashboard/logs"]);
  });
});
