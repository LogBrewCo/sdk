import type { Outcome, Reply } from "./api";
import { failureFor, isFields, text } from "./api";

type Request = Readonly<{
  body?: string;
  contentType?: "application/json" | "application/x-www-form-urlencoded";
  method: "GET" | "POST";
  token?: string;
  url: string;
}>;

type Session = Readonly<{ accessToken: string; expiresAt: number; refreshToken: string }>;

type Client = Readonly<{ id: string; name: string }>;

type Platform = Readonly<{
  client: Client;
  now: () => number;
  origin: string;
  read: (key: string) => Promise<string | undefined>;
  remove: (key: string) => Promise<void>;
  send: (request: Request) => Promise<Reply>;
  sleep: (milliseconds: number) => Promise<void>;
  write: (key: string, value: string) => Promise<void>;
}>;

type Lock = Readonly<{ owner: string; until: number }>;

const keys = { lock: "refresh-lock", session: "session" } as const;
const timing = { accessLifetime: 840_000, early: 30_000, lockLifetime: 10_000, lockRetry: 150, lockSettle: 40 };
const lock = { attempts: 60, first: 0, step: 1 } as const;
const millisecondsPerSecond = 1000;
const unauthorized = 401;
const ok = 200;

function parseJson(value: string | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function loadSession(platform: Platform): Promise<Session | undefined> {
  const stored = parseJson(await platform.read(keys.session));
  if (!isFields(stored) || typeof stored["expiresAt"] !== "number") {
    return undefined;
  }
  const session = {
    accessToken: text(stored, "accessToken"),
    expiresAt: stored["expiresAt"],
    refreshToken: text(stored, "refreshToken"),
  };
  return session.accessToken === "" || session.refreshToken === "" ? undefined : session;
}

function sessionFrom(body: unknown, now: number): Session | undefined {
  if (!isFields(body)) {
    return undefined;
  }
  const expiresIn = body["expires_in"];
  const lifetime = typeof expiresIn === "number" ? expiresIn * millisecondsPerSecond : timing.accessLifetime;
  const session = {
    accessToken: text(body, "access_token"),
    expiresAt: now + lifetime,
    refreshToken: text(body, "refresh_token"),
  };
  return session.accessToken === "" || session.refreshToken === "" ? undefined : session;
}

async function saveSession(platform: Platform, session: Session): Promise<void> {
  await platform.write(keys.session, JSON.stringify(session));
}

async function forget(platform: Platform): Promise<void> {
  await platform.remove(keys.session);
}

async function revoke(platform: Platform, session: Session): Promise<boolean> {
  try {
    const reply = await platform.send({
      body: JSON.stringify({ refresh_token: session.refreshToken }),
      contentType: "application/json",
      method: "POST",
      url: `${platform.origin}/api/auth/logout`,
    });
    return reply.status === ok;
  } catch {
    return false;
  }
}

async function signOut(platform: Platform): Promise<boolean> {
  const session = await loadSession(platform);
  await forget(platform);
  return session === undefined ? true : revoke(platform, session);
}

async function readLock(platform: Platform): Promise<Lock | undefined> {
  const stored = parseJson(await platform.read(keys.lock));
  if (!isFields(stored) || typeof stored["until"] !== "number") {
    return undefined;
  }
  return { owner: text(stored, "owner"), until: stored["until"] };
}

async function claimLock(platform: Platform, owner: string): Promise<boolean> {
  const held = await readLock(platform);
  if (held !== undefined && held.until > platform.now()) {
    return false;
  }
  await platform.write(keys.lock, JSON.stringify({ owner, until: platform.now() + timing.lockLifetime }));
  await platform.sleep(timing.lockSettle);
  const current = await readLock(platform);
  return current?.owner === owner;
}

async function acquireLock(platform: Platform, owner: string, attempt: number): Promise<boolean> {
  if (attempt >= lock.attempts) {
    return false;
  }
  if (await claimLock(platform, owner)) {
    return true;
  }
  await platform.sleep(timing.lockRetry);
  return acquireLock(platform, owner, attempt + lock.step);
}

async function releaseLock(platform: Platform, owner: string): Promise<void> {
  const held = await readLock(platform);
  if (held?.owner === owner) {
    await platform.remove(keys.lock);
  }
}

async function accept(platform: Platform, body: unknown): Promise<Outcome<Session>> {
  const session = sessionFrom(body, platform.now());
  if (session === undefined) {
    return { failure: "invalid", kind: "failed" };
  }
  await saveSession(platform, session);
  return { kind: "ok", value: session };
}

async function exchange(platform: Platform, stale: Session): Promise<Outcome<Session>> {
  const reply = await platform.send({
    body: JSON.stringify({ refresh_token: stale.refreshToken }),
    contentType: "application/json",
    method: "POST",
    url: `${platform.origin}/api/auth/refresh`,
  });
  if (reply.status === ok) {
    return accept(platform, reply.body);
  }
  if (reply.status === unauthorized) {
    await forget(platform);
    return { kind: "signedOut" };
  }
  return { failure: failureFor(reply.status), kind: "failed" };
}

async function refreshHeld(platform: Platform, stale: Session): Promise<Outcome<Session>> {
  const current = await loadSession(platform);
  if (current === undefined) {
    return { kind: "signedOut" };
  }
  if (current.refreshToken !== stale.refreshToken) {
    return { kind: "ok", value: current };
  }
  return exchange(platform, current);
}

async function refreshSession(platform: Platform, stale: Session): Promise<Outcome<Session>> {
  const owner = `${platform.now()}-${Math.random()}`;
  if (!(await acquireLock(platform, owner, lock.first))) {
    return { failure: "unavailable", kind: "failed" };
  }
  try {
    return await refreshHeld(platform, stale);
  } catch {
    return { failure: "offline", kind: "failed" };
  } finally {
    await releaseLock(platform, owner);
  }
}

async function freshSession(platform: Platform): Promise<Outcome<Session>> {
  const session = await loadSession(platform);
  if (session === undefined) {
    return { kind: "signedOut" };
  }
  if (session.expiresAt - timing.early > platform.now()) {
    return { kind: "ok", value: session };
  }
  return refreshSession(platform, session);
}

async function sendAuthorized(platform: Platform, url: string, session: Session): Promise<Outcome<Reply>> {
  try {
    const reply = await platform.send({ method: "GET", token: session.accessToken, url });
    return { kind: "ok", value: reply };
  } catch {
    return { failure: "offline", kind: "failed" };
  }
}

async function retryRenewed(platform: Platform, url: string, stale: Session): Promise<Outcome<Reply>> {
  const renewed = await refreshSession(platform, stale);
  if (renewed.kind !== "ok") {
    return renewed;
  }
  const second = await sendAuthorized(platform, url, renewed.value);
  if (second.kind === "ok" && second.value.status === unauthorized) {
    await signOut(platform);
    return { kind: "signedOut" };
  }
  return second;
}

async function getAuthorized(platform: Platform, path: string): Promise<Outcome<Reply>> {
  const session = await freshSession(platform);
  if (session.kind !== "ok") {
    return session;
  }
  const url = `${platform.origin}${path}`;
  const first = await sendAuthorized(platform, url, session.value);
  if (first.kind !== "ok" || first.value.status !== unauthorized) {
    return first;
  }
  return retryRenewed(platform, url, session.value);
}

export {
  type Client,
  type Platform,
  type Request,
  type Session,
  getAuthorized,
  loadSession,
  refreshSession,
  saveSession,
  sessionFrom,
  signOut,
};
