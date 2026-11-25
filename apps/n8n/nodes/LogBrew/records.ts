type Fields = Readonly<Record<string, unknown>>;

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
  id: string;
  kind: string;
  last_fired_at: string;
  name: string;
  project_id: string;
  service: string;
}>;

const missingCount = 0;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(fields: Fields, key: string): string {
  const value = fields[key];
  return typeof value === "string" ? value : "";
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
  const id = text(value, "id");
  const lastFiredAt = text(value, "last_fired_at");
  if (id === "" || Number.isNaN(Date.parse(lastFiredAt))) {
    return undefined;
  }
  return {
    environment: text(value, "environment"),
    id,
    kind: text(value, "kind"),
    last_fired_at: lastFiredAt,
    name: text(value, "name"),
    project_id: text(value, "project_id"),
    service: text(value, "service"),
  };
}

function compact<Item>(items: readonly (Item | undefined)[]): readonly Item[] {
  return items.filter((item): item is Item => item !== undefined);
}

export { type Alert, type Fields, type Issue, compact, isFields, parseAlert, parseIssue, text };
