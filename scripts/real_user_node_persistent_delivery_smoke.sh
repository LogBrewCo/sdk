#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_package_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
tmp_dir="$(mktemp -d)"
export npm_config_cache="$tmp_dir/npm-cache"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

core_pack_json="$tmp_dir/core-pack.json"
node_pack_json="$tmp_dir/node-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"

core_tgz="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[0].filename)' "$core_pack_json")"
node_tgz="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[0].filename)' "$node_pack_json")"
core_tgz="$tmp_dir/$core_tgz"
node_tgz="$tmp_dir/$node_tgz"
test -f "$core_tgz"
test -f "$node_tgz"

node_digest="$(shasum -a 256 "$node_tgz" | awk '{print $1}')"
test "${#node_digest}" -eq 64
node_archive_listing="$(tar -tzf "$node_tgz")"
node_types="$(tar -xOf "$node_tgz" package/index.d.ts)"
node_readme="$(tar -xOf "$node_tgz" package/README.md)"
grep -qx 'package/persistent-queue.cjs' <<< "$node_archive_listing"
grep -qx 'package/persistent-queue.js' <<< "$node_archive_listing"
grep -Fq 'persistentQueuePath?: string;' <<< "$node_types"
grep -Fq 'purgeLogBrewNodePersistentQueue' <<< "$node_types"
grep -Fq 'It never falls back to memory.' <<< "$node_readme"

app_dir="$tmp_dir/node-persistent-delivery-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install \
  --save-exact \
  --ignore-scripts \
  --no-audit \
  --fund=false \
  "$core_tgz" \
  "$node_tgz" \
  "@types/node@24.10.1" \
  "typescript@6.0.3" \
  >/dev/null

npm ls @logbrew/sdk @logbrew/node @types/node typescript >/dev/null
installed_sdk_version="$(node -p 'require("./node_modules/@logbrew/sdk/package.json").version')"
installed_node_version="$(node -p 'require("./node_modules/@logbrew/node/package.json").version')"
test "$installed_sdk_version" = "$sdk_package_version"
test "$installed_node_version" = "$node_package_version"

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "strict": true,
    "target": "ES2022",
    "types": ["node"]
  },
  "include": ["types-smoke.ts"]
}
EOF

cat > types-smoke.ts <<'EOF'
import {
  createLogBrewNodeClient,
  purgeLogBrewNodePersistentQueue,
  type CreateLogBrewNodeClientConfig
} from "@logbrew/node";

declare const queueParent: string;
const config: CreateLogBrewNodeClientConfig = {
  apiKey: "TYPE_KEY",
  persistentQueuePath: queueParent
};
const client = createLogBrewNodeClient(config);
const purged: boolean = purgeLogBrewNodePersistentQueue({ persistentQueuePath: queueParent });
void client;
void purged;
EOF

./node_modules/.bin/tsc --project tsconfig.json

queue_parent="$tmp_dir/queue-parent"
mkdir -m 700 "$queue_parent"
queue_parent="$(realpath "$queue_parent")"

cat > crash.mjs <<'EOF'
import { createLogBrewNodeClient } from "@logbrew/node";

const client = createLogBrewNodeClient({
  apiKey: "CRASH_PROCESS_KEY",
  maxBatchEvents: 2,
  maxRetries: 1,
  persistentQueuePath: process.argv[2]
});

for (const id of ["restart-first", "restart-second", "restart-third"]) {
  client.log(id, "2026-07-21T10:00:00Z", {
    level: "info",
    message: "retained before restart"
  });
}

process.exit(0);
EOF

cat > replay.mjs <<'EOF'
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  createLogBrewNodeClient,
  createNodeFetchTransport,
  purgeLogBrewNodePersistentQueue
} from "@logbrew/node";

const queueParent = process.argv[2];
const requests = [];
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    requests.push({
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString("utf8"),
      contentType: request.headers["content-type"],
      url: request.url
    });
    response.statusCode = requests.length === 1 ? 503 : 202;
    response.end();
  });
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const endpoint = `http://127.0.0.1:${server.address().port}/intake-marker?attempt=bounded`;

let client;
const deadline = Date.now() + 5_000;
while (client === undefined && Date.now() < deadline) {
  try {
    client = createLogBrewNodeClient({
      apiKey: "REPLAY_PROCESS_KEY",
      maxBatchEvents: 2,
      maxRetries: 1,
      persistentQueuePath: queueParent
    });
  } catch (error) {
    if (error?.code !== "persistent_queue_in_use") {
      throw new Error("persistent replay could not acquire storage");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}
assert.ok(client, "persistent replay must acquire storage within the bounded lease deadline");
assert.equal(client.pendingEvents(), 3);

const storedText = readFiles(join(queueParent, "logbrew-node-queue-v1")).join("\n");
assert.doesNotMatch(storedText, /REPLAY_PROCESS_KEY|CRASH_PROCESS_KEY|intake-marker|authorization/);
assert.equal(storedText.includes(queueParent), false);

client.log("restart-later", "2026-07-21T10:00:01Z", {
  level: "info",
  message: "captured after restart"
});
const response = await client.shutdown(createNodeFetchTransport({ endpoint }));

assert.deepEqual(response, { statusCode: 202, attempts: 3, batches: 2 });
assert.equal(requests.length, 3);
assert.equal(requests[0].body, requests[1].body);
assert.deepEqual(
  [requests[1], requests[2]].flatMap((request) => JSON.parse(request.body).events.map((event) => event.id)),
  ["restart-first", "restart-second", "restart-third", "restart-later"]
);
for (const request of requests) {
  assert.equal(request.authorization, "Bearer REPLAY_PROCESS_KEY");
  assert.equal(request.contentType, "application/json");
  assert.equal(request.url, "/intake-marker?attempt=bounded");
}

const reopened = createLogBrewNodeClient({
  apiKey: "REOPEN_KEY",
  persistentQueuePath: queueParent
});
assert.equal(reopened.pendingEvents(), 0);
assert.deepEqual(await reopened.shutdown({ send: async () => {
  throw new Error("empty queue must not send");
} }), { statusCode: 204, attempts: 0, batches: 0 });
assert.equal(purgeLogBrewNodePersistentQueue({ persistentQueuePath: queueParent }), true);
assert.deepEqual(readdirSync(queueParent), []);

server.close();
await once(server, "close");
console.log(JSON.stringify({ acceptedEvents: 4, batches: 2, requests: 3 }));

function readFiles(root) {
  const values = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      values.push(...readFiles(path));
    } else if (stat.isFile()) {
      values.push(readFileSync(path, "utf8"));
    }
  }
  return values;
}
EOF

node crash.mjs "$queue_parent" > "$tmp_dir/crash.stdout" 2> "$tmp_dir/crash.stderr"
test ! -s "$tmp_dir/crash.stdout"
test ! -s "$tmp_dir/crash.stderr"
sleep 31

replay_output="$(node replay.mjs "$queue_parent")"
test "$replay_output" = '{"acceptedEvents":4,"batches":2,"requests":3}'

printf 'node persistent delivery installed smoke ok (sdk %s, node %s, sha256 %s, requests 3, accepted 4)\n' \
  "$installed_sdk_version" \
  "$installed_node_version" \
  "$node_digest"
