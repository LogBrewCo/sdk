import { Action, ActionPanel, Icon, List } from "@raycast/api";
import type { ErrorLog, Outcome, Project } from "./api";
import { SignOutAction, StatusView, severityIcon, severityTag, useConnection, useSignIn } from "./raycast";
import { errorLogLink, listProjects, listRecentErrors } from "./logbrew";
import { screenOf, viewOf } from "./screens";
import { useCachedPromise, useCachedState } from "@raycast/utils";
import type { Connection } from "./raycast";
import type { Inputs } from "./screens";
import type { JSX } from "react";

const nothing = 0;

function firstLine(message: string): string {
  const [line = ""] = message.split("\n");
  return line === "" ? "Error without a message" : line;
}

function ErrorItem(props: Readonly<{ connection: Connection; log: ErrorLog; onReload: () => void }>): JSX.Element {
  const { connection, log, onReload } = props;
  const link = errorLogLink(connection.origins, log);
  return (
    <List.Item
      accessories={[
        severityTag(log.severity),
        { date: new Date(log.occurredAt), tooltip: `Seen ${new Date(log.occurredAt).toLocaleString()}` },
      ]}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser title={log.traceId === "" ? "Open Logs in LogBrew" : "Open Trace in LogBrew"} url={link} />
          <Action.CopyToClipboard content={log.message} shortcut={{ key: "c", modifiers: ["cmd", "shift"] }} title="Copy Message" />
          {log.traceId === "" ? undefined : <Action.CopyToClipboard content={log.traceId} title="Copy Trace ID" />}
          <Action icon={Icon.ArrowClockwise} onAction={onReload} shortcut={{ key: "r", modifiers: ["cmd"] }} title="Reload" />
          <SignOutAction connection={connection} onSignedOut={onReload} />
        </ActionPanel>
      }
      icon={severityIcon(log.severity)}
      id={log.id}
      keywords={[log.serviceName, log.environment, log.release].filter((word) => word !== "")}
      subtitle={log.serviceName}
      title={firstLine(log.message)}
    />
  );
}

function ProjectPicker(props: Readonly<{ onChange: (id: string) => void; projects: readonly Project[]; value: string }>): JSX.Element {
  const { onChange, projects, value } = props;
  return (
    <List.Dropdown onChange={onChange} tooltip="Project" value={value}>
      {projects.map((project) => (
        <List.Dropdown.Item key={project.id} title={project.name} value={project.id} />
      ))}
    </List.Dropdown>
  );
}

async function loadProjects(connection: Connection | undefined): Promise<Outcome<readonly Project[]> | undefined> {
  return connection === undefined ? undefined : listProjects(connection.platform);
}

async function loadErrors(connection: Connection | undefined, projectId: string): Promise<Outcome<readonly ErrorLog[]> | undefined> {
  if (connection === undefined || projectId === "") {
    return undefined;
  }
  return listRecentErrors(connection.platform, projectId);
}

function chosen(projects: readonly Project[], stored: string): string {
  if (projects.some((project) => project.id === stored)) {
    return stored;
  }
  const [first] = projects;
  return first?.id ?? "";
}

type Loaded = Readonly<{
  errors: Outcome<readonly ErrorLog[]> | undefined;
  projects: Outcome<readonly Project[]> | undefined;
}>;

function errorsResult(loaded: Loaded): Inputs<ErrorLog>["result"] {
  const { errors, projects } = loaded;
  if (projects?.kind !== "ok") {
    return projects;
  }
  return projects.value.length === nothing ? { kind: "ok", value: [] } : errors;
}

export default function RecentErrors(): JSX.Element {
  const connection = useConnection();
  const [stored, setStored] = useCachedState("recent-errors-project", "");
  const projects = useCachedPromise(loadProjects, [connection], { keepPreviousData: true });
  const projectList = projects.data?.kind === "ok" ? projects.data.value : [];
  const projectId = chosen(projectList, stored);
  const errors = useCachedPromise(loadErrors, [connection, projectId], { keepPreviousData: true });
  function reload(): void {
    projects.revalidate();
    errors.revalidate();
  }
  const { signIn, start } = useSignIn(connection, reload);
  const view = viewOf({
    hasProjects: projects.data?.kind === "ok" ? projectList.length > nothing : undefined,
    loading: errors.isLoading || projects.isLoading,
    result: errorsResult({ errors: errors.data, projects: projects.data }),
    signIn,
    validUrl: connection !== undefined,
  });
  return (
    <List
      filtering
      isLoading={errors.isLoading || projects.isLoading || signIn.kind === "starting" || signIn.kind === "waiting"}
      searchBarAccessory={
        projectList.length > nothing ? <ProjectPicker onChange={setStored} projects={projectList} value={projectId} /> : undefined
      }
      searchBarPlaceholder="Filter errors by message or service"
    >
      <StatusView connection={connection} onRetry={reload} onSignIn={start} screen={screenOf(view, "errors")} />
      {connection === undefined || view.kind !== "ready"
        ? undefined
        : view.items.map((log) => <ErrorItem connection={connection} key={log.id} log={log} onReload={reload} />)}
    </List>
  );
}
