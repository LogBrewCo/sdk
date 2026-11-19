import type { Failure, Issue, Outcome } from "./api";
import type { SignIn, Stop } from "./sign-in";
import type { NewIssues } from "./logbrew";

type Topic = "errors" | "issues";

type View<Item> =
  | Readonly<{ failure: Failure; kind: "failed" }>
  | Readonly<{ items: readonly Item[]; kind: "ready" }>
  | Readonly<{ kind: "badUrl" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "noProjects" }>
  | Readonly<{ kind: "signIn"; signIn: SignIn }>;

type Next = "dashboard" | "none" | "preferences" | "retry" | "signIn";

type Mark = "empty" | "key" | "loading" | "problem" | "search" | "signIn";

type Screen = Readonly<{ description: string; mark: Mark; next: Next; title: string }>;

type Inputs<Item> = Readonly<{
  hasProjects: boolean | undefined;
  loading: boolean;
  result: Outcome<readonly Item[]> | undefined;
  signIn: SignIn;
  validUrl: boolean;
}>;

const nothing = 0;
const single = 1;

const failures: Readonly<Record<Failure, Screen>> = {
  forbidden: {
    description: "Ask a project owner for access, or pick another project.",
    mark: "problem",
    next: "retry",
    title: "No Access to This Project",
  },
  invalid: {
    description: "LogBrew sent an unexpected answer. Update the extension, then retry.",
    mark: "problem",
    next: "retry",
    title: "Unexpected Answer from LogBrew",
  },
  notFound: {
    description: "This project is gone or hidden from you. Pick another project.",
    mark: "problem",
    next: "retry",
    title: "Project Not Found",
  },
  offline: {
    description: "Check your internet connection, then retry.",
    mark: "problem",
    next: "retry",
    title: "Can't Reach LogBrew",
  },
  rateLimited: {
    description: "LogBrew paused requests for a moment. Wait a minute, then retry.",
    mark: "problem",
    next: "retry",
    title: "Too Many Requests",
  },
  unavailable: {
    description: "LogBrew didn't answer in time. Retry in a minute.",
    mark: "problem",
    next: "retry",
    title: "LogBrew Is Unavailable",
  },
};

const empty: Readonly<Record<Topic, Screen>> = {
  errors: {
    description: "Error logs from this project appear here as they happen.",
    mark: "empty",
    next: "dashboard",
    title: "No Errors in the Last 24 Hours",
  },
  issues: {
    description: "New issues appear here as soon as LogBrew groups them.",
    mark: "empty",
    next: "dashboard",
    title: "No Unresolved Issues",
  },
};

const unmatched: Readonly<Record<Topic, Screen>> = {
  errors: {
    description: "Try other words or another project.",
    mark: "search",
    next: "none",
    title: "No Matching Errors",
  },
  issues: {
    description: "Try other words or another project.",
    mark: "search",
    next: "none",
    title: "No Matching Issues",
  },
};

function stoppedScreen(reason: Stop): Screen {
  const screens = {
    denied: { description: "The sign-in was denied. Sign in again and approve it.", title: "Sign-In Denied" },
    expired: { description: "Sign in again and approve within 10 minutes.", title: "Sign-In Code Expired" },
    invalid: {
      description: "LogBrew sent an unexpected answer. Update the extension, then retry.",
      title: "Sign-In Failed",
    },
    offline: { description: "Check your internet connection, then sign in again.", title: "Can't Reach LogBrew" },
  } as const;
  return { ...screens[reason], mark: "problem", next: "signIn" };
}

function signInScreen(signIn: SignIn): Screen {
  switch (signIn.kind) {
    case "waiting": {
      return {
        description: "Your browser shows the same code. Approve it there, then come back.",
        mark: "key",
        next: "none",
        title: `Approve Code ${signIn.authorization.userCode}`,
      };
    }
    case "starting":
    case "signedIn": {
      return {
        description: "Approve the sign-in there, then come back.",
        mark: "loading",
        next: "none",
        title: "Opening Your Browser…",
      };
    }
    case "stopped": {
      return stoppedScreen(signIn.reason);
    }
    case "idle": {
      return {
        description: "Sign in with your browser. Nothing to copy or paste.",
        mark: "signIn",
        next: "signIn",
        title: "Sign In to LogBrew",
      };
    }
    default: {
      return signIn;
    }
  }
}

function settledView<Item>(result: Outcome<readonly Item[]>, hasProjects: boolean | undefined): View<Item> {
  switch (result.kind) {
    case "signedOut": {
      return { kind: "signIn", signIn: { kind: "idle" } };
    }
    case "failed": {
      return { failure: result.failure, kind: "failed" };
    }
    case "ok": {
      return hasProjects === false && result.value.length === nothing
        ? { kind: "noProjects" }
        : { items: result.value, kind: "ready" };
    }
    default: {
      return result;
    }
  }
}

function viewOf<Item>(inputs: Inputs<Item>): View<Item> {
  const { hasProjects, loading, result, signIn, validUrl } = inputs;
  if (!validUrl) {
    return { kind: "badUrl" };
  }
  if (signIn.kind !== "idle" && signIn.kind !== "signedIn") {
    return { kind: "signIn", signIn };
  }
  const waiting = loading || signIn.kind === "signedIn";
  if (result === undefined || (waiting && result.kind === "signedOut")) {
    return waiting ? { kind: "loading" } : { failure: "invalid", kind: "failed" };
  }
  return settledView(result, hasProjects);
}

function screenOf<Item>(view: View<Item>, topic: Topic): Screen {
  switch (view.kind) {
    case "badUrl": {
      return {
        description: "Fix the API URL in the extension preferences.",
        mark: "problem",
        next: "preferences",
        title: "API URL Is Not Valid",
      };
    }
    case "failed": {
      return failures[view.failure];
    }
    case "loading": {
      return { description: "", mark: "loading", next: "none", title: "Loading…" };
    }
    case "noProjects": {
      return {
        description: "Create a project in LogBrew, then send your first event.",
        mark: "empty",
        next: "dashboard",
        title: "No Projects Yet",
      };
    }
    case "ready": {
      return view.items.length === nothing ? empty[topic] : unmatched[topic];
    }
    case "signIn": {
      return signInScreen(view.signIn);
    }
    default: {
      return view;
    }
  }
}

type Menu = Readonly<{
  heading: string;
  latest: readonly Issue[];
  note: string | undefined;
  searchTitle: string;
  title: string | undefined;
  tooltip: string;
}>;

const quiet = { latest: [], note: undefined, searchTitle: "Search Issues…", title: undefined } as const;

function countMenu(newIssues: NewIssues): Menu {
  const { capped, count, latest } = newIssues;
  if (count === nothing) {
    return { ...quiet, heading: "No New Issues in 24 Hours", tooltip: "LogBrew: no new issues" };
  }
  const shown = capped ? `${count}+` : String(count);
  return {
    heading: "First Seen in the Last 24 Hours",
    latest,
    note: undefined,
    searchTitle: "Search All Issues…",
    title: shown,
    tooltip: `LogBrew: ${shown} new ${count === single ? "issue" : "issues"} in 24 hours`,
  };
}

function menuOf(result: Outcome<NewIssues> | undefined, loading: boolean): Menu {
  if (result === undefined) {
    return { ...quiet, heading: loading ? "Loading…" : "LogBrew", tooltip: "LogBrew" };
  }
  if (result.kind === "signedOut") {
    return {
      ...quiet,
      heading: "Signed Out",
      note: "Sign in to see new issues here.",
      searchTitle: "Sign In to LogBrew…",
      tooltip: "LogBrew: signed out",
    };
  }
  if (result.kind === "failed") {
    const screen = failures[result.failure];
    return { ...quiet, heading: screen.title, note: screen.description, tooltip: `LogBrew: ${screen.title}` };
  }
  return countMenu(result.value);
}

export { type Inputs, type Mark, type Menu, type Next, type Screen, type Topic, type View, menuOf, screenOf, viewOf };
