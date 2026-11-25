import type { ErrorLog, Failure, Issue, Outcome, Project, Severity } from "@logbrew/raycast/api";
import type { Mark, Next, Topic } from "@logbrew/raycast/screens";
import { errorLogLink, issueLink, listIssues, listProjects, listRecentErrors } from "@logbrew/raycast/logbrew";
import type { Origins } from "@logbrew/raycast/logbrew";
import type { Platform } from "@logbrew/raycast/session";
import { screenOf } from "@logbrew/raycast/screens";

type Feed = Readonly<{ errors: Outcome<readonly ErrorLog[]>; issues: Outcome<readonly Issue[]>; project: Project }>;

type State =
  | Readonly<{ failure: Failure; kind: "failed" }>
  | Readonly<{ feed: Feed; kind: "ready"; projects: readonly Project[] }>
  | Readonly<{ kind: "badUrl" }>
  | Readonly<{ kind: "chooseProject"; projects: readonly Project[] }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "noProjects" }>
  | Readonly<{ kind: "signedOut" }>
  | Readonly<{ kind: "signingIn" }>;

type Item = Readonly<{
  at: number;
  detail: readonly string[];
  events: number | undefined;
  id: string;
  kind: "item";
  label: string;
  link: string;
  severity: Severity;
  source: string;
}>;

type Message = Readonly<{ description: string; kind: "message"; label: string; mark: Mark; next: Next }>;

type Row = Item | Message;

const shown = 50;
const first = 0;
const single = 1;
const per = { day: 30, hour: 24, minute: 60, month: 12, second: 60 } as const;
const steps: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["second", per.second],
  ["minute", per.minute],
  ["hour", per.hour],
  ["day", per.day],
  ["month", per.month],
];
const millisecondsPerSecond = 1000;

function slug(name: string): string {
  return name.normalize("NFKD").toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, "");
}

function pickProject(projects: readonly Project[], chosen: string | undefined, folders: readonly string[]): Project | undefined {
  const saved = projects.find((project) => project.id === chosen);
  if (saved !== undefined) {
    return saved;
  }
  const names = new Set(folders.map((folder) => slug(folder)));
  const matches = projects.filter((project) => names.has(slug(project.name)));
  if (matches.length === single) {
    return matches[first];
  }
  return projects.length === single ? projects[first] : undefined;
}

async function loadFeed(platform: Platform, project: Project, projects: readonly Project[]): Promise<State> {
  const [issues, errors] = await Promise.all([
    listIssues(platform, project.id),
    listRecentErrors(platform, project.id),
  ]);
  if (issues.kind === "signedOut" || errors.kind === "signedOut") {
    return { kind: "signedOut" };
  }
  return { feed: { errors, issues, project }, kind: "ready", projects };
}

async function load(platform: Platform, chosen: string | undefined, folders: readonly string[]): Promise<State> {
  const projects = await listProjects(platform);
  if (projects.kind === "signedOut") {
    return { kind: "signedOut" };
  }
  if (projects.kind === "failed") {
    return { failure: projects.failure, kind: "failed" };
  }
  if (projects.value.length === first) {
    return { kind: "noProjects" };
  }
  const project = pickProject(projects.value, chosen, folders);
  return project === undefined
    ? { kind: "chooseProject", projects: projects.value }
    : loadFeed(platform, project, projects.value);
}

function message<Value>(outcome: Outcome<readonly Value[]>, topic: Topic): Message {
  const screen =
    outcome.kind === "failed"
      ? screenOf({ failure: outcome.failure, kind: "failed" }, topic)
      : screenOf({ items: [], kind: "ready" }, topic);
  return { description: screen.description, kind: "message", label: screen.title, mark: screen.mark, next: screen.next };
}

function rows<Value>(outcome: Outcome<readonly Value[]>, topic: Topic, item: (value: Value) => Item): readonly Row[] {
  if (outcome.kind !== "ok" || outcome.value.length === first) {
    return [message(outcome, topic)];
  }
  return outcome.value.slice(first, shown).map((value) => item(value));
}

function issueRows(outcome: Outcome<readonly Issue[]>, origins: Origins): readonly Row[] {
  return rows(outcome, "issues", (issue) => ({
    at: issue.lastSeenAt,
    detail: [issue.message, issue.environment, issue.release].filter((part) => part !== "" && part !== issue.title),
    events: issue.occurrences,
    id: `issue:${issue.id}`,
    kind: "item",
    label: issue.title,
    link: issueLink(origins, issue),
    severity: issue.severity,
    source: issue.serviceName,
  }));
}

function errorRows(outcome: Outcome<readonly ErrorLog[]>, origins: Origins): readonly Row[] {
  return rows(outcome, "errors", (log) => {
    const [headline = "", ...rest] = log.message.split("\n");
    return {
      at: log.occurredAt,
      detail: [rest.join("\n").trim(), log.environment, log.release].filter((part) => part !== ""),
      events: undefined,
      id: `log:${log.id}`,
      kind: "item",
      label: headline.trim() === "" ? log.id : headline.trim(),
      link: errorLogLink(origins, log),
      severity: log.severity,
      source: log.serviceName,
    };
  });
}

function ago(at: number, now: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  let value = Math.round((at - now) / millisecondsPerSecond);
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) {
      return format.format(value, unit);
    }
    value = Math.round(value / size);
  }
  return format.format(value, "year");
}

export { type Feed, type Item, type Message, type Row, type State, ago, errorRows, issueRows, load, pickProject };
