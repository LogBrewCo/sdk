import { afterAll, beforeEach, expect, test } from "bun:test";
import { apiToken, ingestKey, projectId, startFixture } from "./fixture.js";
import app, { testConnection } from "./index.js";
import { createAppTester } from "zapier-platform-core";
import { file } from "bun";

const fixture = startFixture();
const appTester = createAppTester(app);
const authData: Readonly<Record<string, string>> = { apiToken, ingestKey };
const issueBase = "22222222-2222-4222-8222-2222222222";

function bundle(inputData: Readonly<Record<string, unknown>> = {}, auth = authData): object {
  return { authData: auth, inputData, meta: { isLoadingSample: false } };
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no error";
}

function query(requests: readonly Readonly<{ query: string }>[]): URLSearchParams {
  const [request] = requests;
  return new URLSearchParams(request?.query);
}

beforeEach(() => {
  process.env["LOGBREW_API_URL"] = `${fixture.url}/`;
  fixture.requests.length = 0;
});

afterAll(async () => {
  await fixture.stop();
});

test("the app version matches the package and its Zapier platform", async () => {
  const manifest: unknown = await file(new URL("../package.json", import.meta.url)).json();
  expect(manifest).toMatchObject({ dependencies: { "zapier-platform-core": app.platformVersion }, version: app.version });
});

test("the connection test reads projects with the API token and labels the connection", async () => {
  const label = await appTester(testConnection, bundle());
  expect(label).toEqual({ label: "Checkout, Mobile, Search + 1 more" });
  expect(fixture.requests).toEqual([
    { authorization: `Bearer ${apiToken}`, body: undefined, method: "GET", path: "/api/projects", query: "" },
  ]);
});

test("the connection test shows the LogBrew error and its next step", async () => {
  const message = await failure(async () => appTester(testConnection, bundle({}, { ...authData, apiToken: "wrong" })));
  expect(message).toContain("Invalid or expired token. send Authorization: Bearer <token> (HTTP 401)");
});

test("the project dropdown lists active projects", async () => {
  const projects = await appTester(app.triggers.project.operation.perform, bundle());
  expect(projects).toEqual([
    { id: projectId, name: "Checkout" },
    { id: "project-mobile", name: "Mobile" },
    { id: "project-search", name: "Search" },
    { id: "project-web", name: "Web" },
  ]);
});

test("the issue dropdown lists unresolved issues", async () => {
  const issues = await appTester(app.triggers.issue.operation.perform, bundle());
  expect(issues.map((issue) => issue.id)).toEqual([`${issueBase}01`, `${issueBase}02`, `${issueBase}03`]);
  expect(query(fixture.requests)).toEqual(
    new URLSearchParams({ limit: "100", pagination: "cursor", response_version: "7", status: "unresolved" }),
  );
});

test("new issue returns issues first seen in the last day, newest first", async () => {
  const issues = await appTester(app.triggers.new_issue.operation.perform, bundle({ projectId }));
  expect(issues.map((issue) => issue.title)).toEqual(["TypeError in checkout", "PaymentError: card authorization timed out"]);
  const [, payment] = issues;
  expect(payment).toMatchObject({
    id: `${issueBase}01`,
    occurrence_count: 3,
    severity: "critical",
    url: `${fixture.url}/dashboard/issues/${issueBase}01`,
  });
  expect(query(fixture.requests)).toEqual(
    new URLSearchParams({ limit: "100", pagination: "cursor", project_id: projectId, response_version: "7", since: "24h" }),
  );
});

test("new issue loads older issues as samples", async () => {
  const issues = await appTester(app.triggers.new_issue.operation.perform, {
    ...bundle({ projectId }),
    meta: { isLoadingSample: true },
  });
  expect(issues.map((issue) => issue.id)).toEqual([`${issueBase}03`, `${issueBase}01`, `${issueBase}02`]);
  expect(query(fixture.requests).has("since")).toBe(false);
});

test("new alert returns one item per firing, newest first", async () => {
  const alerts = await appTester(app.triggers.new_alert.operation.perform, bundle({ projectId }));
  expect(alerts.map((alert) => alert.rule_id)).toEqual(["rule-new-issue", "rule-spike"]);
  const [latest] = alerts;
  expect(latest).toMatchObject({ environment: "production", name: "New production issue", service: "" });
  expect(latest?.id).toBe(`rule-new-issue@${String(latest?.fired_at)}`);
  expect(fixture.requests.map((request) => request.path)).toEqual([`/api/projects/${projectId}/alert-rules`]);
});

test("send log posts one log line with the ingest key", async () => {
  const sent = await appTester(
    app.creates.send_log.operation.perform,
    bundle({
      attributes: { order_id: "A-1001" },
      environment: "staging",
      level: "error",
      message: "Payment failed",
      projectId,
      release: "zap",
      serviceName: "billing-zap",
    }),
  );
  const [request] = fixture.requests;
  expect(request).toMatchObject({
    authorization: `Bearer ${ingestKey}`,
    body: {
      environment: "staging",
      items: [
        {
          data: { attributes: { order_id: "A-1001" }, id: sent["id"], level: "error", message: "Payment failed", source: "zapier" },
          type: "log",
        },
      ],
      project_id: projectId,
      release: "zap",
      sdk_name: "logbrew-zapier",
      sdk_version: app.version,
      service_name: "billing-zap",
    },
    method: "POST",
    path: "/api/telemetry/ingest",
  });
  expect(sent).toMatchObject({ logs: 1 });
});

test("send log refuses a missing ingest key and an unknown level before any request", async () => {
  const input = { level: "info", message: "Payment failed", projectId, release: "zap", serviceName: "billing-zap" };
  const { perform } = app.creates.send_log.operation;
  const withoutKey = await failure(async () => appTester(perform, bundle(input, { ...authData, ingestKey: "" })));
  expect(withoutKey).toContain("Ingest key missing. Reconnect LogBrew with an ingest key to send logs.");
  const badLevel = await failure(async () => appTester(perform, bundle({ ...input, level: "loud" })));
  expect(badLevel).toContain("Unknown log level");
  expect(fixture.requests).toEqual([]);
});

test("resolve issue marks the issue resolved", async () => {
  const issue = await appTester(app.creates.resolve_issue.operation.perform, bundle({ issueId: `${issueBase}01` }));
  expect(issue).toMatchObject({ id: `${issueBase}01`, status: "resolved" });
  expect(fixture.requests).toEqual([
    {
      authorization: `Bearer ${apiToken}`,
      body: { status: "resolved" },
      method: "PATCH",
      path: `/api/telemetry/issues/${issueBase}01`,
      query: "?response_version=5",
    },
  ]);
});

test("resolve issue shows the LogBrew error for an unknown issue", async () => {
  const message = await failure(async () => appTester(app.creates.resolve_issue.operation.perform, bundle({ issueId: "missing" })));
  expect(message).toContain("Issue not found. Check the issue ID (HTTP 404)");
});
