import type { Alert, Issue, Poll } from "../LogBrew/client";
import type { BaseContext, Item, NodeDescription, Option, PollContext } from "../LogBrew/n8n";
import { connect, projectOptions } from "../LogBrew/transport";
import { latestAlert, latestIssue, pollFiredAlerts, pollNewIssues } from "../LogBrew/client";

type Found = Readonly<{ cursor: string; items: readonly (Alert | Issue)[] }>;

function parameter(context: PollContext, name: string): string {
  const value = context.getNodeParameter(name, "");
  return typeof value === "string" ? value : "";
}

async function find(context: PollContext, cursor: string): Promise<Found> {
  const { apiUrl, send } = await connect(context);
  const projectId = parameter(context, "projectId");
  const alerts = parameter(context, "event") === "alertFired";
  if (context.getMode() === "manual") {
    const items = alerts ? await latestAlert(send, projectId) : await latestIssue(send, apiUrl, projectId);
    return { cursor, items };
  }
  const found: Poll<Alert | Issue> = alerts
    ? await pollFiredAlerts(send, projectId, cursor)
    : await pollNewIssues(send, { apiUrl, cursor, projectId });
  return found;
}

class LogBrewTrigger {
  public readonly description: NodeDescription = {
    credentials: [{ name: "logBrewApi", required: true }],
    defaults: { name: "LogBrew Trigger" },
    description: "Start a workflow when LogBrew finds a new issue or an alert fires",
    displayName: "LogBrew Trigger",
    group: ["trigger"],
    icon: { dark: "file:../../icons/logbrew.dark.svg", light: "file:../../icons/logbrew.svg" },
    inputs: [],
    name: "logBrewTrigger",
    outputs: ["main"],
    polling: true,
    properties: [
      {
        displayName: "Event",
        default: "issueCreated",
        name: "event",
        options: [
          {
            description: "An error group LogBrew has not seen before",
            name: "New Issue",
            value: "issueCreated",
          },
          {
            description: "One of the project's alert rules fired",
            name: "Alert Fired",
            value: "alertFired",
          },
        ],
        type: "options",
      },
      {
        displayName: "Project Name or ID",
        default: "",
        description:
          'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
        name: "projectId",
        required: true,
        type: "options",
        typeOptions: { loadOptionsMethod: "getProjects" },
      },
    ],
    subtitle: '={{$parameter["event"]}}',
    version: 1,
  };

  public readonly methods = {
    loadOptions: {
      async getProjects(this: BaseContext): Promise<readonly Option[]> {
        return projectOptions(this);
      },
    },
  };

  public async poll(this: PollContext): Promise<readonly (readonly Item[])[] | null> {
    const state = this.getWorkflowStaticData("node");
    const saved = state["cursor"];
    const cursor = typeof saved === "string" ? saved : new Date().toISOString();
    const found = await find(this, cursor);
    state["cursor"] = found.cursor;
    const [first] = found.items;
    if (first === undefined) {
      return null;
    }
    return [found.items.map((item) => ({ json: { ...item } }))];
  }
}

export { LogBrewTrigger };
