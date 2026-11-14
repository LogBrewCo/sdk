import { isFields, text } from "./api";
import { saveSession, sessionFrom } from "./session";
import type { Platform } from "./session";
import type { Reply } from "./api";

type Authorization = Readonly<{
  deviceCode: string;
  expiresAt: number;
  interval: number;
  link: string;
  userCode: string;
}>;

type SignIn =
  | Readonly<{ authorization: Authorization; kind: "waiting" }>
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "signedIn" }>
  | Readonly<{ kind: "starting" }>
  | Readonly<{ kind: "stopped"; reason: Stop }>;

type Stop = "denied" | "expired" | "invalid" | "offline";

type Poll = "approved" | "pending" | "slowDown" | "unreachable" | Stop;

const client = { id: "logbrew-raycast", name: "LogBrew for Raycast" } as const;
const grantType = "urn:ietf:params:oauth:grant-type:device_code";
const limits = {
  defaultInterval: 5,
  failedPolls: 5,
  intervalSeconds: 60,
  linkLength: 2048,
  slowDown: 5000,
  userCode: /^[A-Z0-9-]{4,16}$/u,
} as const;
const millisecondsPerSecond = 1000;
const none = 0;
const step = 1;
const ok = 200;
const tooManyRequests = 429;
const serverError = 500;
const pollOutcomes: Readonly<Record<string, Poll>> = {
  access_denied: "denied",
  authorization_pending: "pending",
  expired_token: "expired",
  slow_down: "slowDown",
};

function form(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString();
}

function safeLink(value: string): boolean {
  if (value.length > limits.linkLength) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

type Offer = Readonly<{ deviceCode: string; expiresIn: unknown; interval: unknown; link: string; userCode: string }>;

function offerOf(body: Readonly<Record<string, unknown>>): Offer {
  const complete = text(body, "verification_uri_complete");
  return {
    deviceCode: text(body, "device_code"),
    expiresIn: body["expires_in"],
    interval: body["interval"] ?? limits.defaultInterval,
    link: complete === "" ? text(body, "verification_uri") : complete,
    userCode: text(body, "user_code"),
  };
}

function validInterval(interval: unknown): interval is number {
  return typeof interval === "number" && interval > none && interval <= limits.intervalSeconds;
}

function readAuthorization(reply: Reply, now: number): Authorization | undefined {
  if (reply.status !== ok || !isFields(reply.body)) {
    return undefined;
  }
  const { deviceCode, expiresIn, interval, link, userCode } = offerOf(reply.body);
  if (typeof expiresIn !== "number" || expiresIn <= none || !validInterval(interval)) {
    return undefined;
  }
  if (deviceCode === "" || !limits.userCode.test(userCode) || !safeLink(link)) {
    return undefined;
  }
  return {
    deviceCode,
    expiresAt: now + expiresIn * millisecondsPerSecond,
    interval: interval * millisecondsPerSecond,
    link,
    userCode,
  };
}

async function startSignIn(platform: Platform): Promise<SignIn> {
  try {
    const reply = await platform.send({
      body: form({ client_id: client.id, client_name: client.name }),
      contentType: "application/x-www-form-urlencoded",
      method: "POST",
      url: `${platform.origin}/api/auth/device`,
    });
    const authorization = readAuthorization(reply, platform.now());
    return authorization === undefined
      ? { kind: "stopped", reason: "invalid" }
      : { authorization, kind: "waiting" };
  } catch {
    return { kind: "stopped", reason: "offline" };
  }
}

function classify(reply: Reply): Poll {
  if (reply.status === ok) {
    return "approved";
  }
  if (reply.status === tooManyRequests) {
    return "slowDown";
  }
  if (reply.status >= serverError) {
    return "unreachable";
  }
  const code = isFields(reply.body) ? text(reply.body, "error") : "";
  return pollOutcomes[code] ?? "invalid";
}

async function pollOnce(platform: Platform, authorization: Authorization): Promise<Readonly<{ poll: Poll; reply?: Reply }>> {
  try {
    const reply = await platform.send({
      body: form({ client_id: client.id, device_code: authorization.deviceCode, grant_type: grantType }),
      contentType: "application/x-www-form-urlencoded",
      method: "POST",
      url: `${platform.origin}/api/auth/device/token`,
    });
    return { poll: classify(reply), reply };
  } catch {
    return { poll: "unreachable" };
  }
}

type Wait = Readonly<{ authorization: Authorization; cancelled: () => boolean; failed: number; interval: number }>;

async function approve(platform: Platform, reply: Reply | undefined): Promise<SignIn> {
  const session = sessionFrom(reply?.body, platform.now());
  if (session === undefined) {
    return { kind: "stopped", reason: "invalid" };
  }
  await saveSession(platform, session);
  return { kind: "signedIn" };
}

type Turn = Readonly<{ kind: "again"; wait: Wait }> | SignIn;

function turnFor(wait: Wait, poll: Exclude<Poll, "approved">): Turn {
  switch (poll) {
    case "pending": {
      return { kind: "again", wait: { ...wait, failed: none } };
    }
    case "slowDown": {
      return { kind: "again", wait: { ...wait, failed: none, interval: wait.interval + limits.slowDown } };
    }
    case "unreachable": {
      const failed = wait.failed + step;
      return failed >= limits.failedPolls ? { kind: "stopped", reason: "offline" } : { kind: "again", wait: { ...wait, failed } };
    }
    case "denied":
    case "expired":
    case "invalid":
    case "offline": {
      return { kind: "stopped", reason: poll };
    }
    default: {
      return poll;
    }
  }
}

async function waitFrom(platform: Platform, wait: Wait): Promise<SignIn> {
  await platform.sleep(wait.interval);
  if (wait.cancelled()) {
    return { kind: "idle" };
  }
  if (platform.now() >= wait.authorization.expiresAt) {
    return { kind: "stopped", reason: "expired" };
  }
  const { poll, reply } = await pollOnce(platform, wait.authorization);
  if (poll === "approved") {
    return approve(platform, reply);
  }
  const turn = turnFor(wait, poll);
  return turn.kind === "again" ? waitFrom(platform, turn.wait) : turn;
}

async function waitForApproval(
  platform: Platform,
  authorization: Authorization,
  cancelled: () => boolean,
): Promise<SignIn> {
  return waitFrom(platform, { authorization, cancelled, failed: none, interval: authorization.interval });
}

export {
  type Authorization,
  type SignIn,
  type Stop,
  readAuthorization,
  startSignIn,
  waitForApproval,
};
