import type { Alert, Fields, Issue } from "./records";
import { compact, isFields, parseAlert, parseIssue, text } from "./records";

type Query = Readonly<Record<string, string>>;

type Request = Readonly<{
  body?: Readonly<Record<string, unknown>>;
  credential: "apiToken" | "ingestKey";
  method: "GET" | "PATCH" | "POST";
  path: string;
  query?: Query;
}>;

type Reply = Readonly<{ body: unknown; status: number }>;

type Send = (request: Request) => Promise<Reply>;

type Poll<Item> = Readonly<{ cursor: string; items: readonly Item[] }>;

type IssuePage = Readonly<{ issues: readonly Issue[]; next: Query | undefined }>;

type IssueRead = Readonly<{ apiUrl: string; filter: Query; pages: number }>;

type Level = "critical" | "debug" | "error" | "info" | "warning";

type Log = Readonly<{
  attributes: Fields;
  environment: string;
  id: string;
  level: Level;
  message: string;
  occurredAt: string;
  projectId: string;
  release: string;
  serviceName: string;
}>;

const defaultApiUrl = "https://api.logbrew.co";
const issueLimit = "500";
const issueListVersion = "7";
const issueVersion = "5";
const onePage = 1;
const pollPages = 20;
const okStatus = 200;
const noHttpStatus = 0;
const sdkName = "n8n-nodes-logbrew";
const sdkVersion = "0.1.3";
const levels: readonly Level[] = ["debug", "info", "warning", "error", "critical"];

class LogBrewError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.name = "LogBrewError";
    this.status = status;
  }
}

function failure(reply: Reply): LogBrewError {
  const body = isFields(reply.body) ? reply.body : {};
  const detail =
    [text(body, "error"), text(body, "next")].filter((part) => part !== "").join(". ") ||
    "LogBrew did not accept the request";
  return new LogBrewError(reply.status, `${detail} (HTTP ${String(reply.status)})`);
}

async function call(send: Send, request: Request): Promise<unknown> {
  const reply = await send(request);
  if (reply.status !== okStatus) {
    throw failure(reply);
  }
  return reply.body;
}

function listOf(body: unknown): readonly unknown[] {
  if (!Array.isArray(body)) {
    throw new LogBrewError(okStatus, "LogBrew sent a list in an unknown format");
  }
  return body;
}

function dashboardOrigin(apiUrl: string): string {
  const url = new URL(apiUrl);
  const host = url.host.startsWith("api.") ? url.host.slice("api.".length) : url.host;
  return `${url.protocol}//${host}`;
}

function newerThan<Item>(items: readonly Item[], cursor: string, at: (item: Item) => string): Poll<Item> {
  const since = Date.parse(cursor);
  const fresh = items
    .filter((item) => Date.parse(at(item)) > since)
    .toSorted((left, right) => Date.parse(at(left)) - Date.parse(at(right)));
  const [last] = fresh.toReversed();
  return { cursor: last === undefined ? cursor : at(last), items: fresh };
}

function newest<Item>(items: readonly Item[], at: (item: Item) => string): readonly Item[] {
  const [first] = items.toSorted((left, right) => Date.parse(at(right)) - Date.parse(at(left)));
  return first === undefined ? [] : [first];
}

async function listProjects(send: Send): Promise<readonly Readonly<{ id: string; name: string }>[]> {
  const body = await call(send, { credential: "apiToken", method: "GET", path: "/api/projects" });
  return compact(
    listOf(body).map((value) => {
      if (!isFields(value) || value["is_active"] === false) {
        return undefined;
      }
      const project = { id: text(value, "id"), name: text(value, "name") };
      return project.id === "" ? undefined : project;
    }),
  );
}

function issuePage(body: unknown, dashboard: string): IssuePage {
  const page = isFields(body) ? body : {};
  const next = page["next_cursor"];
  return {
    issues: compact(listOf(page["issues"]).map((value) => parseIssue(value, dashboard))),
    next: isFields(next) ? { cursor_id: text(next, "id"), cursor_time: text(next, "time") } : undefined,
  };
}

async function readIssues(send: Send, read: IssueRead): Promise<readonly Issue[]> {
  const { apiUrl, filter, pages } = read;
  const query = { limit: issueLimit, pagination: "cursor", response_version: issueListVersion, ...filter };
  const body = await call(send, { credential: "apiToken", method: "GET", path: "/api/telemetry/issues", query });
  const page = issuePage(body, dashboardOrigin(apiUrl));
  if (page.next === undefined || pages <= onePage) {
    return page.issues;
  }
  const rest = await readIssues(send, { apiUrl, filter: { ...filter, ...page.next }, pages: pages - onePage });
  return [...page.issues, ...rest];
}

async function pollNewIssues(
  send: Send,
  where: Readonly<{ apiUrl: string; cursor: string; projectId: string }>,
): Promise<Poll<Issue>> {
  const { apiUrl, cursor, projectId } = where;
  const issues = await readIssues(send, { apiUrl, filter: { project_id: projectId, since: cursor }, pages: pollPages });
  return newerThan(issues, cursor, (issue) => issue.first_seen_at);
}

async function latestIssue(send: Send, apiUrl: string, projectId: string): Promise<readonly Issue[]> {
  const issues = await readIssues(send, { apiUrl, filter: { project_id: projectId }, pages: onePage });
  return newest(issues, (issue) => issue.first_seen_at);
}

async function readAlerts(send: Send, projectId: string): Promise<readonly Alert[]> {
  const path = `/api/projects/${encodeURIComponent(projectId)}/alert-rules`;
  const body = await call(send, { credential: "apiToken", method: "GET", path });
  const rules = isFields(body) ? body["rules"] : undefined;
  return compact(listOf(rules).map((value) => parseAlert(value)));
}

async function pollFiredAlerts(send: Send, projectId: string, cursor: string): Promise<Poll<Alert>> {
  const alerts = await readAlerts(send, projectId);
  return newerThan(alerts, cursor, (alert) => alert.last_fired_at);
}

async function latestAlert(send: Send, projectId: string): Promise<readonly Alert[]> {
  return newest(await readAlerts(send, projectId), (alert) => alert.last_fired_at);
}

async function resolveIssue(send: Send, apiUrl: string, issueId: string): Promise<Issue> {
  const path = `/api/telemetry/issues/${encodeURIComponent(issueId)}`;
  const body = await call(send, {
    body: { status: "resolved" },
    credential: "apiToken",
    method: "PATCH",
    path,
    query: { response_version: issueVersion },
  });
  const issue = parseIssue(body, dashboardOrigin(apiUrl));
  if (issue === undefined) {
    throw new LogBrewError(okStatus, "LogBrew sent an issue in an unknown format");
  }
  return issue;
}

async function sendLog(send: Send, log: Log): Promise<unknown> {
  const body = {
    environment: log.environment,
    items: [
      {
        data: {
          attributes: log.attributes,
          id: log.id,
          level: log.level,
          message: log.message,
          occurred_at: log.occurredAt,
          source: "n8n",
        },
        type: "log",
      },
    ],
    project_id: log.projectId,
    release: log.release,
    sdk_name: sdkName,
    sdk_version: sdkVersion,
    service_name: log.serviceName,
  };
  return call(send, { body, credential: "ingestKey", method: "POST", path: "/api/telemetry/ingest" });
}

function levelOf(value: string): Level {
  const level = levels.find((known) => known === value);
  if (level === undefined) {
    throw new LogBrewError(noHttpStatus, `Unknown log level "${value}". Use debug, info, warning, error, or critical.`);
  }
  return level;
}

export {
  type Log,
  type Poll,
  type Reply,
  type Request,
  type Send,
  LogBrewError,
  defaultApiUrl,
  latestAlert,
  latestIssue,
  levelOf,
  listProjects,
  noHttpStatus,
  pollFiredAlerts,
  pollNewIssues,
  resolveIssue,
  sendLog,
};
