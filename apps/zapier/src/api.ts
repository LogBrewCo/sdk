import type { Bundle, ZObject } from "zapier-platform-core";

type Fields = Readonly<Record<string, unknown>>;

type Connection = Readonly<{ apiToken: string; apiUrl: string; ingestKey: string }>;

type Request = Readonly<{
  body?: Fields;
  key: string;
  method: "GET" | "PATCH" | "POST";
  path: string;
  query?: Readonly<Record<string, string>>;
}>;

type Project = Readonly<{ id: string; name: string }>;

type Issue = Readonly<{
  environment: string;
  first_seen_at: string;
  id: string;
  last_seen_at: string;
  message: string;
  occurrence_count: number;
  project_id: string;
  release: string;
  service_name: string;
  severity: string;
  status: string;
  title: string;
  url: string;
}>;

type Alert = Readonly<{
  environment: string;
  fired_at: string;
  id: string;
  kind: string;
  name: string;
  project_id: string;
  rule_id: string;
  service: string;
}>;

type Level = "critical" | "debug" | "error" | "info" | "warning";

type Log = Readonly<{
  attributes: Fields;
  environment: string;
  level: Level;
  message: string;
  projectId: string;
  release: string;
  serviceName: string;
}>;

const appVersion = "1.0.0";
const defaultApiUrl = "https://api.logbrew.co";
const pageSize = "100";
const newIssueWindow = "24h";
const newIssueWindowMs = 86_400_000;
const missingCount = 0;
const levels: readonly Level[] = ["debug", "info", "warning", "error", "critical"];
const status = { badRequest: 400, firstFailure: 300, firstSuccess: 200 } as const;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(fields: Fields, key: string): string {
  const value = fields[key];
  return typeof value === "string" ? value.trim() : "";
}

function connectionOf(bundle: Bundle): Connection {
  const apiUrl = (process.env["LOGBREW_API_URL"] ?? "").trim().replace(/\/+$/u, "");
  return {
    apiToken: text(bundle.authData, "apiToken"),
    apiUrl: apiUrl === "" ? defaultApiUrl : apiUrl,
    ingestKey: text(bundle.authData, "ingestKey"),
  };
}

function failure(zapier: ZObject, code: number, body: unknown): Error {
  const fields = isFields(body) ? body : {};
  const detail =
    [text(fields, "error"), text(fields, "next")].filter((part) => part !== "").join(". ") ||
    "LogBrew did not accept the request";
  return new zapier.errors.Error(`${detail} (HTTP ${String(code)})`, text(fields, "code") || "http_error", code);
}

async function call(zapier: ZObject, bundle: Bundle, request: Request): Promise<unknown> {
  const { apiUrl } = connectionOf(bundle);
  const response = await zapier.request<unknown>({
    headers: { Authorization: `Bearer ${request.key}` },
    method: request.method,
    skipThrowForStatus: true,
    url: `${apiUrl}${request.path}`,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.query === undefined ? {} : { params: request.query }),
  });
  const body: unknown = response.data;
  if (response.status < status.firstSuccess || response.status >= status.firstFailure) {
    throw failure(zapier, response.status, body);
  }
  return body;
}

function listOf(zapier: ZObject, body: unknown): readonly unknown[] {
  if (!Array.isArray(body)) {
    throw new zapier.errors.Error("LogBrew sent a list in an unknown format. Try again later.", "unknown_format");
  }
  return body;
}

function compact<Item>(items: readonly (Item | undefined)[]): readonly Item[] {
  return items.filter((item): item is Item => item !== undefined);
}

function newestFirst<Item>(items: readonly Item[], at: (item: Item) => string): readonly Item[] {
  return items.toSorted((left, right) => Date.parse(at(right)) - Date.parse(at(left)));
}

function dashboardOrigin(apiUrl: string): string {
  const url = new URL(apiUrl);
  const host = url.host.startsWith("api.") ? url.host.slice("api.".length) : url.host;
  return `${url.protocol}//${host}`;
}

function parseIssue(value: unknown, dashboard: string): Issue | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const id = text(value, "id");
  const firstSeenAt = text(value, "first_seen_at");
  if (id === "" || Number.isNaN(Date.parse(firstSeenAt))) {
    return undefined;
  }
  const { triage } = value;
  const effective = isFields(triage) ? text(triage, "effective_severity") : "";
  const count = value["occurrence_count"];
  return {
    environment: text(value, "environment"),
    first_seen_at: firstSeenAt,
    id,
    last_seen_at: text(value, "last_seen_at"),
    message: text(value, "message"),
    occurrence_count: typeof count === "number" ? count : missingCount,
    project_id: text(value, "project_id"),
    release: text(value, "release"),
    service_name: text(value, "service_name"),
    severity: effective === "" ? text(value, "severity") : effective,
    status: text(value, "status"),
    title: text(value, "title"),
    url: `${dashboard}/dashboard/issues/${encodeURIComponent(id)}`,
  };
}

function parseAlert(value: unknown): Alert | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const ruleId = text(value, "id");
  const firedAt = text(value, "last_fired_at");
  if (ruleId === "" || Number.isNaN(Date.parse(firedAt))) {
    return undefined;
  }
  return {
    environment: text(value, "environment"),
    fired_at: firedAt,
    id: `${ruleId}@${firedAt}`,
    kind: text(value, "kind"),
    name: text(value, "name"),
    project_id: text(value, "project_id"),
    rule_id: ruleId,
    service: text(value, "service"),
  };
}

async function listProjects(zapier: ZObject, bundle: Bundle): Promise<readonly Project[]> {
  const { apiToken } = connectionOf(bundle);
  const body = await call(zapier, bundle, { key: apiToken, method: "GET", path: "/api/projects" });
  return compact(
    listOf(zapier, body).map((value) => {
      if (!isFields(value) || value["is_active"] === false) {
        return undefined;
      }
      const project = { id: text(value, "id"), name: text(value, "name") };
      return project.id === "" ? undefined : project;
    }),
  );
}

async function readIssues(zapier: ZObject, bundle: Bundle, filter: Readonly<Record<string, string>>): Promise<readonly Issue[]> {
  const { apiToken, apiUrl } = connectionOf(bundle);
  const body = await call(zapier, bundle, {
    key: apiToken,
    method: "GET",
    path: "/api/telemetry/issues",
    query: { limit: pageSize, pagination: "cursor", response_version: "7", ...filter },
  });
  const dashboard = dashboardOrigin(apiUrl);
  return compact(listOf(zapier, isFields(body) ? body["issues"] : body).map((value) => parseIssue(value, dashboard)));
}

async function newIssues(zapier: ZObject, bundle: Bundle, projectId: string): Promise<readonly Issue[]> {
  const sample = bundle.meta.isLoadingSample;
  const issues = await readIssues(zapier, bundle, sample ? { project_id: projectId } : { project_id: projectId, since: newIssueWindow });
  const since = Date.now() - newIssueWindowMs;
  const fresh = sample ? issues : issues.filter((issue) => Date.parse(issue.first_seen_at) >= since);
  return newestFirst(fresh, (issue) => issue.first_seen_at);
}

async function firedAlerts(zapier: ZObject, bundle: Bundle, projectId: string): Promise<readonly Alert[]> {
  const { apiToken } = connectionOf(bundle);
  const path = `/api/projects/${encodeURIComponent(projectId)}/alert-rules`;
  const body = await call(zapier, bundle, { key: apiToken, method: "GET", path });
  const alerts = compact(listOf(zapier, isFields(body) ? body["rules"] : body).map((value) => parseAlert(value)));
  return newestFirst(alerts, (alert) => alert.fired_at);
}

async function resolveIssue(zapier: ZObject, bundle: Bundle, issueId: string): Promise<Issue> {
  const { apiToken, apiUrl } = connectionOf(bundle);
  const body = await call(zapier, bundle, {
    body: { status: "resolved" },
    key: apiToken,
    method: "PATCH",
    path: `/api/telemetry/issues/${encodeURIComponent(issueId)}`,
    query: { response_version: "5" },
  });
  const issue = parseIssue(body, dashboardOrigin(apiUrl));
  if (issue === undefined) {
    throw new zapier.errors.Error("LogBrew sent an issue in an unknown format. Try again later.", "unknown_format");
  }
  return issue;
}

async function sendLog(zapier: ZObject, bundle: Bundle, log: Log): Promise<Fields> {
  const { ingestKey } = connectionOf(bundle);
  if (ingestKey === "") {
    throw new zapier.errors.Error(
      "Ingest key missing. Reconnect LogBrew with an ingest key to send logs.",
      "missing_ingest_key",
      status.badRequest,
    );
  }
  const data = {
    attributes: log.attributes,
    id: crypto.randomUUID(),
    level: log.level,
    message: log.message,
    occurred_at: new Date().toISOString(),
    source: "zapier",
  };
  const reply = await call(zapier, bundle, {
    body: {
      environment: log.environment,
      items: [{ data, type: "log" }],
      project_id: log.projectId,
      release: log.release,
      sdk_name: "logbrew-zapier",
      sdk_version: appVersion,
      service_name: log.serviceName,
    },
    key: ingestKey,
    method: "POST",
    path: "/api/telemetry/ingest",
  });
  return { ...(isFields(reply) ? reply : {}), id: data.id };
}

function levelOf(zapier: ZObject, value: string): Level {
  const level = levels.find((known) => known === value);
  if (level === undefined) {
    throw new zapier.errors.Error(
      `Unknown log level "${value}". Use debug, info, warning, error, or critical.`,
      "unknown_level",
      status.badRequest,
    );
  }
  return level;
}

export {
  type Alert,
  type Issue,
  type Project,
  appVersion,
  firedAlerts,
  isFields,
  levelOf,
  listProjects,
  newIssues,
  readIssues,
  resolveIssue,
  sendLog,
  text,
};
