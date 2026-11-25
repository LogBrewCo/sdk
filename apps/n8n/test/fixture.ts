type Recorded = Readonly<{ authorization: string; body: unknown; method: string; path: string; query: string }>;

type Fixture = Readonly<{ requests: Recorded[]; stop: () => Promise<void>; url: string }>;

const apiToken = "lbw_pat_fixture";
const ingestKey = "lbw_ingest_fixture";
const projectId = "11111111-1111-4111-8111-111111111111";
const status = { badRequest: 400, forbidden: 403, notFound: 404, ok: 200, unauthorized: 401 } as const;
const firstRow = 0;
const pageSize = 2;

const paymentIssue = {
    environment: "production",
    first_seen_at: "2026-11-25T09:00:00Z",
    id: "22222222-2222-4222-8222-222222222201",
    last_seen_at: "2026-11-25T12:00:00Z",
    message: "card authorization timed out",
    occurrence_count: 4,
    project_id: projectId,
    release: "api@1.2.3",
    service_name: "checkout-api",
    severity: "error",
    status: "unresolved",
    title: "PaymentError: card authorization timed out",
    triage: { effective_severity: "critical", ignored: false, rule_applied: true },
  } as const;

const typeIssue = {
    environment: "production",
    first_seen_at: "2026-11-25T11:30:00Z",
    id: "22222222-2222-4222-8222-222222222202",
    last_seen_at: "2026-11-25T12:30:00Z",
    message: "Cannot read properties of undefined",
    occurrence_count: 1,
    project_id: projectId,
    release: "web@4.0.0",
    service_name: "web",
    severity: "error",
    status: "unresolved",
    title: "TypeError in checkout",
  } as const;

const resetIssue = {
    environment: "production",
    first_seen_at: "2026-11-25T10:15:00Z",
    id: "22222222-2222-4222-8222-222222222203",
    last_seen_at: "2026-11-25T11:50:00Z",
    message: "connection reset",
    occurrence_count: 2,
    project_id: projectId,
    release: "api@1.2.3",
    service_name: "checkout-api",
    severity: "warning",
    status: "unresolved",
    title: "ECONNRESET from payments",
  } as const;

const issues = [paymentIssue, typeIssue, resetIssue] as const;

const rules = [
  {
    environment: "production",
    id: "33333333-3333-4333-8333-333333333301",
    kind: "new_issue",
    last_fired_at: "2026-11-25T11:31:00Z",
    muted: false,
    name: "New production issue",
    project_id: projectId,
    service: null,
  },
  {
    environment: null,
    id: "33333333-3333-4333-8333-333333333302",
    kind: "event_count",
    last_fired_at: null,
    muted: false,
    name: "Error spike",
    project_id: projectId,
    service: "checkout-api",
  },
  {
    environment: null,
    id: "33333333-3333-4333-8333-333333333303",
    kind: "regression",
    last_fired_at: "2026-11-25T08:00:00Z",
    muted: false,
    name: "Regression",
    project_id: projectId,
    service: null,
  },
] as const;

const projects = [
  { id: projectId, is_active: true, name: "Checkout" },
  { id: "11111111-1111-4111-8111-111111111112", is_active: false, name: "Archived" },
] as const;

function json(body: unknown, code: number = status.ok): Response {
  return Response.json(body, { status: code });
}

function refused(code: number, next: string): Response {
  const error = code === status.unauthorized ? "Invalid or expired token" : "Insufficient permissions";
  return json({ code: code === status.unauthorized ? "unauthorized" : "forbidden", error, next }, code);
}

function notFound(error: string, next: string): Response {
  return json({ code: "not_found", error, next }, status.notFound);
}

function listIssues(search: string): Response {
  const params = new URLSearchParams(search);
  if (params.get("pagination") !== "cursor" || params.get("response_version") !== "7") {
    return json(
      { code: "validation", error: "Unsupported issue list request", next: "send pagination=cursor and response_version=7" },
      status.badRequest,
    );
  }
  const since = Date.parse(params.get("since") ?? "");
  const cursorTime = Date.parse(params.get("cursor_time") ?? "");
  const cursorId = params.get("cursor_id") ?? "";
  const listed = issues
    .filter((issue) => Number.isNaN(since) || Date.parse(issue.last_seen_at) >= since)
    .toSorted((left, right) => Date.parse(right.last_seen_at) - Date.parse(left.last_seen_at))
    .filter((issue) => {
      const seen = Date.parse(issue.last_seen_at);
      return Number.isNaN(cursorTime) || seen < cursorTime || (seen === cursorTime && issue.id < cursorId);
    });
  const page = listed.slice(firstRow, pageSize);
  const [last] = page.toReversed();
  const more = listed.length > page.length && last !== undefined;
  return json({ issues: page, next_cursor: more ? { id: last.id, time: last.last_seen_at } : null });
}

function resolve(path: string): Response {
  const id = path.slice("/api/telemetry/issues/".length);
  if (id.endsWith("204")) {
    return refused(status.forbidden, "ask a project owner for permission to manage issues");
  }
  const issue = issues.find((known) => known.id === id);
  return issue === undefined
    ? notFound("Issue not found", "list issues, then retry")
    : json({ ...issue, status: "resolved" });
}

function route(method: string, path: string, search: string): Response {
  const routes: Readonly<Record<string, () => Response>> = {
    "/api/projects": () => json(projects),
    [`/api/projects/${projectId}/alert-rules`]: () => json({ project_id: projectId, rules }),
    "/api/telemetry/ingest": () =>
      json({
        actions: 0,
        already_accepted: 0,
        issues: 0,
        logs: 1,
        next: "open LogBrew to review the telemetry",
        next_action: { code: "review_ingested_telemetry", target: "telemetry_reads" },
        trace_spans: 0,
      }),
    "/api/telemetry/issues": () => listIssues(search),
  };
  const handler = routes[path];
  if (handler !== undefined) {
    return handler();
  }
  if (method === "PATCH" && path.startsWith("/api/telemetry/issues/")) {
    return resolve(path);
  }
  return notFound("Not found", "check the path");
}

function answer(request: Readonly<Recorded>): Response {
  const expected = request.path === "/api/telemetry/ingest" ? ingestKey : apiToken;
  if (request.authorization !== `Bearer ${expected}`) {
    return refused(status.unauthorized, "send Authorization: Bearer <token>");
  }
  return route(request.method, request.path, request.query);
}

function startFixture(): Fixture {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    async fetch(request) {
      const url = new URL(request.url);
      const raw = await request.text();
      const recorded: Recorded = {
        authorization: request.headers.get("authorization") ?? "",
        body: raw === "" ? undefined : JSON.parse(raw),
        method: request.method,
        path: url.pathname,
        query: url.search,
      };
      requests.push(recorded);
      return answer(recorded);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return {
    requests,
    stop: async () => {
      await server.stop(true);
    },
    url: `http://127.0.0.1:${String(server.port)}`,
  };
}

export { type Fixture, type Recorded, apiToken, ingestKey, paymentIssue, projectId, resetIssue, startFixture, typeIssue };
