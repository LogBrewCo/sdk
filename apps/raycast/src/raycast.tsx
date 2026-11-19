import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  LocalStorage,
  getPreferenceValues,
  open,
  openExtensionPreferences,
} from "@raycast/api";
import type { Mark, Screen } from "./screens";
import type { Platform, Request } from "./session";
import type { Reply, Severity } from "./api";
import { startSignIn, waitForApproval } from "./sign-in";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Image } from "@raycast/api";
import type { JSX } from "react";
import type { Origins } from "./logbrew";
import type { SignIn } from "./sign-in";
import { originsFrom } from "./logbrew";
import { signOut } from "./session";

type LogBrewPreferences = Readonly<{ apiUrl: string }>;

type Connection = Readonly<{ origins: Origins; platform: Platform }>;

const requestTimeout = 15_000;
const severityColors: Readonly<Record<Severity, Color>> = {
  critical: Color.Magenta,
  error: Color.Red,
  info: Color.Blue,
  warning: Color.Orange,
};
const severityIcons: Readonly<Record<Severity, Icon>> = {
  critical: Icon.ExclamationMark,
  error: Icon.XMarkCircle,
  info: Icon.Info,
  warning: Icon.Warning,
};
const severityLabels: Readonly<Record<Severity, string>> = {
  critical: "Critical",
  error: "Error",
  info: "Info",
  warning: "Warning",
};
const marks: Readonly<Record<Mark, Image.ImageLike>> = {
  empty: Icon.CheckCircle,
  key: Icon.Key,
  loading: Icon.Hourglass,
  problem: Icon.Warning,
  search: Icon.MagnifyingGlass,
  signIn: "icon.png",
};

function headersFor(request: Request): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (request.contentType !== undefined) {
    headers.set("content-type", request.contentType);
  }
  if (request.token !== undefined) {
    headers.set("authorization", `Bearer ${request.token}`);
  }
  return headers;
}

async function send(request: Request): Promise<Reply> {
  const response = await fetch(request.url, {
    body: request.body,
    headers: headersFor(request),
    method: request.method,
    signal: AbortSignal.timeout(requestTimeout),
  });
  const raw = await response.text();
  try {
    const body: unknown = JSON.parse(raw);
    return { body, status: response.status };
  } catch {
    return { body: undefined, status: response.status };
  }
}

async function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, milliseconds);
  await promise;
}

function connect(): Connection | undefined {
  const origins = originsFrom(getPreferenceValues<LogBrewPreferences>().apiUrl);
  if (origins === undefined) {
    return undefined;
  }
  const platform: Platform = {
    now: () => Date.now(),
    origin: origins.api,
    read: async (key) => LocalStorage.getItem<string>(key),
    remove: async (key) => LocalStorage.removeItem(key),
    send,
    sleep,
    write: async (key, value) => LocalStorage.setItem(key, value),
  };
  return { origins, platform };
}

function useConnection(): Connection | undefined {
  return useMemo(() => connect(), []);
}

async function signInWith(
  platform: Platform,
  cancelled: () => boolean,
  report: (state: SignIn) => void,
): Promise<SignIn> {
  report({ kind: "starting" });
  const started = await startSignIn(platform);
  report(started);
  if (started.kind !== "waiting") {
    return started;
  }
  await open(started.authorization.link);
  return waitForApproval(platform, started.authorization, cancelled);
}

function useSignIn(
  connection: Connection | undefined,
  onSignedIn: () => void,
): Readonly<{
  signIn: SignIn;
  start: () => void;
}> {
  const [signIn, setSignIn] = useState<SignIn>({ kind: "idle" });
  const cancelled = useRef(false);
  useEffect(
    () => (): void => {
      cancelled.current = true;
    },
    [],
  );
  const run = useCallback(async (): Promise<void> => {
    if (connection === undefined) {
      return;
    }
    const finished = await signInWith(connection.platform, () => cancelled.current, setSignIn);
    setSignIn(finished);
    if (finished.kind === "signedIn") {
      onSignedIn();
    }
  }, [connection, onSignedIn]);
  const start = useCallback(() => {
    void run();
  }, [run]);
  return { signIn, start };
}

function severityTag(severity: Severity): List.Item.Accessory {
  const label = severityLabels[severity];
  return { tag: { color: severityColors[severity], value: label }, tooltip: `Severity: ${label}` };
}

function severityIcon(severity: Severity): Image.ImageLike {
  return { source: severityIcons[severity], tintColor: severityColors[severity] };
}

type StatusProps = Readonly<{
  connection: Connection | undefined;
  onRetry: () => void;
  onSignIn: () => void;
  screen: Screen;
}>;

function NextAction(props: StatusProps): JSX.Element | undefined {
  const { connection, onRetry, onSignIn, screen } = props;
  switch (screen.next) {
    case "signIn": {
      return <Action icon={Icon.Globe} onAction={onSignIn} title="Continue in Browser" />;
    }
    case "retry": {
      return <Action icon={Icon.ArrowClockwise} onAction={onRetry} title="Retry" />;
    }
    case "preferences": {
      return (
        <Action
          icon={Icon.Gear}
          onAction={() => {
            void openExtensionPreferences();
          }}
          title="Open Extension Preferences"
        />
      );
    }
    case "dashboard": {
      return connection === undefined ? undefined : (
        <Action.OpenInBrowser title="Open LogBrew Dashboard" url={`${connection.origins.dashboard}/dashboard`} />
      );
    }
    case "none": {
      return undefined;
    }
    default: {
      return screen.next;
    }
  }
}

function StatusView(props: StatusProps): JSX.Element {
  const { screen } = props;
  return (
    <List.EmptyView
      actions={
        <ActionPanel>
          <NextAction {...props} />
        </ActionPanel>
      }
      description={screen.description}
      icon={marks[screen.mark]}
      title={screen.title}
    />
  );
}

function SignOutAction(props: Readonly<{ connection: Connection; onSignedOut: () => void }>): JSX.Element {
  const { connection, onSignedOut } = props;
  async function leave(): Promise<void> {
    await signOut(connection.platform);
    onSignedOut();
  }
  return (
    <Action
      icon={Icon.Logout}
      onAction={() => {
        void leave();
      }}
      style={Action.Style.Destructive}
      title="Sign out of LogBrew"
    />
  );
}

export { type Connection, SignOutAction, StatusView, connect, severityIcon, severityTag, useConnection, useSignIn };
