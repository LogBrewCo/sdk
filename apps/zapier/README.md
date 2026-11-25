# LogBrew for Zapier

Connect [LogBrew](https://logbrew.co) error tracking and logs to your Zaps. Start a Zap when LogBrew finds a new issue or an alert fires, send logs from any Zap, and resolve issues when a fix ships. You can start on the LogBrew free plan.

## Triggers and actions

| Type | Name | What it does |
| --- | --- | --- |
| Trigger | New Issue | Starts the Zap for each issue LogBrew sees for the first time in the project. Each issue has the title, severity, occurrence count, and a link to the issue in LogBrew. |
| Trigger | New Alert | Starts the Zap each time one of the project's alert rules fires. |
| Action | Send Log | Sends one log line with a level, a message, and your own attributes. |
| Action | Resolve Issue | Marks an issue resolved. LogBrew opens it again if the error comes back. |

## Connect LogBrew

1. On the [API page](https://logbrew.co/account/api) of your LogBrew account, create a token with **Projects** read, **Telemetry** read, **Issues** write, and **Alerts** read access.
2. To send logs, open your project in [LogBrew projects](https://logbrew.co/dashboard/projects) and create an ingest key.
3. In Zapier, add LogBrew to a Zap and connect a new account. Paste the API token, and the ingest key if you send logs.

## Example Zaps

- **New issue to Slack.** New Issue, then a Slack step that posts the title, severity, and link.
- **Alert to a ticket.** New Alert, then a Linear or Jira step that opens a ticket.
- **Log each run.** Add Send Log at the end of a Zap, with the order ID as an attribute.
- **Close the loop.** A deploy or ticket trigger, then Resolve Issue with the issue ID from New Issue.

## Errors

Each step shows the LogBrew error and its next step, for example `Invalid or expired token. send Authorization: Bearer <token> (HTTP 401)`.

## License

MIT
