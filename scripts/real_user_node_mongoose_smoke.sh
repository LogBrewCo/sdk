#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
node_package_version="$(node -p "require('${repo_root}/js/logbrew-node/package.json').version")"
mongoose_version="${LOGBREW_NODE_MONGOOSE_PACKAGE_VERSION:-9.7.4}"
tmp_dir="$(mktemp -d)"
export npm_config_cache="$tmp_dir/npm-cache"
trap 'rm -rf "$tmp_dir"' EXIT

package_tgz() {
  python3 - "$1" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
}

core_pack_json="$tmp_dir/core-pack.json"
node_pack_json="$tmp_dir/node-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-node" && npm pack --json --pack-destination "$tmp_dir") > "$node_pack_json"

core_tgz="$tmp_dir/$(package_tgz "$core_pack_json")"
node_tgz="$tmp_dir/$(package_tgz "$node_pack_json")"
test -f "$core_tgz"
test -f "$node_tgz"

app_dir="$tmp_dir/node-mongoose-smoke"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install \
  --save-exact \
  --no-audit \
  --fund=false \
  "$core_tgz" \
  "$node_tgz" \
  "mongoose@${mongoose_version}" \
  "typescript@5.9.3" \
  "@types/node@24.10.1" \
  >/dev/null

npm uninstall @logbrew/node >/dev/null
npm install --save-exact --no-audit --fund=false "$node_tgz" >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/node": "file:' package.json
grep -q "\"mongoose\": \"${mongoose_version}\"" package.json
npm ls @logbrew/sdk @logbrew/node mongoose typescript @types/node >/dev/null
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/node@${node_package_version}" "$tmp_dir/npm-list-depth0.txt"
grep -q "mongoose@${mongoose_version}" "$tmp_dir/npm-list-depth0.txt"
test -f node_modules/@logbrew/node/mongoose.js
test -f node_modules/@logbrew/node/mongoose.cjs
grep -q 'instrumentLogBrewMongooseModel' node_modules/@logbrew/node/README.md

cat > smoke.mjs <<'EOF'
import { createRequire } from "node:module";
import mongoose from "mongoose";
import {
  createLogBrewNodeClient,
  instrumentLogBrewMongooseModel
} from "@logbrew/node";

const require = createRequire(import.meta.url);
const mongoosePackageVersion = require("mongoose/package.json").version;
const operationTrace = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  sampled: true
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertMetadata(metadata, expected, message, preview) {
  for (const [key, value] of Object.entries(expected)) {
    assertEqual(metadata?.[key], value, `${message} ${key}; ${preview}`);
  }
}

function assertJsonEqual(actual, expected, message, preview) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)}; ${preview}`);
  }
}

function exceptionEvents(type) {
  return [{
    name: "exception",
    metadata: {
      exceptionEscaped: true,
      exceptionType: type
    }
  }];
}

mongoose.set("bufferCommands", false);

const schema = new mongoose.Schema(
  {
    email: String,
    name: String
  },
  {
    bufferCommands: false,
    collection: "profiles"
  }
);
const Profile = mongoose.model(`LogBrewMongooseSmoke${Date.now()}`, schema);
const originalFindOne = Profile.findOne;
const originalInsertMany = Profile.insertMany;
const originalUpdateOne = Profile.updateOne;

Profile.collection.findOne = async function logBrewMongooseSmokeFindOne(filter, options) {
  assert(this === Profile.collection, "Mongoose collection receiver was not preserved");
  assert(filter.email === "ada@example.com", "Mongoose query filter did not reach collection");
  assert(typeof options === "object", "Mongoose query options should be forwarded");
  return { _id: new mongoose.Types.ObjectId(), email: "ada@example.com", name: "Ada" };
};
Profile.collection.updateOne = async function logBrewMongooseSmokeUpdateOne(filter, update) {
  assert(this === Profile.collection, "Mongoose update receiver was not preserved");
  assert(filter.email === "fail@example.com", "Mongoose update filter did not reach collection");
  assert(update.$set.name === "Private Profile", "Mongoose update document did not reach collection");
  throw new TypeError("mongoose private profile update failed");
};
Profile.collection.insertMany = async function logBrewMongooseSmokeInsertMany(docs) {
  assert(this === Profile.collection, "Mongoose insert receiver was not preserved");
  assert(Array.isArray(docs) && docs.length === 1, "Mongoose insert documents did not reach collection");
  assert(docs[0].email === "direct@example.com", "Mongoose insert document content did not reach collection");
  return { acknowledged: true, insertedCount: docs.length, insertedIds: { 0: docs[0]._id } };
};

const spanIds = ["a7ad6b7169204301", "a7ad6b7169204302", "a7ad6b7169204303", "a7ad6b7169204304"];
let nowMs = 1000;
const client = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "node-mongoose-smoke",
  sdkVersion: "0.1.0"
});
const instrumentation = instrumentLogBrewMongooseModel(Profile, {
  client,
  databaseName: "checkout",
  metadata: {
    safeFeature: "mongoose-real-package",
    unsafeNested: { email: "ada@example.com" }
  },
  now: () => "2026-07-07T11:00:00Z",
  nowMs: () => {
    nowMs += 7;
    return nowMs;
  },
  spanIdFactory: () => spanIds.shift() ?? "a7ad6b7169204303",
  trace: operationTrace
});

assert(instrumentation.isInstalled(), "Mongoose instrumentation should install");
const profile = await Profile.findOne({ email: "ada@example.com" }).exec();
assert(profile.name === "Ada", "Mongoose findOne result changed");
const insertedProfiles = await Profile.insertMany([{ email: "direct@example.com", name: "Direct" }]);
assert(Array.isArray(insertedProfiles) && insertedProfiles.length === 1, "Mongoose insertMany result changed");
let updateErrorRethrown = false;
await Profile.updateOne(
  { email: "fail@example.com" },
  { $set: { name: "Private Profile" } }
).exec().catch((error) => {
  updateErrorRethrown = error instanceof TypeError;
});
assert(updateErrorRethrown, "Mongoose update error should be rethrown unchanged");

let duplicateRejected = false;
try {
  instrumentLogBrewMongooseModel(Profile, { client });
} catch (error) {
  duplicateRejected = error instanceof Error && error.message.includes("uninstrumented mongoose model");
}
assert(duplicateRejected, "Mongoose instrumentation should reject duplicate installs");

instrumentation.uninstall();
assert(!instrumentation.isInstalled(), "Mongoose instrumentation should uninstall");
assert(Profile.findOne === originalFindOne, "Mongoose findOne was not restored");
assert(Profile.insertMany === originalInsertMany, "Mongoose insertMany was not restored");
assert(Profile.updateOne === originalUpdateOne, "Mongoose updateOne was not restored");

const payload = JSON.parse(client.previewJson());
const findOneSpan = payload.events.find((event) => event.id === "evt_node_mongoose_findone_mongoose_query");
const insertManySpan = payload.events.find((event) => event.id === "evt_node_mongoose_insertmany_mongoose_model");
const updateErrorSpan = payload.events.find((event) => event.id === "evt_node_mongoose_updateone_error");
const preview = client.previewJson();
assert(findOneSpan?.type === "span", `missing Mongoose findOne span: ${preview}`);
assert(insertManySpan?.type === "span", `missing Mongoose insertMany span: ${preview}`);
assert(updateErrorSpan?.attributes?.status === "error", `missing Mongoose update error span: ${preview}`);
assertEqual(findOneSpan.attributes.traceId, operationTrace.traceId, "Mongoose trace id");
assertEqual(findOneSpan.attributes.parentSpanId, operationTrace.spanId, "Mongoose parent span id");
assertEqual(findOneSpan.attributes.spanId, "a7ad6b7169204301", "Mongoose span id");
assertMetadata(findOneSpan.attributes.metadata, {
  "db.collection.name": "profiles",
  "db.namespace": "checkout",
  "db.operation.name": "findOne",
  "db.system.name": "mongoose",
  dbCollection: "profiles",
  dbName: "checkout",
  dbOperation: "mongoose.query",
  dbOperationKind: "findOne",
  dbSystem: "mongoose",
  framework: "node:mongoose",
  mongooseModel: Profile.modelName,
  sampled: true,
  safeFeature: "mongoose-real-package"
}, "Mongoose findOne span metadata", preview);
assertMetadata(insertManySpan.attributes.metadata, {
  "db.operation.name": "insertMany",
  dbOperation: "mongoose.model",
  dbOperationKind: "insertMany",
  framework: "node:mongoose",
  resultCount: 1,
  safeFeature: "mongoose-real-package"
}, "Mongoose insertMany span metadata", preview);
assertEqual(updateErrorSpan.attributes.metadata.errorType, "TypeError", "Mongoose error type");
assertJsonEqual(updateErrorSpan.attributes.events, exceptionEvents("TypeError"), "Mongoose error span events", preview);

for (const forbidden of [
  "ada@example.com",
  "direct@example.com",
  "fail@example.com",
  "Private Profile",
  "$set",
  "mongoose private profile update failed",
  "unsafeNested",
  "connectionString",
  "mongodb://"
]) {
  if (preview.includes(forbidden)) {
    throw new Error(`Mongoose telemetry leaked forbidden detail ${forbidden}: ${preview}`);
  }
}

console.log(JSON.stringify({ ok: true, events: payload.events.length, mongoosePackageVersion }));
EOF

node smoke.mjs > "$tmp_dir/mongoose-smoke.json"
grep -q '"ok":true' "$tmp_dir/mongoose-smoke.json"
grep -q "\"mongoosePackageVersion\":\"${mongoose_version}\"" "$tmp_dir/mongoose-smoke.json"

cat > types-smoke.ts <<'EOF'
import mongoose from "mongoose";
import {
  createLogBrewNodeClient,
  instrumentLogBrewMongooseModel,
  type LogBrewMongooseModel,
  type LogBrewMongooseModelInstrumentation
} from "@logbrew/node";

const client = createLogBrewNodeClient({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  sdkName: "typed-mongoose-smoke",
  sdkVersion: "0.1.0"
});
const schema = new mongoose.Schema({ name: String }, { collection: "profiles" });
const Profile = mongoose.model("TypedProfile", schema) as unknown as LogBrewMongooseModel;
const instrumentation: LogBrewMongooseModelInstrumentation = instrumentLogBrewMongooseModel(Profile, {
  client,
  databaseName: "checkout",
  trace: {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    sampled: true
  }
});
instrumentation.uninstall();
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "target": "ES2022"
  },
  "include": ["types-smoke.ts"]
}
EOF
npx tsc --noEmit

node - <<'EOF'
const node = require("@logbrew/node");
if (typeof node.instrumentLogBrewMongooseModel !== "function") {
  throw new Error("missing CommonJS Mongoose instrumentation export");
}
EOF

echo "Node Mongoose installed-package smoke passed with mongoose@${mongoose_version}"
