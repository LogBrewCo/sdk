import type { Fake, Handler } from "./fake";
import { answer, fake, origin, pathOf, signedIn, start } from "./fake";
import { describe, expect, test } from "bun:test";
import { getAuthorized, loadSession, signOut } from "./session";
import { isFields, text } from "./api";
import type { Request } from "./session";

type Server = Readonly<{ handler: Handler; refreshes: () => number }>;

const second = 1000;
const hour = 3_600_000;
const lifetime = 900;
const status = { ok: 200, unauthorized: 401 } as const;
const counts = { none: 0, one: 1 } as const;

function sentRefresh(request: Request): string {
  const body: unknown = JSON.parse(request.body ?? "{}");
  return isFields(body) ? text(body, "refresh_token") : "";
}

function rotatingServer(): Server {
  const used = new Set<string>();
  const state = { refreshes: 0 };
  function handler(request: Request): ReturnType<Handler> {
    if (pathOf(request) !== "/api/auth/refresh") {
      return answer([], request.token === undefined ? status.unauthorized : status.ok);
    }
    const sent = sentRefresh(request);
    if (used.has(sent)) {
      return answer({ error: "invalid_grant" }, status.unauthorized);
    }
    used.add(sent);
    state.refreshes += counts.one;
    const next = state.refreshes + counts.one;
    return answer({ access_token: `access-${next}`, expires_in: lifetime, refresh_token: `refresh-${next}` });
  }
  return { handler, refreshes: () => state.refreshes };
}

function trail(target: Fake): readonly string[] {
  return target.requests.map((request) => request.token ?? pathOf(request));
}

async function refreshOf(target: Fake): Promise<string | undefined> {
  const session = await loadSession(target.platform);
  return session?.refreshToken;
}

describe("getAuthorized", () => {
  test("reports signed out without a stored session", async () => {
    const target = fake(() => answer([]));
    expect(await getAuthorized(target.platform, "/api/projects")).toEqual({ kind: "signedOut" });
    expect(target.requests).toHaveLength(counts.none);
  });

  test("sends the stored access token while it is fresh", async () => {
    const target = fake(() => answer([]));
    await signedIn(target, start + hour);
    expect(await getAuthorized(target.platform, "/api/projects")).toEqual({ kind: "ok", value: answer([]) });
    expect(target.requests).toEqual([{ method: "GET", token: "access-1", url: `${origin}/api/projects` }]);
  });

  test("reports offline when the request cannot reach LogBrew", async () => {
    const target = fake(() => {
      throw new TypeError("fetch failed");
    });
    await signedIn(target, start + hour);
    expect(await getAuthorized(target.platform, "/api/projects")).toEqual({ failure: "offline", kind: "failed" });
  });
});

describe("session renewal", () => {
  test("renews an expired session before the request", async () => {
    const server = rotatingServer();
    const target = fake(server.handler);
    await signedIn(target, start);
    await getAuthorized(target.platform, "/api/projects");
    expect(trail(target)).toEqual(["/api/auth/refresh", "access-2"]);
    const session = await loadSession(target.platform);
    expect(session).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(session?.expiresAt).toBeGreaterThanOrEqual(start + lifetime * second);
    expect(session?.expiresAt).toBeLessThan(start + lifetime * second + second);
  });

  test("renews once and retries when the access token is refused", async () => {
    const target = fake((request) =>
      request.token === "access-1"
        ? answer([], status.unauthorized)
        : answer({ access_token: "access-2", refresh_token: "refresh-2" }),
    );
    await signedIn(target, start + hour);
    await getAuthorized(target.platform, "/api/projects");
    expect(trail(target)).toEqual(["access-1", "/api/auth/refresh", "access-2"]);
  });

  test("signs out when the session can no longer renew", async () => {
    const target = fake(() => answer({ error: "invalid_grant" }, status.unauthorized));
    await signedIn(target, start);
    expect(await getAuthorized(target.platform, "/api/projects")).toEqual({ kind: "signedOut" });
    expect(await loadSession(target.platform)).toBeUndefined();
  });

  test("shares one renewal between commands that run at the same time", async () => {
    const server = rotatingServer();
    const target = fake(server.handler);
    await signedIn(target, start);
    const outcomes = await Promise.all([
      getAuthorized(target.platform, "/api/projects"),
      getAuthorized(target.platform, "/api/telemetry/issues"),
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["ok", "ok"]);
    expect(server.refreshes()).toBe(counts.one);
    expect(await refreshOf(target)).toBe("refresh-2");
  });
});

describe("signOut", () => {
  test("forgets the session and revokes it on the server", async () => {
    const target = fake(() => answer({ revoked: true }));
    await signedIn(target, start + hour);
    expect(await signOut(target.platform)).toBe(true);
    expect(await loadSession(target.platform)).toBeUndefined();
    expect(target.requests.map((request) => pathOf(request))).toEqual(["/api/auth/logout"]);
    expect(target.requests.map((request) => request.body)).toEqual([JSON.stringify({ refresh_token: "refresh-1" })]);
  });

  test("forgets the session even when LogBrew is out of reach", async () => {
    const target = fake(() => {
      throw new TypeError("fetch failed");
    });
    await signedIn(target, start + hour);
    expect(await signOut(target.platform)).toBe(false);
    expect(await loadSession(target.platform)).toBeUndefined();
  });
});
