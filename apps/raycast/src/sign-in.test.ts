import type { Authorization, SignIn, Stop } from "./sign-in";
import { answer, fake, start } from "./fake";
import { describe, expect, test } from "bun:test";
import { startSignIn, waitForApproval } from "./sign-in";
import type { Fake } from "./fake";
import type { Reply } from "./api";
import { loadSession } from "./session";

const second = 1000;
const day = 86_400_000;
const lifetime = 900;
const failedPolls = 5;
const intervalSeconds = 5;
const slowDownStep = 5000;
const status = { badRequest: 400, unavailable: 503 } as const;
const none = 0;

const offer = {
  device_code: "device-1",
  expires_in: 600,
  interval: intervalSeconds,
  user_code: "ABCD-EFGH",
  verification_uri: "https://logbrew.co/device",
  verification_uri_complete: "https://logbrew.co/device?code=ABCD-EFGH",
};

const authorization: Authorization = {
  deviceCode: "device-1",
  expiresAt: start + day,
  interval: intervalSeconds * second,
  link: "https://logbrew.co/device",
  userCode: "ABCD-EFGH",
};

function polls(replies: readonly Reply[]): Fake {
  const queue = [...replies];
  return fake(() => queue.shift() ?? answer({ error: "authorization_pending" }, status.badRequest));
}

function stopped(reason: Stop): SignIn {
  return { kind: "stopped", reason };
}

function never(): boolean {
  return false;
}

function pending(error: string): Reply {
  return answer({ error }, status.badRequest);
}

async function accessOf(target: Fake): Promise<string | undefined> {
  const session = await loadSession(target.platform);
  return session?.accessToken;
}

describe("startSignIn", () => {
  test("asks LogBrew for a code and keeps the approval link", async () => {
    const target = fake(() => answer(offer));
    expect(await startSignIn(target.platform)).toEqual({
      authorization: {
        deviceCode: "device-1",
        expiresAt: start + offer.expires_in * second,
        interval: intervalSeconds * second,
        link: "https://logbrew.co/device?code=ABCD-EFGH",
        userCode: "ABCD-EFGH",
      },
      kind: "waiting",
    });
    expect(target.requests.map((request) => request.body)).toEqual([
      "client_id=logbrew-raycast&client_name=LogBrew+for+Raycast",
    ]);
  });

  test("stops on an answer it cannot use", async () => {
    const unusable = [
      answer({ ...offer, user_code: "<b>" }),
      answer({ ...offer, verification_uri_complete: "ftp://logbrew.co/device" }),
      answer({ ...offer, verification_uri_complete: "https://user:pw@logbrew.co/device" }),
      answer({ ...offer, interval: 0 }),
      answer({ ...offer, expires_in: "600" }),
      answer(offer, status.unavailable),
    ];
    const results = await Promise.all(unusable.map(async (reply) => startSignIn(fake(() => reply).platform)));
    for (const result of results) {
      expect(result).toEqual(stopped("invalid"));
    }
  });

  test("stops as offline when LogBrew is out of reach", async () => {
    const target = fake(() => {
      throw new TypeError("fetch failed");
    });
    expect(await startSignIn(target.platform)).toEqual(stopped("offline"));
  });
});

describe("waitForApproval", () => {
  test("waits while pending, slows down when asked, then saves the session", async () => {
    const target = polls([
      pending("authorization_pending"),
      pending("slow_down"),
      answer({ access_token: "access-1", expires_in: lifetime, refresh_token: "refresh-1" }),
    ]);
    expect(await waitForApproval(target.platform, authorization, never)).toEqual({ kind: "signedIn" });
    const { interval } = authorization;
    expect(target.sleeps).toEqual([interval, interval, interval + slowDownStep]);
    expect(await accessOf(target)).toBe("access-1");
    const [first] = target.requests;
    expect(first?.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
  });

  test("stops when the person denies the sign-in or the code expires", async () => {
    const denied = polls([pending("access_denied")]);
    expect(await waitForApproval(denied.platform, authorization, never)).toEqual(stopped("denied"));
    const expired = polls([pending("expired_token")]);
    expect(await waitForApproval(expired.platform, authorization, never)).toEqual(stopped("expired"));
    const late = polls([]);
    const soon = { ...authorization, expiresAt: start + second };
    expect(await waitForApproval(late.platform, soon, never)).toEqual(stopped("expired"));
  });

  test("stops on an approval without a session", async () => {
    const target = polls([answer({ access_token: "" })]);
    expect(await waitForApproval(target.platform, authorization, never)).toEqual(stopped("invalid"));
  });

  test("stops as offline after repeated server failures", async () => {
    const target = polls(Array.from({ length: failedPolls }, () => answer(undefined, status.unavailable)));
    expect(await waitForApproval(target.platform, authorization, never)).toEqual(stopped("offline"));
    expect(target.requests).toHaveLength(failedPolls);
  });

  test("stops quietly when the command closes", async () => {
    const target = polls([]);
    expect(await waitForApproval(target.platform, authorization, () => true)).toEqual({ kind: "idle" });
    expect(target.requests).toHaveLength(none);
  });
});
