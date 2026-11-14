type Severity = "critical" | "error" | "info" | "warning";

type Issue = Readonly<{
  environment: string;
  firstSeenAt: number;
  id: string;
  lastSeenAt: number;
  message: string;
  occurrences: number;
  projectId: string;
  release: string;
  serviceName: string;
  severity: Severity;
  title: string;
}>;

type ErrorLog = Readonly<{
  environment: string;
  id: string;
  message: string;
  occurredAt: number;
  projectId: string;
  release: string;
  serviceName: string;
  severity: Severity;
  traceId: string;
}>;

type Project = Readonly<{ id: string; name: string }>;

type Failure = "forbidden" | "invalid" | "notFound" | "offline" | "rateLimited" | "unavailable";

type Outcome<Value> =
  | Readonly<{ failure: Failure; kind: "failed" }>
  | Readonly<{ kind: "ok"; value: Value }>
  | Readonly<{ kind: "signedOut" }>;

type Reply = Readonly<{ body: unknown; status: number }>;

type Fields = Readonly<Record<string, unknown>>;

const severities: readonly Severity[] = ["critical", "error", "info", "warning"];
const status = { forbidden: 403, notFound: 404, ok: 200, rateLimited: 429, serverError: 500 } as const;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(fields: Fields, key: string): string {
  const value = fields[key];
  return typeof value === "string" ? value.trim() : "";
}

function time(fields: Fields, key: string): number {
  return Date.parse(text(fields, key));
}

function severity(fields: Fields): Severity | undefined {
  const { triage } = fields;
  const effective = isFields(triage) ? text(triage, "effective_severity") : "";
  const value = effective === "" ? text(fields, "severity") : effective;
  return severities.find((known) => known === value);
}

function parseIssue(value: unknown): Issue | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const issue = {
    environment: text(value, "environment"),
    firstSeenAt: time(value, "first_seen_at"),
    id: text(value, "id"),
    lastSeenAt: time(value, "last_seen_at"),
    message: text(value, "message"),
    occurrences: typeof value["occurrence_count"] === "number" ? value["occurrence_count"] : Number.NaN,
    projectId: text(value, "project_id"),
    release: text(value, "release"),
    serviceName: text(value, "service_name"),
    severity: severity(value),
    title: text(value, "title"),
  };
  const { firstSeenAt, id, lastSeenAt, occurrences, severity: known, title } = issue;
  if (id === "" || title === "" || known === undefined || !Number.isInteger(occurrences)) {
    return undefined;
  }
  if (Number.isNaN(firstSeenAt) || Number.isNaN(lastSeenAt)) {
    return undefined;
  }
  return { ...issue, severity: known };
}

function parseErrorLog(value: unknown): ErrorLog | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const log = {
    environment: text(value, "environment"),
    id: text(value, "id"),
    message: text(value, "message"),
    occurredAt: time(value, "occurred_at"),
    projectId: text(value, "project_id"),
    release: text(value, "release"),
    serviceName: text(value, "service_name"),
    severity: severity(value),
    traceId: text(value, "trace_id"),
  };
  if (log.id === "" || log.severity === undefined || Number.isNaN(log.occurredAt)) {
    return undefined;
  }
  return { ...log, severity: log.severity };
}

type ListedProject = Project & Readonly<{ active: boolean }>;

function parseProject(value: unknown): ListedProject | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const project = { active: value["is_active"] !== false, id: text(value, "id"), name: text(value, "name") };
  return project.id === "" || project.name === "" ? undefined : project;
}

function parseList<Item>(body: unknown, parse: (value: unknown) => Item | undefined): readonly Item[] | undefined {
  if (!Array.isArray(body)) {
    return undefined;
  }
  const items = body.map((value) => parse(value));
  return items.every((item): item is Item => item !== undefined) ? items : undefined;
}

function failureFor(code: number): Failure {
  if (code === status.forbidden) {
    return "forbidden";
  }
  if (code === status.notFound) {
    return "notFound";
  }
  if (code === status.rateLimited) {
    return "rateLimited";
  }
  return code >= status.serverError ? "unavailable" : "invalid";
}

function outcomeOf<Item>(reply: Reply, parse: (value: unknown) => Item | undefined): Outcome<readonly Item[]> {
  if (reply.status !== status.ok) {
    return { failure: failureFor(reply.status), kind: "failed" };
  }
  const items = parseList(reply.body, parse);
  return items === undefined ? { failure: "invalid", kind: "failed" } : { kind: "ok", value: items };
}

function readIssues(reply: Reply): Outcome<readonly Issue[]> {
  return outcomeOf(reply, parseIssue);
}

function readErrorLogs(reply: Reply): Outcome<readonly ErrorLog[]> {
  return outcomeOf(reply, parseErrorLog);
}

function readProjects(reply: Reply): Outcome<readonly Project[]> {
  const outcome = outcomeOf(reply, parseProject);
  if (outcome.kind !== "ok") {
    return outcome;
  }
  const active = outcome.value.filter((project) => project.active);
  return { kind: "ok", value: active.map(({ id, name }) => ({ id, name })) };
}

export {
  type ErrorLog,
  type Failure,
  type Issue,
  type Outcome,
  type Project,
  type Reply,
  type Severity,
  failureFor,
  isFields,
  readErrorLogs,
  readIssues,
  readProjects,
  text,
};
