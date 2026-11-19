import { Icon, LaunchType, MenuBarExtra, launchCommand, open } from "@raycast/api";
import { issueLink, listNewIssues } from "./logbrew";
import { severityIcon, useConnection } from "./raycast";
import type { Connection } from "./raycast";
import type { JSX } from "react";
import type { NewIssues } from "./logbrew";
import type { Outcome } from "./api";
import { menuOf } from "./screens";
import { useCachedPromise } from "@raycast/utils";

async function loadNewIssues(connection: Connection | undefined): Promise<Outcome<NewIssues> | undefined> {
  return connection === undefined ? undefined : listNewIssues(connection.platform);
}

function openSearch(): void {
  void launchCommand({ name: "search-issues", type: LaunchType.UserInitiated });
}

export default function NewIssuesMenu(): JSX.Element {
  const connection = useConnection();
  const { data, isLoading } = useCachedPromise(loadNewIssues, [connection]);
  const menu = menuOf(connection === undefined ? { failure: "invalid", kind: "failed" } : data, isLoading);
  return (
    <MenuBarExtra
      icon="menu-bar.png"
      isLoading={isLoading}
      tooltip={menu.tooltip}
      {...(menu.title === undefined ? {} : { title: menu.title })}
    >
      <MenuBarExtra.Section title={menu.heading}>
        {menu.latest.map((issue) => (
          <MenuBarExtra.Item
            icon={severityIcon(issue.severity)}
            key={issue.id}
            onAction={() => {
              if (connection !== undefined) {
                void open(issueLink(connection.origins, issue));
              }
            }}
            subtitle={issue.serviceName}
            title={issue.title}
          />
        ))}
        {menu.note === undefined ? undefined : <MenuBarExtra.Item title={menu.note} />}
      </MenuBarExtra.Section>
      <MenuBarExtra.Section>
        <MenuBarExtra.Item icon={Icon.MagnifyingGlass} onAction={openSearch} title={menu.searchTitle} />
        {connection === undefined ? undefined : (
          <MenuBarExtra.Item
            icon={Icon.Globe}
            onAction={() => {
              void open(`${connection.origins.dashboard}/dashboard`);
            }}
            title="Open LogBrew Dashboard"
          />
        )}
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
