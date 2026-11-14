import type { Fake, Handler } from "./fake";
import { answer, fake, pathOf, signedIn, start } from "./fake";
import { describe, expect, test } from "bun:test";
import { listIssues, listNewIssues, listProjects, listRecentErrors } from "./logbrew";
import type { Outcome } from "./api";
import type { Request } from "./session";

type Row = Readonly<Record<string, unknown>>;

const second = 1000;
const hour = 3_600_000;
const day = 86_400_000;
const pageLimit = 500;
const status = { unavailable: 503 } as const;
const counts = { two: 2 } as const;

function issueRow(id: string, firstSeenAt: number): Row {
  return {
    first_seen_at: new Date(firstSeenAt).toISOString(),
    id,
    last_seen_at: new Date(firstSeenAt + hour).toISOString(),
    occurrence_count: 1,
    severity: "error",
    title: `Issue ${id}`,
  };
}

function logRow(id: string, occurredAt: number, severity: string): Row {
  return { id, message: id, occurred_at: new Date(occurredAt).toISOString(), severity };
}

async function ready(handler: Handler): Promise<Fake> {
  const target = fake(handler);
  await signedIn(target, start + hour);
  return target;
}

function ids(outcome: Outcome<readonly Readonly<{ id: string }>[]>): readonly string[] {
  return outcome.kind === "ok" ? outcome.value.map((item) => item.id) : [];
}

function hasCritical(request: Request): boolean {
  return pathOf(request).includes("severity=critical");
}

describe("listProjects", () => {
  test("sorts projects by name", async () => {
    const target = await ready(() =>
      answer([
        { id: "b", name: "Worker" },
        { id: "a", name: "Checkout" },
      ]),
    );
    expect(ids(await listProjects(target.platform))).toEqual(["a", "b"]);
  });
});

describe("listIssues", () => {
  test("lists unresolved issues for a project, newest activity first", async () => {
    const target = await ready(() => answer([issueRow("a", start - day), issueRow("b", start - hour)]));
    expect(ids(await listIssues(target.platform, "project-1"))).toEqual(["b", "a"]);
    expect(target.requests.map((request) => pathOf(request))).toEqual([
      "/api/telemetry/issues?limit=500&project_id=project-1&response_version=4&status=unresolved",
    ]);
  });

  test("passes a signed-out session through", async () => {
    expect(await listIssues(fake(() => answer([])).platform, "")).toEqual({ kind: "signedOut" });
  });
});

describe("listNewIssues", () => {
  test("counts issues first seen in the last 24 hours", async () => {
    const rows = [issueRow("old", start - counts.two * day), issueRow("new", start - hour), issueRow("newer", start - second)];
    const target = await ready(() => answer(rows));
    const outcome = await listNewIssues(target.platform);
    expect(outcome).toMatchObject({ kind: "ok", value: { capped: false, count: counts.two } });
    expect(outcome.kind === "ok" ? ids({ kind: "ok", value: outcome.value.latest }) : []).toEqual(["newer", "new"]);
  });

  test("marks a full page as capped", async () => {
    const rows = Array.from({ length: pageLimit }, (_entry, index) => issueRow(String(index), start));
    const target = await ready(() => answer(rows));
    expect(await listNewIssues(target.platform)).toMatchObject({ kind: "ok", value: { capped: true, count: pageLimit } });
  });
});

describe("listRecentErrors", () => {
  test("merges critical and error logs, newest first", async () => {
    const target = await ready((request) =>
      hasCritical(request) ? answer([logRow("critical", start - hour, "critical")]) : answer([logRow("error", start - second, "error")]),
    );
    expect(ids(await listRecentErrors(target.platform, "project-1"))).toEqual(["error", "critical"]);
    expect(target.requests).toHaveLength(counts.two);
  });

  test("fails when one request fails", async () => {
    const target = await ready((request) => (hasCritical(request) ? answer([]) : answer(undefined, status.unavailable)));
    expect(await listRecentErrors(target.platform, "project-1")).toEqual({ failure: "unavailable", kind: "failed" });
  });
});
