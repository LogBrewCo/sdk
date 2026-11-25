import type { Reply } from "./api";
import type { Request } from "./session";

const requestTimeout = 15_000;

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

export { send, sleep };
