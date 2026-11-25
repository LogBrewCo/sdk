import type { Disposable, TreeDataProvider, TreeView } from "vscode";
import {
  EventEmitter,
  MarkdownString,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  commands,
  env,
  l10n,
  window,
} from "vscode";
import type { Item, Message, Row, State } from "./model";
import type { Mark, Topic } from "@logbrew/raycast/screens";
import { ago, errorRows, issueRows } from "./model";
import type { Origins } from "@logbrew/raycast/logbrew";
import type { Severity } from "@logbrew/raycast/api";
import { screenOf } from "@logbrew/raycast/screens";

type Section = Readonly<{ changed: EventEmitter<undefined>; topic: Topic; view: TreeView<Row> }>;

type Views = Readonly<{
  disposables: readonly Disposable[];
  show: (state: State, origins: Origins | undefined) => void;
  visible: () => boolean;
}>;

const problemColor = new ThemeColor("problemsErrorIcon.foreground");
const warningColor = new ThemeColor("problemsWarningIcon.foreground");
const icons: Readonly<Record<Severity, ThemeIcon>> = {
  critical: new ThemeIcon("flame", problemColor),
  error: new ThemeIcon("error", problemColor),
  info: new ThemeIcon("info", new ThemeColor("problemsInfoIcon.foreground")),
  warning: new ThemeIcon("warning", warningColor),
};
const marks: Readonly<Record<Mark, ThemeIcon>> = {
  empty: new ThemeIcon("pass"),
  key: new ThemeIcon("key"),
  loading: new ThemeIcon("loading~spin"),
  problem: new ThemeIcon("warning", warningColor),
  search: new ThemeIcon("search"),
  signIn: new ThemeIcon("account"),
};
const severityNames: Readonly<Record<Severity, string>> = {
  critical: l10n.t("Critical"),
  error: l10n.t("Error"),
  info: l10n.t("Info"),
  warning: l10n.t("Warning"),
};
const viewIds: Readonly<Record<Topic, string>> = { errors: "logbrew.errors", issues: "logbrew.issues" };

function describe(item: Item): string {
  const count = item.events === undefined ? item.source : l10n.t("{0} events", item.events.toLocaleString(env.language));
  return [count, ago(item.at, Date.now(), env.language)].filter((part) => part !== "").join(" · ");
}

function itemTooltip(item: Item): MarkdownString {
  const tooltip = new MarkdownString();
  tooltip.appendMarkdown(`**${severityNames[item.severity]}** · ${describe(item)}\n\n`);
  tooltip.appendText(item.label);
  for (const line of item.detail) {
    tooltip.appendMarkdown("\n\n");
    tooltip.appendText(line);
  }
  return tooltip;
}

function itemNode(item: Item): TreeItem {
  const node = new TreeItem(item.label, TreeItemCollapsibleState.None);
  node.id = item.id;
  node.description = describe(item);
  node.iconPath = icons[item.severity];
  node.tooltip = itemTooltip(item);
  node.contextValue = "logbrew.item";
  node.command = { arguments: [item.link], command: "logbrew.open", title: l10n.t("Open in LogBrew") };
  node.accessibilityInformation = { label: `${severityNames[item.severity]}: ${item.label}, ${describe(item)}` };
  return node;
}

function messageNode(message: Message): TreeItem {
  const node = new TreeItem(l10n.t(message.label), TreeItemCollapsibleState.None);
  node.description = l10n.t(message.description);
  node.tooltip = node.description;
  node.iconPath = marks[message.mark];
  if (message.next === "retry") {
    node.command = { command: "logbrew.refresh", title: l10n.t("Refresh") };
  }
  if (message.next === "dashboard") {
    node.command = { command: "logbrew.openDashboard", title: l10n.t("Open LogBrew") };
  }
  return node;
}

function rowsOf(state: State, origins: Origins | undefined, topic: Topic): readonly Row[] {
  if (state.kind === "failed") {
    const screen = screenOf({ failure: state.failure, kind: "failed" }, topic);
    return [{ description: screen.description, kind: "message", label: screen.title, mark: "problem", next: "retry" }];
  }
  if (state.kind !== "ready" || origins === undefined) {
    return [];
  }
  return topic === "issues" ? issueRows(state.feed.issues, origins) : errorRows(state.feed.errors, origins);
}

function section(topic: Topic, rows: (topic: Topic) => readonly Row[]): Section {
  const changed = new EventEmitter<undefined>();
  const provider: TreeDataProvider<Row> = {
    getChildren: (parent) => (parent === undefined ? [...rows(topic)] : []),
    getTreeItem: (row) => (row.kind === "item" ? itemNode(row) : messageNode(row)),
    onDidChangeTreeData: changed.event,
  };
  return { changed, topic, view: window.createTreeView(viewIds[topic], { treeDataProvider: provider }) };
}

function createViews(): Views {
  const shown: { origins: Origins | undefined; state: State } = { origins: undefined, state: { kind: "loading" } };
  function read(topic: Topic): readonly Row[] {
    return rowsOf(shown.state, shown.origins, topic);
  }
  const sections = [section("issues", read), section("errors", read)];
  return {
    disposables: sections.flatMap((entry) => [entry.view, entry.changed]),
    show: (state, origins) => {
      shown.state = state;
      shown.origins = origins;
      void commands.executeCommand("setContext", "logbrew.state", state.kind);
      for (const entry of sections) {
        entry.view.description = state.kind === "ready" ? state.feed.project.name : "";
        entry.changed.fire(undefined);
      }
    },
    visible: () => sections.some((entry) => entry.view.visible),
  };
}

export { type Views, createViews };
