import type { ErrorLog, Issue, Outcome, Project, Reply } from "./api";
import { readErrorLogs, readIssues, readProjects } from "./api";
import type { Platform } from "./session";
import { getAuthorized } from "./session";

type Origins = Readonly<{ api: string; dashboard: string }>;

type NewIssues = Readonly<{ capped: boolean; count: number; latest: readonly Issue[] }>;

type Filters = Readonly<Record<string, string | undefined>>;

const day = 86_400_000;
const pageLimit = 500;
const errorLimit = 100;
const latestShown = 10;
const start = 0;
const apiPrefix = "api.";

function originsFrom(apiUrl: string): Origins | undefined {
  try {
    const url = new URL(apiUrl.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return undefined;
    }
    const api = `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
    const dashboardHost = url.host.startsWith(apiPrefix) ? url.host.slice(apiPrefix.length) : url.host;
    return { api, dashboard: `${url.protocol}//${dashboardHost}` };
  } catch {
    return undefined;
  }
}

function issueLink(origins: Origins, issue: Issue): string {
  return `${origins.dashboard}/dashboard/issues/${encodeURIComponent(issue.id)}`;
}

function errorLogLink(origins: Origins, log: ErrorLog): string {
  if (log.traceId === "") {
    return `${origins.dashboard}/dashboard/logs`;
  }
  return `${origins.dashboard}/dashboard/traces?trace=${encodeURIComponent(log.traceId)}`;
}

function query(fields: Filters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      params.set(key, value);
    }
  }
  return params.toString();
}

async function read<Value>(
  platform: Platform,
  path: string,
  parse: (reply: Reply) => Outcome<Value>,
): Promise<Outcome<Value>> {
  const reply = await getAuthorized(platform, path);
  return reply.kind === "ok" ? parse(reply.value) : reply;
}

async function listProjects(platform: Platform): Promise<Outcome<readonly Project[]>> {
  const projects = await read(platform, "/api/projects", readProjects);
  if (projects.kind !== "ok") {
    return projects;
  }
  return { kind: "ok", value: projects.value.toSorted((left, right) => left.name.localeCompare(right.name)) };
}

async function listIssues(platform: Platform, projectId: string): Promise<Outcome<readonly Issue[]>> {
  const filters = query({
    limit: String(pageLimit),
    project_id: projectId === "" ? undefined : projectId,
    response_version: "4",
    status: "unresolved",
  });
  const issues = await read(platform, `/api/telemetry/issues?${filters}`, readIssues);
  if (issues.kind !== "ok") {
    return issues;
  }
  return { kind: "ok", value: issues.value.toSorted((left, right) => right.lastSeenAt - left.lastSeenAt) };
}

async function listNewIssues(platform: Platform): Promise<Outcome<NewIssues>> {
  const filters = query({ limit: String(pageLimit), response_version: "4", since: "24h", status: "unresolved" });
  const issues = await read(platform, `/api/telemetry/issues?${filters}`, readIssues);
  if (issues.kind !== "ok") {
    return issues;
  }
  const since = platform.now() - day;
  const fresh = issues.value
    .filter((issue) => issue.firstSeenAt >= since)
    .toSorted((left, right) => right.firstSeenAt - left.firstSeenAt);
  return {
    kind: "ok",
    value: { capped: issues.value.length >= pageLimit, count: fresh.length, latest: fresh.slice(start, latestShown) },
  };
}

async function listRecentErrors(platform: Platform, projectId: string): Promise<Outcome<readonly ErrorLog[]>> {
  const pages = await Promise.all(
    ["critical", "error"].map(async (severity) => {
      const filters = query({ limit: String(errorLimit), project_id: projectId, severity, since: "24h" });
      return read(platform, `/api/logs?${filters}`, readErrorLogs);
    }),
  );
  const failed = pages.find((page) => page.kind !== "ok");
  if (failed !== undefined) {
    return failed;
  }
  const logs = pages.flatMap((page) => (page.kind === "ok" ? page.value : []));
  return {
    kind: "ok",
    value: logs.toSorted((left, right) => right.occurredAt - left.occurredAt).slice(start, errorLimit),
  };
}

export {
  type NewIssues,
  type Origins,
  errorLogLink,
  issueLink,
  listIssues,
  listNewIssues,
  listProjects,
  listRecentErrors,
  originsFrom,
};
