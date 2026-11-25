import { serve } from "bun";

type Recorded = Readonly<{ authorization: string; body: unknown; method: string; path: string; query: string }>;

type Fixture = Readonly<{ requests: Recorded[]; stop: () => Promise<void>; url: string }>;

const apiToken = "lbw_pat_fixture";
const ingestKey = "lbw_ingest_fixture";
const projectId = "11111111-1111-4111-8111-111111111111";
const minute = 60_000;
const day = 86_400_000;
const occurrences = 3;
const httpStatus = { notFound: 404, ok: 200, unauthorized: 401 } as const;
const ingestRoute = "POST /api/telemetry/ingest";

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function issue(suffix: string, title: string, firstSeenAt: string): Readonly<Record<string, unknown>> {
  return {
    environment: "production",
    first_seen_at: firstSeenAt,
    id: `22222222-2222-4222-8222-2222222222${suffix}`,
    last_seen_at: ago(minute),
    message: `${title} message`,
    occurrence_count: occurrences,
    project_id: projectId,
    release: "api@1.2.3",
    service_name: "checkout-api",
    severity: "error",
    status: "unresolved",
    title,
    triage: null,
  };
}

const resolvable = {
  ...issue("01", "PaymentError: card authorization timed out", ago(minute + minute)),
  id: "22222222-2222-4222-8222-222222222201",
  triage: { effective_severity: "critical" },
};

const issues = [
  resolvable,
  issue("02", "Old TimeoutError seen again", ago(occurrences * day)),
  issue("03", "TypeError in checkout", ago(minute)),
  { broken: true },
];

function rule(id: string, name: string, lastFiredAt: string | null): Readonly<Record<string, unknown>> {
  return { environment: null, id, kind: "event_count", last_fired_at: lastFiredAt, name, project_id: projectId, service: null };
}

const rules = [
  { ...rule("rule-new-issue", "New production issue", ago(minute)), environment: "production", kind: "new_issue" },
  rule("rule-quiet", "Never fired", null),
  { ...rule("rule-spike", "Error spike", ago(day)), service: "checkout-api" },
];

const projects = [
  { id: projectId, is_active: true, name: "Checkout" },
  { id: "project-mobile", is_active: true, name: "Mobile" },
  { id: "project-archived", is_active: false, name: "Archived" },
  { id: "project-search", is_active: true, name: "Search" },
  { id: "project-web", is_active: true, name: "Web" },
];

const routes: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["GET /api/projects", projects],
  ["GET /api/telemetry/issues", { issues, next_cursor: null }],
  [`GET /api/projects/${projectId}/alert-rules`, { project_id: projectId, rules }],
  [`PATCH /api/telemetry/issues/${resolvable.id}`, { ...resolvable, status: "resolved" }],
  [ingestRoute, { actions: 0, already_accepted: 0, issues: 0, logs: 1, next: "Read the log in LogBrew", trace_spans: 0 }],
]);

function route(key: string, authorization: string): Response {
  if (authorization !== `Bearer ${key === ingestRoute ? ingestKey : apiToken}`) {
    return Response.json(
      { code: "invalid_token", error: "Invalid or expired token", next: "send Authorization: Bearer <token>" },
      { status: httpStatus.unauthorized },
    );
  }
  const body = routes.get(key);
  if (body === undefined) {
    return Response.json(
      { code: "not_found", error: "Issue not found", next: "Check the issue ID" },
      { status: httpStatus.notFound },
    );
  }
  return Response.json(body, { status: httpStatus.ok });
}

function startFixture(): Fixture {
  const requests: Recorded[] = [];
  const server = serve({
    async fetch(request: Request) {
      const url = new URL(request.url);
      const raw = await request.text();
      const body: unknown = raw === "" ? undefined : JSON.parse(raw);
      const authorization = request.headers.get("authorization") ?? "";
      requests.push({ authorization, body, method: request.method, path: url.pathname, query: url.search });
      return route(`${request.method} ${url.pathname}`, authorization);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return { requests, stop: async () => server.stop(true), url: `http://127.0.0.1:${String(server.port)}` };
}

export { apiToken, ingestKey, projectId, startFixture };
