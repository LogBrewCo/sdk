import type { Failure, Issue, Outcome } from "./api";
import type { Inputs, Screen, Topic, View } from "./screens";
import { describe, expect, test } from "bun:test";
import { menuOf, screenOf, viewOf } from "./screens";
import type { NewIssues } from "./logbrew";
import type { SignIn } from "./sign-in";

const maxWords = 14;
const capped = 500;
const many = 12;

const issue: Issue = {
  environment: "production",
  firstSeenAt: 0,
  id: "issue-1",
  lastSeenAt: 0,
  message: "",
  occurrences: 1,
  projectId: "project-1",
  release: "",
  serviceName: "checkout",
  severity: "error",
  title: "TypeError in checkout",
};

const idle: SignIn = { kind: "idle" };
const waiting: SignIn = {
  authorization: {
    deviceCode: "device",
    expiresAt: 0,
    interval: 0,
    link: "https://logbrew.co/device",
    userCode: "ABCD-EFGH",
  },
  kind: "waiting",
};
const failures: readonly Failure[] = ["forbidden", "invalid", "notFound", "offline", "rateLimited", "unavailable"];
const stops = ["denied", "expired", "invalid", "offline"] as const;
const topics: readonly Topic[] = ["errors", "issues"];

function inputs(result: Outcome<readonly Issue[]> | undefined, signIn: SignIn = idle): Inputs<Issue> {
  return { hasProjects: true, loading: false, result, signIn, validUrl: true };
}

function allViews(): readonly View<Issue>[] {
  return [
    { kind: "badUrl" },
    { kind: "loading" },
    { kind: "noProjects" },
    { items: [], kind: "ready" },
    { items: [issue], kind: "ready" },
    ...failures.map((failure): View<Issue> => ({ failure, kind: "failed" })),
    ...stops.map((reason): View<Issue> => ({ kind: "signIn", signIn: { kind: "stopped", reason } })),
    { kind: "signIn", signIn: idle },
    { kind: "signIn", signIn: waiting },
    { kind: "signIn", signIn: { kind: "starting" } },
  ];
}

function wordCount(text: string): number {
  return text.split(/\s+/u).filter((word) => word !== "").length;
}

function expectPlain(screen: Screen): void {
  expect(screen.title).not.toBe("");
  expect(wordCount(screen.description)).toBeLessThanOrEqual(maxWords);
  expect(`${screen.title} ${screen.description}`).not.toMatch(/\b(?:please|just|simply|sorry|oops)\b/iu);
}

describe("viewOf", () => {
  test("asks for a valid API URL first", () => {
    expect(viewOf({ ...inputs(undefined), validUrl: false })).toEqual({ kind: "badUrl" });
  });

  test("shows a sign-in in progress over any result", () => {
    expect(viewOf(inputs({ kind: "signedOut" }, waiting))).toEqual({ kind: "signIn", signIn: waiting });
  });

  test("shows loading while the first answer is on its way", () => {
    expect(viewOf({ ...inputs(undefined), loading: true })).toEqual({ kind: "loading" });
    expect(viewOf(inputs({ kind: "signedOut" }, { kind: "signedIn" }))).toEqual({ kind: "loading" });
  });

  test("asks to sign in when signed out", () => {
    expect(viewOf(inputs({ kind: "signedOut" }))).toEqual({ kind: "signIn", signIn: idle });
  });

  test("passes a failure through", () => {
    expect(viewOf(inputs({ failure: "offline", kind: "failed" }))).toEqual({ failure: "offline", kind: "failed" });
    expect(viewOf(inputs(undefined))).toEqual({ failure: "invalid", kind: "failed" });
  });

  test("tells an account without projects apart from an empty list", () => {
    expect(viewOf({ ...inputs({ kind: "ok", value: [] }), hasProjects: false })).toEqual({ kind: "noProjects" });
    expect(viewOf(inputs({ kind: "ok", value: [] }))).toEqual({ items: [], kind: "ready" });
    expect(viewOf(inputs({ kind: "ok", value: [issue] }))).toEqual({ items: [issue], kind: "ready" });
  });
});

describe("screenOf", () => {
  test("gives every state short, plain wording", () => {
    for (const topic of topics) {
      for (const view of allViews()) {
        expectPlain(screenOf(view, topic));
      }
    }
  });

  test("offers the next step for each state", () => {
    expect(screenOf({ kind: "badUrl" }, "issues").next).toBe("preferences");
    expect(screenOf({ failure: "offline", kind: "failed" }, "issues").next).toBe("retry");
    expect(screenOf({ kind: "signIn", signIn: idle }, "issues").next).toBe("signIn");
    expect(screenOf({ kind: "signIn", signIn: { kind: "stopped", reason: "denied" } }, "issues").next).toBe("signIn");
    expect(screenOf({ items: [], kind: "ready" }, "errors").next).toBe("dashboard");
    expect(screenOf({ items: [issue], kind: "ready" }, "errors").next).toBe("none");
  });

  test("shows the code to approve while waiting", () => {
    expect(screenOf({ kind: "signIn", signIn: waiting }, "issues").title).toBe("Approve Code ABCD-EFGH");
  });

  test("names the empty list and the unmatched search by topic", () => {
    expect(screenOf({ items: [], kind: "ready" }, "errors").title).toBe("No Errors in the Last 24 Hours");
    expect(screenOf({ items: [], kind: "ready" }, "issues").title).toBe("No Unresolved Issues");
    expect(screenOf({ items: [issue], kind: "ready" }, "issues").title).toBe("No Matching Issues");
  });
});

function newIssues(value: NewIssues): Outcome<NewIssues> {
  return { kind: "ok", value };
}

describe("menuOf", () => {
  test("shows no count while loading or signed out", () => {
    expect(menuOf(undefined, true)).toMatchObject({ heading: "Loading…", title: undefined });
    expect(menuOf({ kind: "signedOut" }, false)).toMatchObject({
      heading: "Signed Out",
      note: "Sign in to see new issues here.",
      title: undefined,
    });
  });

  test("shows a failure with its fix", () => {
    expect(menuOf({ failure: "offline", kind: "failed" }, false)).toMatchObject({
      heading: "Can't Reach LogBrew",
      note: "Check your internet connection, then retry.",
      title: undefined,
    });
  });

  test("hides the count when nothing is new", () => {
    expect(menuOf(newIssues({ capped: false, count: 0, latest: [] }), false)).toMatchObject({
      heading: "No New Issues in 24 Hours",
      title: undefined,
    });
  });

  test("counts new issues and marks a capped count", () => {
    expect(menuOf(newIssues({ capped: false, count: 1, latest: [issue] }), false)).toMatchObject({
      title: "1",
      tooltip: "LogBrew: 1 new issue in 24 hours",
    });
    expect(menuOf(newIssues({ capped: false, count: many, latest: [issue] }), false).tooltip).toBe(
      "LogBrew: 12 new issues in 24 hours",
    );
    expect(menuOf(newIssues({ capped: true, count: capped, latest: [issue] }), false).title).toBe("500+");
  });
});
