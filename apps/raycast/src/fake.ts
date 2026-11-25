import type { Platform, Request } from "./session";
import type { Reply } from "./api";
import { saveSession } from "./session";

type Handler = (request: Request) => Reply;

type Fake = Readonly<{
  platform: Platform;
  requests: readonly Request[];
  sleeps: readonly number[];
}>;

const origin = "https://api.example.com";
const start = Date.parse("2026-11-15T12:00:00Z");
const ok = 200;

function answer(body: unknown, code: number = ok): Reply {
  return { body, status: code };
}

function fake(handler: Handler): Fake {
  const store = new Map<string, string>();
  const requests: Request[] = [];
  const sleeps: number[] = [];
  const clock = { now: start };
  const platform: Platform = {
    client: { id: "logbrew-raycast", name: "LogBrew for Raycast" },
    now: () => clock.now,
    origin,
    read: async (key) => {
      await Promise.resolve();
      return store.get(key);
    },
    remove: async (key) => {
      await Promise.resolve();
      store.delete(key);
    },
    send: async (request) => {
      await Promise.resolve();
      requests.push(request);
      return handler(request);
    },
    sleep: async (milliseconds) => {
      await Promise.resolve();
      sleeps.push(milliseconds);
      clock.now += milliseconds;
    },
    write: async (key, value) => {
      await Promise.resolve();
      store.set(key, value);
    },
  };
  return { platform, requests, sleeps };
}

function pathOf(request: Request): string {
  return request.url.slice(origin.length);
}

async function signedIn(target: Fake, expiresAt: number): Promise<void> {
  await saveSession(target.platform, { accessToken: "access-1", expiresAt, refreshToken: "refresh-1" });
}

export { type Fake, type Handler, answer, fake, origin, pathOf, signedIn, start };
