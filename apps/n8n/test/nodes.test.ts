import { apiToken, ingestKey, paymentIssue, projectId, resetIssue, startFixture, typeIssue } from "./fixture";
import { fieldsOf, firstIndex, firstOf, outputOf, pick } from "./values";
import type { Fields } from "./values";
import { LogBrew } from "../nodes/LogBrew/LogBrew.node";
import { LogBrewApi } from "../credentials/LogBrewApi.credentials";
import { LogBrewTrigger } from "../nodes/LogBrewTrigger/LogBrewTrigger.node";

type Options = Readonly<{
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  method?: string;
  qs?: Readonly<Record<string, string>>;
  url: string;
}>;

type Setup = Readonly<{
  continueOnFail?: boolean;
  credentials?: Readonly<Record<string, string>>;
  items?: number;
  mode?: string;
  parameters: Readonly<Record<string, unknown>>;
  state?: Readonly<Record<string, unknown>>;
}>;

const fixture = startFixture();
const oneItem = 1;
const twoItems = 2;
const secondIndex = 1;
const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

afterAll(async () => {
  await fixture.stop();
});

async function fetchReply(options: Options): Promise<Readonly<{ body: unknown; statusCode: number }>> {
  const url = new URL(options.url);
  for (const [key, value] of Object.entries(options.qs ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...options.headers },
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body: unknown = await response.json();
  return { body, statusCode: response.status };
}

function context(setup: Setup): Fields {
  const credentials = { apiToken, apiUrl: fixture.url, ingestKey, ...setup.credentials };
  const state = setup.state ?? {};
  return {
    continueOnFail: () => setup.continueOnFail === true,
    getCredentials: async () => credentials,
    getInputData: () => Array.from({ length: setup.items ?? oneItem }, () => ({ json: {} })),
    getMode: () => setup.mode ?? "trigger",
    getNodeParameter: (name: string, ...rest: readonly unknown[]) => {
      const [fallback] = rest.toReversed();
      return setup.parameters[name] ?? fallback;
    },
    getWorkflowStaticData: () => state,
    helpers: {
      httpRequest: fetchReply,
      httpRequestWithAuthentication: async (_name: string, options: Options) =>
        fetchReply({ ...options, headers: { Authorization: `Bearer ${credentials.apiToken}` } }),
    },
  };
}

async function call(target: unknown, self: Fields): Promise<unknown> {
  if (typeof target !== "function") {
    throw new TypeError("not a method");
  }
  const result: unknown = await Reflect.apply(target, self, []);
  return result;
}

async function run(node: object, method: string, setup: Setup): Promise<unknown> {
  return call(Reflect.get(node, method), context(setup));
}

async function loadProjects(node: object): Promise<unknown> {
  const methods: unknown = Reflect.get(node, "methods");
  const loadOptions: unknown = typeof methods === "object" && methods !== null ? Reflect.get(methods, "loadOptions") : {};
  const loader: unknown = typeof loadOptions === "object" && loadOptions !== null ? Reflect.get(loadOptions, "getProjects") : undefined;
  return call(loader, context({ parameters: {} }));
}

async function failureOf(node: object, method: string, setup: Setup): Promise<string> {
  try {
    await run(node, method, setup);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

function lastRequest(): (typeof fixture.requests)[number] | undefined {
  const [last] = fixture.requests.toReversed();
  return last;
}

function sentLog(): Readonly<{ data: Fields; sent: Fields }> {
  const sent = fieldsOf(lastRequest()?.body);
  const item = firstOf(sent["items"]);
  return { data: fieldsOf(fieldsOf(item)["data"]), sent };
}

test("credential tests the API token against the project list", () => {
  const credential = new LogBrewApi();
  expect(credential.test.request).toEqual({ baseURL: "={{$credentials.apiUrl}}", url: "/api/projects" });
  expect(credential.authenticate.properties.headers).toEqual({ Authorization: "=Bearer {{$credentials.apiToken}}" });
});

test("trigger lists only active projects", async () => {
  expect(await loadProjects(new LogBrewTrigger())).toEqual([{ name: "Checkout", value: projectId }]);
  expect(await loadProjects(new LogBrew())).toEqual([{ name: "Checkout", value: projectId }]);
});

test("trigger reads every issue page after the cursor and emits new issues oldest first, then nothing", async () => {
  const state: Record<string, unknown> = { cursor: "2026-11-25T10:00:00Z" };
  const setup = { parameters: { event: "issueCreated", projectId }, state };
  const sent = fixture.requests.length;
  const first = await run(new LogBrewTrigger(), "poll", setup);
  expect(pick(first, ["id", "severity", "url"])).toEqual([
    [resetIssue.id, "warning", `${fixture.url}/dashboard/issues/${resetIssue.id}`],
    [typeIssue.id, "error", `${fixture.url}/dashboard/issues/${typeIssue.id}`],
  ]);
  const page = `?limit=500&pagination=cursor&response_version=7&project_id=${projectId}&since=2026-11-25T10%3A00%3A00Z`;
  expect(fixture.requests.slice(sent).map((request) => request.query)).toEqual([
    page,
    `${page}&cursor_id=${paymentIssue.id}&cursor_time=2026-11-25T12%3A00%3A00Z`,
  ]);
  expect(state["cursor"]).toBe("2026-11-25T11:30:00Z");
  expect(await run(new LogBrewTrigger(), "poll", setup)).toBeNull();
});

test("trigger starts from now on the first poll", async () => {
  const state: Record<string, unknown> = {};
  const before = Date.now();
  expect(await run(new LogBrewTrigger(), "poll", { parameters: { event: "issueCreated", projectId }, state })).toBeNull();
  expect(Date.parse(String(state["cursor"]))).toBeGreaterThanOrEqual(before);
});

test("trigger shows the newest issue of the first page in a manual test", async () => {
  const sent = fixture.requests.length;
  const result = await run(new LogBrewTrigger(), "poll", { mode: "manual", parameters: { event: "issueCreated", projectId } });
  expect(pick(result, ["id", "severity"])).toEqual([[typeIssue.id, "error"]]);
  expect(fixture.requests.slice(sent).map((request) => request.query)).toEqual([
    `?limit=500&pagination=cursor&response_version=7&project_id=${projectId}`,
  ]);
});

test("trigger uses the issue's triage severity", async () => {
  const state: Record<string, unknown> = { cursor: "2026-11-25T08:00:00Z" };
  const result = await run(new LogBrewTrigger(), "poll", { parameters: { event: "issueCreated", projectId }, state });
  expect(pick(result, ["id", "severity"])).toEqual([
    [paymentIssue.id, "critical"],
    [resetIssue.id, "warning"],
    [typeIssue.id, "error"],
  ]);
});

test("trigger emits alert rules that fired after the cursor", async () => {
  const state: Record<string, unknown> = { cursor: "2026-11-25T09:00:00Z" };
  const setup = { parameters: { event: "alertFired", projectId }, state };
  const result = await run(new LogBrewTrigger(), "poll", setup);
  expect(outputOf(result)).toEqual([
    {
      json: {
        environment: "production",
        id: "33333333-3333-4333-8333-333333333301",
        kind: "new_issue",
        last_fired_at: "2026-11-25T11:31:00Z",
        name: "New production issue",
        project_id: projectId,
        service: "",
      },
    },
  ]);
  expect(lastRequest()?.path).toBe(`/api/projects/${projectId}/alert-rules`);
  expect(state["cursor"]).toBe("2026-11-25T11:31:00Z");
  expect(await run(new LogBrewTrigger(), "poll", setup)).toBeNull();
});

test("trigger shows the most recent alert in a manual test", async () => {
  const result = await run(new LogBrewTrigger(), "poll", { mode: "manual", parameters: { event: "alertFired", projectId } });
  expect(pick(result, ["name"])).toEqual([["New production issue"]]);
});

test("trigger reports a rejected API token with LogBrew's message", async () => {
  const setup = { credentials: { apiToken: "lbw_pat_wrong" }, parameters: { event: "issueCreated", projectId } };
  expect(await failureOf(new LogBrewTrigger(), "poll", setup)).toBe(
    "Invalid or expired token. send Authorization: Bearer <token> (HTTP 401)",
  );
});

test("node sends a log with the ingest key", async () => {
  const result = await run(new LogBrew(), "execute", {
    parameters: {
      attributes: '{ "order_id": "A-1001" }',
      environment: "staging",
      level: "warning",
      message: "Order sync retried",
      operation: "send",
      projectId,
      release: "workflow",
      resource: "log",
      serviceName: "n8n",
    },
  });
  expect(pick(result, ["logs"])).toEqual([[oneItem]]);
  expect(lastRequest()?.authorization).toBe(`Bearer ${ingestKey}`);
  const { data, sent } = sentLog();
  expect(String(data["id"])).toMatch(uuid);
  const occurredAt = Date.parse(String(data["occurred_at"]));
  const shape: Fields = { envelope: { ...sent, items: [] }, log: { ...data, id: "", occurred_at: "" }, timed: !Number.isNaN(occurredAt) };
  expect(shape).toEqual({
    envelope: {
      environment: "staging",
      items: [],
      project_id: projectId,
      release: "workflow",
      sdk_name: "n8n-nodes-logbrew",
      sdk_version: "0.1.0",
      service_name: "n8n",
    },
    log: {
      attributes: { order_id: "A-1001" },
      id: "",
      level: "warning",
      message: "Order sync retried",
      occurred_at: "",
      source: "n8n",
    },
    timed: true,
  });
});

test("node asks for an ingest key before it sends a log", async () => {
  const setup = {
    credentials: { ingestKey: "" },
    parameters: { level: "info", message: "hello", operation: "send", projectId, resource: "log" },
  };
  expect(await failureOf(new LogBrew(), "execute", setup)).toBe(
    "Ingest key missing. Add one to the LogBrew credential to send logs.",
  );
});

test("node rejects an unknown log level", async () => {
  const setup = { parameters: { level: "fatal", message: "hello", operation: "send", projectId, resource: "log" } };
  expect(await failureOf(new LogBrew(), "execute", setup)).toBe(
    'Unknown log level "fatal". Use debug, info, warning, error, or critical.',
  );
});

test("node resolves an issue", async () => {
  const { id } = paymentIssue;
  const result = await run(new LogBrew(), "execute", { parameters: { issueId: id, operation: "resolve", resource: "issue" } });
  expect(pick(result, ["id", "status"])).toEqual([[id, "resolved"]]);
  expect(outputOf(result).map((item) => item["pairedItem"])).toEqual([{ item: firstIndex }]);
  expect(lastRequest()).toEqual({
    authorization: `Bearer ${apiToken}`,
    body: { status: "resolved" },
    method: "PATCH",
    path: `/api/telemetry/issues/${id}`,
    query: "?response_version=5",
  });
});

test("node keeps going with the error when the workflow continues on fail", async () => {
  const result = await run(new LogBrew(), "execute", {
    continueOnFail: true,
    items: twoItems,
    parameters: { issueId: "22222222-2222-4222-8222-222222222204", operation: "resolve", resource: "issue" },
  });
  const error = "Insufficient permissions. ask a project owner for permission to manage issues (HTTP 403)";
  expect(outputOf(result)).toEqual([
    { json: { error }, pairedItem: { item: firstIndex } },
    { json: { error }, pairedItem: { item: secondIndex } },
  ]);
});
