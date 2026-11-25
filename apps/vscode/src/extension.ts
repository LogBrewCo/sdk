import type { ExtensionContext, SecretStorage } from "vscode";
import { ProgressLocation, Uri, commands, env, l10n, window, workspace } from "vscode";
import type { SignIn, Stop } from "@logbrew/raycast/sign-in";
import { send, sleep } from "@logbrew/raycast/http";
import { startSignIn, waitForApproval } from "@logbrew/raycast/sign-in";
import type { Origins } from "@logbrew/raycast/logbrew";
import type { Platform } from "@logbrew/raycast/session";
import type { State } from "./model";
import { createViews } from "./views";
import { load } from "./model";
import { originsFrom } from "@logbrew/raycast/logbrew";
import { screenOf } from "@logbrew/raycast/screens";
import { signOut } from "@logbrew/raycast/session";

type Connection = Readonly<{ origins: Origins; platform: Platform }>;

type Store = Readonly<{
  current: () => number;
  next: () => number;
  read: () => State;
  write: (state: State) => void;
}>;

type Host = Readonly<{
  choose: (project: string | undefined) => Thenable<void>;
  chosen: () => string | undefined;
  connection: () => Connection | undefined;
  store: Store;
}>;

const refreshEvery = 300_000;
const noticeFor = 2000;
const projectKey = "logbrew.project";
const step = 1;

function connect(secrets: SecretStorage): Connection | undefined {
  const origins = originsFrom(workspace.getConfiguration("logbrew").get<string>("apiUrl") ?? "");
  if (origins === undefined) {
    return undefined;
  }
  const platform: Platform = {
    client: { id: "logbrew-vscode", name: `LogBrew for ${env.appName}` },
    now: () => Date.now(),
    origin: origins.api,
    read: async (key) => secrets.get(`logbrew.${key}`),
    remove: async (key) => secrets.delete(`logbrew.${key}`),
    send,
    sleep,
    write: async (key, value) => secrets.store(`logbrew.${key}`, value),
  };
  return { origins, platform };
}

function storeFor(show: (state: State) => void): Store {
  const cell: { generation: number; state: State } = { generation: 0, state: { kind: "loading" } };
  return {
    current: () => cell.generation,
    next: () => {
      cell.generation += step;
      return cell.generation;
    },
    read: () => cell.state,
    write: (state) => {
      cell.state = state;
      show(state);
    },
  };
}

function folderNames(): readonly string[] {
  return (workspace.workspaceFolders ?? []).map((folder) => folder.name);
}

async function loadInto(host: Host, connection: Connection): Promise<void> {
  const generation = host.store.next();
  if (host.store.read().kind !== "ready") {
    host.store.write({ kind: "loading" });
  }
  const state = await window.withProgress({ location: { viewId: "logbrew.issues" } }, async () =>
    load(connection.platform, host.chosen(), folderNames()),
  );
  if (generation === host.store.current()) {
    host.store.write(state);
  }
}

async function refresh(host: Host): Promise<void> {
  const connection = host.connection();
  if (connection === undefined) {
    host.store.write({ kind: "badUrl" });
    return;
  }
  if (host.store.read().kind !== "signingIn") {
    await loadInto(host, connection);
  }
}

async function approve(platform: Platform): Promise<SignIn> {
  const started = await startSignIn(platform);
  if (started.kind !== "waiting") {
    return started;
  }
  const { authorization } = started;
  const title = l10n.t("Approve code {0} in your browser", authorization.userCode);
  return window.withProgress({ cancellable: true, location: ProgressLocation.Notification, title }, async (_progress, token) => {
    await env.openExternal(Uri.parse(authorization.link, true));
    return waitForApproval(platform, authorization, () => token.isCancellationRequested);
  });
}

async function retry(reason: Stop): Promise<boolean> {
  const screen = screenOf({ kind: "signIn", signIn: { kind: "stopped", reason } }, "issues");
  const again = l10n.t("Sign In");
  const choice = await window.showErrorMessage(`${l10n.t(screen.title)}. ${l10n.t(screen.description)}`, again);
  return choice === again;
}

async function signIn(host: Host): Promise<void> {
  const connection = host.connection();
  if (connection === undefined || host.store.read().kind === "signingIn") {
    return;
  }
  host.store.write({ kind: "signingIn" });
  const finished = await approve(connection.platform);
  host.store.write({ kind: "signedOut" });
  if (finished.kind === "stopped" && (await retry(finished.reason))) {
    await signIn(host);
    return;
  }
  await refresh(host);
}

async function chooseProject(host: Host): Promise<void> {
  const state = host.store.read();
  if (state.kind !== "ready" && state.kind !== "chooseProject") {
    return;
  }
  const current = state.kind === "ready" ? state.feed.project.id : undefined;
  const items = state.projects.map((project) => ({
    description: project.id === current ? l10n.t("Current") : "",
    id: project.id,
    label: project.name,
  }));
  const picked = await window.showQuickPick(items, {
    placeHolder: l10n.t("Choose the LogBrew project for this workspace"),
  });
  if (picked !== undefined) {
    await host.choose(picked.id);
    await refresh(host);
  }
}

async function leave(host: Host): Promise<void> {
  const connection = host.connection();
  if (connection === undefined) {
    return;
  }
  const revoked = await signOut(connection.platform);
  host.store.next();
  host.store.write({ kind: "signedOut" });
  await host.choose(undefined);
  if (!revoked) {
    void window.showWarningMessage(l10n.t("Signed out on this device. LogBrew couldn't end the session. Retry later."));
  }
}

async function openLink(link: unknown): Promise<void> {
  if (typeof link === "string") {
    await env.openExternal(Uri.parse(link, true));
  }
}

async function copyLink(row: unknown): Promise<void> {
  if (typeof row === "object" && row !== null && "link" in row && typeof row.link === "string") {
    await env.clipboard.writeText(row.link);
    window.setStatusBarMessage(l10n.t("Link copied"), noticeFor);
  }
}

function hostFor(context: ExtensionContext, show: (state: State, origins: Origins | undefined) => void): Host {
  function connection(): Connection | undefined {
    return connect(context.secrets);
  }
  return {
    choose: async (project) => context.workspaceState.update(projectKey, project),
    chosen: () => context.workspaceState.get<string>(projectKey),
    connection,
    store: storeFor((state) => {
      show(state, connection()?.origins);
    }),
  };
}

function activate(context: ExtensionContext): void {
  const views = createViews();
  const host = hostFor(context, views.show);
  async function reload(): Promise<void> {
    await refresh(host);
  }
  const timer = setInterval(() => {
    if (views.visible()) {
      void reload();
    }
  }, refreshEvery);
  context.subscriptions.push(
    ...views.disposables,
    {
      dispose: () => {
        clearInterval(timer);
      },
    },
    commands.registerCommand("logbrew.signIn", async () => signIn(host)),
    commands.registerCommand("logbrew.signOut", async () => leave(host)),
    commands.registerCommand("logbrew.chooseProject", async () => chooseProject(host)),
    commands.registerCommand("logbrew.refresh", reload),
    commands.registerCommand("logbrew.open", openLink),
    commands.registerCommand("logbrew.copyLink", copyLink),
    commands.registerCommand("logbrew.openDashboard", async () => {
      const connection = host.connection();
      await openLink(connection === undefined ? undefined : `${connection.origins.dashboard}/dashboard`);
    }),
    commands.registerCommand("logbrew.openSettings", async () =>
      commands.executeCommand("workbench.action.openSettings", "logbrew.apiUrl"),
    ),
    workspace.onDidChangeConfiguration(async (change) =>
      change.affectsConfiguration("logbrew.apiUrl") ? reload() : undefined,
    ),
    workspace.onDidChangeWorkspaceFolders(reload),
    context.secrets.onDidChange(async () => (host.store.read().kind === "signedOut" ? reload() : undefined)),
  );
  void reload();
}

export { activate };
