# n8n-nodes-logbrew

Connect [LogBrew](https://logbrew.co) error tracking and logs to your n8n workflows. Start a workflow when LogBrew finds a new issue or an alert fires, send logs from any workflow, and resolve issues when a fix ships. You can start on the LogBrew free plan.

## Installation

In n8n, open **Settings**, then **Community Nodes**, choose **Install**, and enter `n8n-nodes-logbrew`. The n8n docs explain [community node installation](https://docs.n8n.io/integrations/community-nodes/installation/) for self-hosted instances.

## Nodes

| Node | Operation | What it does |
| --- | --- | --- |
| LogBrew Trigger | New Issue | Starts the workflow for each issue LogBrew sees for the first time in the project. Each item has the title, severity, occurrence count, and a link to the issue in LogBrew. |
| LogBrew Trigger | Alert Fired | Starts the workflow when one of the project's alert rules fires. |
| LogBrew | Send a Log | Sends one log line with a level, a message, and your own attributes. |
| LogBrew | Resolve an Issue | Marks an issue resolved. LogBrew opens it again if the error comes back. |

The LogBrew node also works as a tool for the n8n AI Agent node.

## Credentials

1. In LogBrew, open **Settings**, then **API Tokens**, and create a token with **Projects** read, **Telemetry** read & write, and **Alerts** read access.
2. To send logs, open **API Keys** in your LogBrew project and create an ingest key.
3. In n8n, create a **LogBrew API** credential. Paste the API token, and the ingest key if you send logs.

Keep the API URL `https://api.logbrew.co`. Change it only when your team runs LogBrew at another address.

## Example workflows

- **New issue to Slack.** LogBrew Trigger (New Issue) followed by a Slack node that posts the title, severity, and link.
- **Alert to a ticket.** LogBrew Trigger (Alert Fired) followed by a Linear or Jira node that opens a ticket.
- **Log each run.** Add LogBrew (Send a Log) at the end of a workflow, with the order ID or account ID as attributes.

## Errors

The nodes show the LogBrew error and its next step, for example `Invalid or expired token. send Authorization: Bearer <token> (HTTP 401)`. Turn on **Continue On Fail** to keep the workflow running and get the error on the item.

## Development

```sh
bun install
bun run build
bun test
bun run lint
```

The tests run the nodes against a local LogBrew fixture server, with no account or network access.

## License

MIT
