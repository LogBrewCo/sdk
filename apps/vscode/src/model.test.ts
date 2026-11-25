import type { ErrorLog, Issue, Outcome, Project } from "@logbrew/raycast/api";
import type { Fake, Handler } from "@logbrew/raycast/fake";
import { ago, errorRows, issueRows, load, pickProject } from "./model";
import { answer, fake, pathOf, signedIn, start } from "@logbrew/raycast/fake";
import { describe, expect, test } from "bun:test";
import type { Origins } from "@logbrew/raycast/logbrew";
import type { Row } from "./model";

type Fields = Readonly<Record<string, unknown>>;

const minute = 60_000;
const hour = 3_600_000;
const day = 86_400_000;
const status = { forbidden: 403, unauthorized: 401, unavailable: 503 } as const;
const counts = { feedReads: 3, many: 60, one: 1, shown: 50 } as const;
const spans = { fiveMinutes: 300_000, threeHours: 10_800_000, twoHours: 7_200_000 } as const;
const origins: Origins = { api: "https://api.example.com", dashboard: "https://example.com" };
const checkout: Project = { id: "p-1", name: "Checkout" };
const worker: Project = { id: "p-2", name: "Worker Jobs" };

function issue(id: string, lastSeenAt: number): Issue {
  return {
    environment: "production",
    firstSeenAt: lastSeenAt - day,
    id,
    lastSeenAt,
    message: `Error ${id}`,
    occurrences: 3,
    projectId: checkout.id,
    release: "1.2.0",
    serviceName: "api",
    severity: "error",
    title: `TypeError ${id}`,
  };
}

function log(id: string, message: string, traceId: string): ErrorLog {
  return {
    environment: "",
    id,
    message,
    occurredAt: start - minute,
    projectId: checkout.id,
    release: "",
    serviceName: "worker",
    severity: "critical",
    traceId,
  };
}

function issueRow(id: string): Fields {
  return {
    first_seen_at: new Date(start - day).toISOString(),
    id,
    last_seen_at: new Date(start - hour).toISOString(),
    occurrence_count: 2,
    severity: "warning",
    title: `Issue ${id}`,
  };
}

function ok<Value>(value: Value): Outcome<Value> {
  return { kind: "ok", value };
}

function labels(rows: readonly Row[]): readonly string[] {
  return rows.map((row) => row.label);
}

async function ready(handler: Handler): Promise<Fake> {
  const target = fake(handler);
  await signedIn(target, start + hour);
  return target;
}

function projectsThen(rest: Handler): Handler {
  return (request) =>
    pathOf(request) === "/api/projects"
      ? answer([
          { id: checkout.id, name: checkout.name },
          { id: worker.id, name: worker.name },
        ])
      : rest(request);
}

describe("pickProject", () => {
  test("keeps the project chosen for this workspace", () => {
    expect(pickProject([checkout, worker], worker.id, ["checkout"])).toEqual(worker);
  });

  test("matches the workspace folder name without case, spaces, or dashes", () => {
    expect(pickProject([checkout, worker], undefined, ["worker-jobs"])).toEqual(worker);
    expect(pickProject([checkout, worker], "gone", ["CHECKOUT"])).toEqual(checkout);
  });

  test("uses the only project when nothing matches", () => {
    expect(pickProject([checkout], undefined, ["website"])).toEqual(checkout);
  });

  test("asks when no folder or more than 1 project matches", () => {
    expect(pickProject([checkout, worker], undefined, ["website"])).toBeUndefined();
    expect(pickProject([checkout, { id: "p-3", name: "check-out" }], undefined, ["checkout"])).toBeUndefined();
  });
});

describe("load", () => {
  test("reads the issues and errors of the matched project", async () => {
    const target = await ready(
      projectsThen((request) =>
        pathOf(request).startsWith("/api/telemetry/issues") ? answer([issueRow("i-1")]) : answer([]),
      ),
    );
    const state = await load(target.platform, undefined, ["checkout"]);
    expect(state.kind).toBe("ready");
    const paths = target.requests.map((request) => pathOf(request));
    expect(paths.filter((path) => path.includes(`project_id=${checkout.id}`)).length).toBe(counts.feedReads);
    expect(state).toMatchObject({ feed: { project: checkout }, projects: [checkout, worker] });
    const issues = state.kind === "ready" ? state.feed.issues : undefined;
    expect(issues?.kind === "ok" ? issues.value.map((entry) => entry.id) : []).toEqual(["i-1"]);
  });

  test("asks for a project when the workspace matches none", async () => {
    const target = await ready(projectsThen(() => answer([])));
    expect(await load(target.platform, undefined, ["website"])).toEqual({
      kind: "chooseProject",
      projects: [checkout, worker],
    });
    expect(target.requests.length).toBe(counts.one);
  });
});

describe("load without a feed", () => {
  test("reports no projects, a failure, and a signed-out session", async () => {
    const empty = await ready(() => answer([]));
    const down = await ready(() => answer({}, status.unavailable));
    expect(await load(empty.platform, undefined, [])).toEqual({ kind: "noProjects" });
    expect(await load(down.platform, undefined, [])).toEqual({ failure: "unavailable", kind: "failed" });
    expect(await load(fake(() => answer([])).platform, undefined, [])).toEqual({ kind: "signedOut" });
  });

  test("signs out when the session ends while the feed loads", async () => {
    const target = await ready(projectsThen(() => answer({}, status.unauthorized)));
    expect(await load(target.platform, checkout.id, [])).toEqual({ kind: "signedOut" });
  });

  test("keeps a feed failure inside the ready state", async () => {
    const target = await ready(
      projectsThen((request) =>
        pathOf(request).startsWith("/api/logs") ? answer({}, status.forbidden) : answer([issueRow("i-1")]),
      ),
    );
    const state = await load(target.platform, checkout.id, []);
    expect(state.kind === "ready" ? state.feed.errors : undefined).toEqual({ failure: "forbidden", kind: "failed" });
  });
});

describe("issueRows", () => {
  test("links each issue to the dashboard with its count, time, and details", () => {
    const [row] = issueRows(ok([issue("i-1", start - hour)]), origins);
    expect(row).toEqual({
      at: start - hour,
      detail: ["Error i-1", "production", "1.2.0"],
      events: 3,
      id: "issue:i-1",
      kind: "item",
      label: "TypeError i-1",
      link: "https://example.com/dashboard/issues/i-1",
      severity: "error",
      source: "api",
    });
  });

  test("shows at most 50 issues", () => {
    const many = Array.from({ length: counts.many }, (_entry, index) => issue(`i-${index}`, start - index * minute));
    expect(issueRows(ok(many), origins).length).toBe(counts.shown);
  });

  test("shows a message row when there are no issues or the read failed", () => {
    expect(issueRows(ok([]), origins)).toEqual([
      {
        description: "New issues appear here as soon as LogBrew groups them.",
        kind: "message",
        label: "No Unresolved Issues",
        mark: "empty",
        next: "dashboard",
      },
    ]);
    expect(labels(issueRows({ failure: "offline", kind: "failed" }, origins))).toEqual(["Can't Reach LogBrew"]);
  });
});

describe("errorRows", () => {
  test("shows the first line of the message and links the trace", () => {
    const [row] = errorRows(ok([log("l-1", "Timeout\n  at fetch (api.ts:4)", "t-1")]), origins);
    expect(row).toMatchObject({
      detail: ["at fetch (api.ts:4)"],
      events: undefined,
      label: "Timeout",
      link: "https://example.com/dashboard/traces?trace=t-1",
      severity: "critical",
      source: "worker",
    });
  });

  test("falls back to the log id and the logs page", () => {
    const blank = log("l-2", "   ", "");
    const [row] = errorRows(ok([blank]), origins);
    expect(row).toMatchObject({ label: "l-2", link: "https://example.com/dashboard/logs" });
  });

  test("shows a message row when there are no errors", () => {
    const rows = errorRows(ok([]), origins);
    expect(labels(rows)).toEqual(["No Errors in the Last 24 Hours"]);
  });
});

describe("ago", () => {
  test("names the largest whole unit in the editor language", () => {
    expect(ago(start, start, "en")).toBe("now");
    expect(ago(start - spans.fiveMinutes, start, "en")).toBe("5 min. ago");
    expect(ago(start - spans.threeHours, start, "en")).toBe("3 hr. ago");
    expect(ago(start - day, start, "en")).toBe("yesterday");
    expect(ago(start - spans.twoHours, start, "de")).toBe("vor 2 Std.");
  });
});
