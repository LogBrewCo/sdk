import type { Alert, Issue, Project } from "./api.js";
import type { Bundle, ZObject } from "zapier-platform-core";
import {
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
} from "./api.js";
import { defineApp, version as platformVersion } from "zapier-platform-core";

const shownProjects = 3;
const noneHidden = 0;

const projectField = {
  dynamic: "project.id.name",
  helpText: "The LogBrew project to watch.",
  key: "projectId",
  label: "Project",
  required: true,
} as const;

const issueSample: Issue = {
  environment: "production",
  first_seen_at: "2026-11-25T09:00:00Z",
  id: "22222222-2222-4222-8222-222222222201",
  last_seen_at: "2026-11-25T12:00:00Z",
  message: "card authorization timed out",
  occurrence_count: 4,
  project_id: "11111111-1111-4111-8111-111111111111",
  release: "api@1.2.3",
  service_name: "checkout-api",
  severity: "critical",
  status: "unresolved",
  title: "PaymentError: card authorization timed out",
  url: "https://logbrew.co/dashboard/issues/22222222-2222-4222-8222-222222222201",
};

const alertSample: Alert = {
  environment: "production",
  fired_at: "2026-11-25T11:31:00Z",
  id: "33333333-3333-4333-8333-333333333301@2026-11-25T11:31:00Z",
  kind: "new_issue",
  name: "New production issue",
  project_id: "11111111-1111-4111-8111-111111111111",
  rule_id: "33333333-3333-4333-8333-333333333301",
  service: "",
};

const issueOutput = [
  { key: "id", label: "Issue ID" },
  { key: "title", label: "Title" },
  { key: "message", label: "Message" },
  { key: "severity", label: "Severity" },
  { key: "status", label: "Status" },
  { key: "occurrence_count", label: "Occurrences", type: "integer" },
  { key: "first_seen_at", label: "First Seen", type: "datetime" },
  { key: "last_seen_at", label: "Last Seen", type: "datetime" },
  { key: "service_name", label: "Service" },
  { key: "environment", label: "Environment" },
  { key: "release", label: "Release" },
  { key: "project_id", label: "Project ID" },
  { key: "url", label: "Issue URL" },
] as const;

function input(bundle: Bundle, key: string): string {
  return text(bundle.inputData, key);
}

async function testConnection(zapier: ZObject, bundle: Bundle): Promise<Readonly<{ label: string }>> {
  const found = await listProjects(zapier, bundle);
  const shown = found.filter((_project, index) => index < shownProjects).map((project) => project.name);
  const hidden = found.length - shown.length;
  return { label: hidden === noneHidden ? shown.join(", ") : `${shown.join(", ")} + ${String(hidden)} more` };
}

async function projects(zapier: ZObject, bundle: Bundle): Promise<Project[]> {
  const found = await listProjects(zapier, bundle);
  return [...found];
}

async function issues(zapier: ZObject, bundle: Bundle): Promise<Issue[]> {
  const found = await newIssues(zapier, bundle, input(bundle, "projectId"));
  return [...found];
}

async function openIssues(zapier: ZObject, bundle: Bundle): Promise<Issue[]> {
  const found = await readIssues(zapier, bundle, { status: "unresolved" });
  return [...found];
}

async function alerts(zapier: ZObject, bundle: Bundle): Promise<Alert[]> {
  const found = await firedAlerts(zapier, bundle, input(bundle, "projectId"));
  return [...found];
}

async function resolve(zapier: ZObject, bundle: Bundle): Promise<Issue> {
  return resolveIssue(zapier, bundle, input(bundle, "issueId"));
}

async function log(zapier: ZObject, bundle: Bundle): Promise<Readonly<Record<string, unknown>>> {
  const { attributes } = bundle.inputData;
  return sendLog(zapier, bundle, {
    attributes: isFields(attributes) ? attributes : {},
    environment: input(bundle, "environment") || "production",
    level: levelOf(zapier, input(bundle, "level") || "info"),
    message: input(bundle, "message"),
    projectId: input(bundle, "projectId"),
    release: input(bundle, "release"),
    serviceName: input(bundle, "serviceName"),
  });
}

const app = defineApp({
  authentication: {
    connectionLabel: "{{bundle.inputData.label}}",
    fields: [
      {
        helpText:
          "Create a token on the [API page](https://logbrew.co/account/api) of your LogBrew account, with **Projects** read, **Telemetry** read, **Issues** write, and **Alerts** read access.",
        key: "apiToken",
        label: "API Token",
        required: true,
        type: "password",
      },
      {
        helpText:
          "Only **Send Log** needs it. Open your project in [LogBrew projects](https://logbrew.co/dashboard/projects) and create an ingest key.",
        key: "ingestKey",
        label: "Ingest Key",
        required: false,
        type: "password",
      },
    ],
    test: testConnection,
    type: "custom",
  },
  creates: {
    resolve_issue: {
      display: { description: "Marks a LogBrew issue resolved. LogBrew reopens it if the error comes back.", label: "Resolve Issue" },
      key: "resolve_issue",
      noun: "Issue",
      operation: {
        inputFields: [
          {
            dynamic: "issue.id.title",
            helpText: "The issue to resolve. Pick an unresolved issue, or map the ID from **New Issue**.",
            key: "issueId",
            label: "Issue ID",
            required: true,
          },
        ],
        outputFields: [...issueOutput],
        perform: resolve,
        sample: { ...issueSample, status: "resolved" },
      },
    },
    send_log: {
      display: { description: "Sends a log line with a level, a message, and your own attributes.", label: "Send Log" },
      key: "send_log",
      noun: "Log",
      operation: {
        inputFields: [
          { ...projectField, helpText: "The project that receives the log. Use the project of your ingest key." },
          { key: "message", label: "Message", required: true, type: "text" },
          {
            choices: { critical: "Critical", debug: "Debug", error: "Error", info: "Info", warning: "Warning" },
            default: "info",
            key: "level",
            label: "Level",
            required: true,
          },
          {
            default: "zapier",
            helpText: "The service that LogBrew groups this log under.",
            key: "serviceName",
            label: "Service",
            required: true,
          },
          {
            default: "zap",
            helpText: "The release, version, or commit of the service.",
            key: "release",
            label: "Release",
            required: true,
          },
          { default: "production", key: "environment", label: "Environment", required: false },
          {
            dict: true,
            helpText: "Extra fields to store with the log, such as an order ID.",
            key: "attributes",
            label: "Attributes",
            required: false,
          },
        ],
        outputFields: [
          { key: "id", label: "Log ID" },
          { key: "logs", label: "Logs Accepted", type: "integer" },
        ],
        perform: log,
        sample: { already_accepted: 0, id: "44444444-4444-4444-8444-444444444401", logs: 1 },
      },
    },
  },
  flags: { cleanInputData: false },
  platformVersion,
  triggers: {
    issue: {
      display: { description: "Lists your unresolved LogBrew issues.", hidden: true, label: "Issue" },
      key: "issue",
      noun: "Issue",
      operation: { perform: openIssues, sample: issueSample },
    },
    new_alert: {
      display: { description: "Triggers when one of a project's alert rules fires.", label: "New Alert" },
      key: "new_alert",
      noun: "Alert",
      operation: {
        inputFields: [projectField],
        outputFields: [
          { key: "id", label: "Alert ID" },
          { key: "name", label: "Rule Name" },
          { key: "kind", label: "Rule Kind" },
          { key: "fired_at", label: "Fired At", type: "datetime" },
          { key: "rule_id", label: "Rule ID" },
          { key: "environment", label: "Environment" },
          { key: "service", label: "Service" },
          { key: "project_id", label: "Project ID" },
        ],
        perform: alerts,
        sample: alertSample,
      },
    },
    new_issue: {
      display: { description: "Triggers when LogBrew sees an error for the first time in a project.", label: "New Issue" },
      key: "new_issue",
      noun: "Issue",
      operation: { inputFields: [projectField], outputFields: [...issueOutput], perform: issues, sample: issueSample },
    },
    project: {
      display: { description: "Lists your LogBrew projects.", hidden: true, label: "Project" },
      key: "project",
      noun: "Project",
      operation: { perform: projects, sample: { id: "11111111-1111-4111-8111-111111111111", name: "Checkout" } },
    },
  },
  version: appVersion,
});

export { testConnection };
export default app;
