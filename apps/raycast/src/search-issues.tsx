import { Action, ActionPanel, Icon, Keyboard, List } from "@raycast/api";
import type { Issue, Outcome, Project } from "./api";
import { SignOutAction, StatusView, severityIcon, severityTag, useConnection, useSignIn } from "./raycast";
import { issueLink, listIssues, listProjects } from "./logbrew";
import { screenOf, viewOf } from "./screens";
import { useCachedPromise, useCachedState } from "@raycast/utils";
import type { Connection } from "./raycast";
import type { JSX } from "react";

const everyProject = "";
const single = 1;
const nothing = 0;

function occurrences(count: number): List.Item.Accessory {
  return { text: `${count}×`, tooltip: count === single ? "1 event" : `${count} events` };
}

function IssueItem(props: Readonly<{ connection: Connection; issue: Issue; onReload: () => void }>): JSX.Element {
  const { connection, issue, onReload } = props;
  const link = issueLink(connection.origins, issue);
  return (
    <List.Item
      accessories={[
        severityTag(issue.severity),
        occurrences(issue.occurrences),
        { date: new Date(issue.lastSeenAt), tooltip: `Last seen ${new Date(issue.lastSeenAt).toLocaleString()}` },
      ]}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser title="Open in LogBrew" url={link} />
          <Action.CopyToClipboard content={link} shortcut={Keyboard.Shortcut.Common.Copy} title="Copy Link" />
          <Action.CopyToClipboard content={issue.id} title="Copy Issue ID" />
          <Action
            icon={Icon.ArrowClockwise}
            onAction={onReload}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            title="Reload"
          />
          <SignOutAction connection={connection} onSignedOut={onReload} />
        </ActionPanel>
      }
      icon={severityIcon(issue.severity)}
      id={issue.id}
      keywords={[issue.message, issue.serviceName, issue.environment, issue.release].filter((word) => word !== "")}
      subtitle={issue.serviceName}
      title={issue.title}
    />
  );
}

function ProjectFilter(
  props: Readonly<{ onChange: (id: string) => void; projects: readonly Project[]; value: string }>,
): JSX.Element {
  const { onChange, projects, value } = props;
  return (
    <List.Dropdown onChange={onChange} tooltip="Project" value={value}>
      <List.Dropdown.Item icon={Icon.AppWindowGrid3x3} title="All Projects" value={everyProject} />
      <List.Dropdown.Section title="Projects">
        {projects.map((project) => (
          <List.Dropdown.Item key={project.id} title={project.name} value={project.id} />
        ))}
      </List.Dropdown.Section>
    </List.Dropdown>
  );
}

async function loadProjects(connection: Connection | undefined): Promise<Outcome<readonly Project[]> | undefined> {
  return connection === undefined ? undefined : listProjects(connection.platform);
}

async function loadIssues(
  connection: Connection | undefined,
  projectId: string,
): Promise<Outcome<readonly Issue[]> | undefined> {
  return connection === undefined ? undefined : listIssues(connection.platform, projectId);
}

export default function SearchIssues(): JSX.Element {
  const connection = useConnection();
  const [projectId, setProjectId] = useCachedState("search-issues-project", everyProject);
  const projects = useCachedPromise(loadProjects, [connection], { keepPreviousData: true });
  const issues = useCachedPromise(loadIssues, [connection, projectId], { keepPreviousData: true });
  function reload(): void {
    projects.revalidate();
    issues.revalidate();
  }
  const { signIn, start } = useSignIn(connection, reload);
  const projectList = projects.data?.kind === "ok" ? projects.data.value : [];
  const view = viewOf({
    hasProjects: projects.data?.kind === "ok" ? projectList.length > nothing : undefined,
    loading: issues.isLoading,
    result: issues.data,
    signIn,
    validUrl: connection !== undefined,
  });
  const items = view.kind === "ready" ? view.items : [];
  return (
    <List
      filtering
      isLoading={issues.isLoading || projects.isLoading || signIn.kind === "starting" || signIn.kind === "waiting"}
      searchBarAccessory={
        view.kind === "ready" ? (
          <ProjectFilter onChange={setProjectId} projects={projectList} value={projectId} />
        ) : undefined
      }
      searchBarPlaceholder="Search issues by title, message, or service"
    >
      <StatusView connection={connection} onRetry={reload} onSignIn={start} screen={screenOf(view, "issues")} />
      {connection === undefined
        ? undefined
        : items.map((issue) => <IssueItem connection={connection} issue={issue} key={issue.id} onReload={reload} />)}
    </List>
  );
}
